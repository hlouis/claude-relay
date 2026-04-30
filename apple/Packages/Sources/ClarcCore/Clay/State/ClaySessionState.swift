import Foundation

// Per-session container. Owns the chat-item array plus session-scoped
// metadata (processing status, last usage/cost, lastSeq for resume).
//
// Design choices:
//
// - Pure value type. `ClayProjectState` stores it in
//   `[Int: ClaySessionState]` and writes the whole struct back on every
//   mutation. This guarantees `@Observable` notifies on each apply and
//   keeps ownership unambiguous (one writer, the project state).
//
// - All "needs a fresh id" mutators take `newId: String` from the caller
//   so the type stays Sendable and tests can use deterministic ids.
//
// - History mode (`historyLoading == .loading`) suppresses lastSeq
//   reporting via `recordSeq`. Replayed history events should not move
//   the resume cursor — only live events do.

public struct ClaySessionState: Equatable, Sendable {

    // MARK: - Identity

    public var sessionId: Int
    public var cliSessionId: String?
    public var title: String

    // MARK: - Stream

    public var messages: [ClayChatItem] = []
    public var processingStatus: ClayProcessingStatus = .idle

    /// All permission requests we've seen, keyed by `requestId`. Mirrors
    /// the entries embedded as `.permission` items in `messages` so the
    /// UI layer can either drive the modal off this dictionary or render
    /// them inline.
    public var pendingPermissions: [String: ClayChatItem.PermissionItem] = [:]

    // MARK: - Resume / usage

    /// Next-expected seq (i.e. last received seq + 1). `nil` means the
    /// session has never received a seq-bearing event.
    public var lastSeq: Int?

    public var lastUsage: ClayUsage?
    public var lastModelUsage: ClayModelUsage?
    public var lastCost: Double?
    public var lastStreamInputTokens: Int?

    // MARK: - History replay

    public enum HistoryLoading: Equatable, Sendable {
        case idle
        case loading(total: Int, from: Int, resumed: Bool)
        case done
    }

    public var historyLoading: HistoryLoading = .idle

    public init(
        sessionId: Int,
        cliSessionId: String? = nil,
        title: String = ""
    ) {
        self.sessionId = sessionId
        self.cliSessionId = cliSessionId
        self.title = title
    }

    // MARK: - Mutators

    public mutating func setProcessingStatus(_ s: ClayProcessingStatus) {
        processingStatus = s
    }

    public mutating func appendUserMessage(_ m: ClayServerMessage.UserMessage, newId: String) {
        let item = ClayChatItem.UserItem(
            id: newId,
            text: m.text,
            clientMsgId: m.clientMsgId,
            imageCount: m.imageCount,
            pastes: m.pastes,
            planContent: m.planContent
        )
        messages.append(.user(item))
    }

    /// Append assistant text. If the trailing item is already
    /// `.assistantText`, the text is appended in-place (delta coalesce).
    /// Otherwise a fresh `.assistantText` is created with `newId`.
    public mutating func appendDelta(_ text: String, newId: String) {
        if case .assistantText(var item) = messages.last {
            item.text += text
            messages[messages.count - 1] = .assistantText(item)
        } else {
            messages.append(.assistantText(.init(id: newId, text: text)))
        }
    }

    /// Open a fresh thinking block. `thinking_start` always begins a new
    /// item even if the previous one was thinking — multiple independent
    /// thoughts within one assistant turn must not collapse.
    public mutating func startThinking(newId: String) {
        messages.append(.thinking(.init(id: newId, text: "")))
    }

    public mutating func appendThinkingDelta(_ text: String, newId: String) {
        if case .thinking(var item) = messages.last {
            item.text += text
            messages[messages.count - 1] = .thinking(item)
        } else {
            // Defensive: thinking_delta without a preceding thinking_start.
            // Open one implicitly.
            messages.append(.thinking(.init(id: newId, text: text)))
        }
    }

    public mutating func stopThinking(durationMs: Int) {
        // Find the most recent thinking item and stamp its duration.
        for idx in messages.indices.reversed() {
            if case .thinking(var item) = messages[idx] {
                item.durationMs = durationMs
                messages[idx] = .thinking(item)
                return
            }
        }
    }

    public mutating func startTool(id: String, name: String) {
        messages.append(.tool(.init(id: id, name: name)))
    }

    public mutating func setToolInput(id: String, input: ClayToolInput) {
        for idx in messages.indices.reversed() {
            if case .tool(var item) = messages[idx], item.id == id {
                item.input = input
                messages[idx] = .tool(item)
                return
            }
        }
    }

    public mutating func setToolResult(
        id: String,
        content: String,
        isError: Bool,
        images: [ClayToolResultImage]?
    ) {
        for idx in messages.indices.reversed() {
            if case .tool(var item) = messages[idx], item.id == id {
                item.result = .init(content: content, isError: isError, images: images)
                messages[idx] = .tool(item)
                return
            }
        }
    }

    public mutating func appendResult(_ r: ClayServerMessage.Result, newId: String) {
        messages.append(.result(.init(
            id: newId,
            cost: r.cost,
            duration: r.duration,
            usage: r.usage,
            modelUsage: r.modelUsage,
            sessionId: r.sessionId
        )))
        if let usage = r.usage { lastUsage = usage }
        if let mu = r.modelUsage { lastModelUsage = mu }
        if let cost = r.cost { lastCost = cost }
        if let t = r.lastStreamInputTokens { lastStreamInputTokens = t }
    }

    public mutating func appendPermissionRequest(_ r: ClayServerMessage.PermissionRequest) {
        let item = ClayChatItem.PermissionItem(
            id: r.requestId,
            toolName: r.toolName,
            toolInput: r.toolInput,
            toolUseId: r.toolUseId,
            decisionReason: r.decisionReason,
            status: .pending
        )
        pendingPermissions[r.requestId] = item
        messages.append(.permission(item))
    }

    public mutating func appendPermissionRequestPending(_ r: ClayServerMessage.PermissionRequestPending) {
        // Resume case: the daemon re-sends an outstanding request with
        // no `seq`. Don't duplicate if we already have it.
        if pendingPermissions[r.requestId] != nil { return }
        let item = ClayChatItem.PermissionItem(
            id: r.requestId,
            toolName: r.toolName,
            toolInput: r.toolInput,
            toolUseId: r.toolUseId,
            decisionReason: r.decisionReason,
            status: .pending
        )
        pendingPermissions[r.requestId] = item
        messages.append(.permission(item))
    }

    public mutating func resolvePermission(requestId: String, decision: ClayPermissionDecision) {
        pendingPermissions.removeValue(forKey: requestId)
        for idx in messages.indices.reversed() {
            if case .permission(var item) = messages[idx], item.id == requestId {
                item.status = .resolved(decision)
                messages[idx] = .permission(item)
                return
            }
        }
    }

    public mutating func cancelPermission(requestId: String) {
        pendingPermissions.removeValue(forKey: requestId)
        for idx in messages.indices.reversed() {
            if case .permission(var item) = messages[idx], item.id == requestId {
                item.status = .cancelled
                messages[idx] = .permission(item)
                return
            }
        }
    }

    public mutating func appendSystemError(
        _ text: String,
        kind: ClayChatItem.SystemErrorItem.Kind,
        newId: String
    ) {
        messages.append(.systemError(.init(id: newId, text: text, kind: kind)))
    }

    // MARK: - History boundary

    public mutating func beginHistory(_ meta: ClayServerMessage.HistoryMeta) {
        historyLoading = .loading(total: meta.total, from: meta.from, resumed: meta.resumed ?? false)
    }

    public mutating func endHistory(_ done: ClayServerMessage.HistoryDone) {
        historyLoading = .done
        if let usage = done.lastUsage { lastUsage = usage }
        if let mu = done.lastModelUsage { lastModelUsage = mu }
        if let cost = done.lastCost { lastCost = cost }
        if let t = done.lastStreamInputTokens { lastStreamInputTokens = t }
    }

    // MARK: - Resume cursor

    /// Record a seq from a live event. Returns the new `lastSeq`
    /// (next-expected) the caller should report to `ClayConnection`,
    /// or `nil` if there's nothing to report (no seq on the event, or
    /// the session is currently replaying history).
    @discardableResult
    public mutating func recordSeq(_ seq: Int?) -> Int? {
        guard let seq else { return nil }
        if case .loading = historyLoading { return nil }
        let next = seq + 1
        lastSeq = next
        return next
    }
}
