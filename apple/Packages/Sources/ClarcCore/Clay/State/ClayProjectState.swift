import Foundation
import Observation

// Top-level @Observable state mirror for one project's WebSocket
// connection. Implements `ClayMessageReceiver` and applies every Tier 1
// `ClayServerMessage` to the right `ClaySessionState`.
//
// MainActor isolation: the dispatcher pumps off-actor and `await`s
// `receive(_:)`, which hops here. Don't introduce a separate model
// actor — the hop is cheap and the simpler ownership wins.
//
// Routing rule for stream events without an explicit session id:
// every `delta` / `tool_*` / `result` etc. routes to the active
// session. `session_switched` / `session_id` rebind which session is
// active and what its `cliSessionId` resume key is.

@MainActor
@Observable
public final class ClayProjectState: ClayMessageReceiver {

    // MARK: - Connection-level mirrors

    public var connection: ClayConnectionStatus = .idle
    public var info: ClayServerMessage.Info?
    public var modelInfo: ClayServerMessage.ModelInfo?
    public var configState: ClayServerMessage.ConfigState?

    // MARK: - Session registry

    public var sessions: [ClaySessionListEntry] = []
    public var sessionStates: [Int: ClaySessionState] = [:]
    public var activeSessionId: Int?

    // MARK: - Top-level transient signals

    public var lastToast: ClayServerMessage.Toast?
    public var rateLimit: ClayServerMessage.RateLimit?
    public var authRequired: ClayServerMessage.AuthRequired?

    // MARK: - Wiring

    /// Connection backref for `updateResume` notifications. Kept weak to
    /// avoid the obvious cycle (connection → dispatcher → receiver).
    public weak var connectionRef: ClayConnection?

    /// Generates ids for items the daemon doesn't tag (assistantText,
    /// thinking, user without message_uuid, etc.). Override for
    /// deterministic tests.
    public var idGenerator: () -> String = { UUID().uuidString }

    public init() {}

    // MARK: - ClayMessageReceiver

    public nonisolated func receive(_ message: ClayServerMessage) async {
        await self.apply(message)
    }

    /// Test hook: synchronous variant for replay tests that already run
    /// on the main actor.
    public func apply(_ message: ClayServerMessage) {
        // Resume cursor — bumped per-session, before the body so that
        // history events naturally suppress (their session is in
        // .loading state).
        let seqToReport = applyToActiveSession { state in
            state.recordSeq(extractSeq(message))
        }

        switch message {
        // MARK: Bootstrap
        case .info(let p):
            info = p
        case .modelInfo(let p):
            modelInfo = p
        case .configState(let p):
            configState = p

        // MARK: Sessions
        case .sessionList(let p):
            sessions = p.sessions
            // Seed states for any new session ids; mark the daemon's
            // active row as active here too.
            for entry in p.sessions where sessionStates[entry.id] == nil {
                sessionStates[entry.id] = ClaySessionState(
                    sessionId: entry.id,
                    cliSessionId: entry.cliSessionId,
                    title: entry.title
                )
            }
            if let active = p.sessions.first(where: { $0.active }) {
                activeSessionId = active.id
            }
        case .sessionSwitched(let p):
            activeSessionId = p.id
            mutateSession(id: p.id) { state in
                state.cliSessionId = p.cliSessionId
            }
        case .sessionId(let p):
            mutateActive { state in
                state.cliSessionId = p.cliSessionId
            }

        // MARK: History boundary
        case .historyMeta(let p):
            mutateActive { $0.beginHistory(p) }
        case .historyDone(let p):
            mutateActive { $0.endHistory(p) }

        // MARK: User-side
        case .userMessage(let p):
            let id = idGenerator()
            mutateActive { $0.appendUserMessage(p, newId: id) }
        case .messageUuid:
            // We don't currently bind message_uuid to a specific item —
            // the only thing it carries that we care about (seq) is
            // already handled above.
            break

        // MARK: Streaming output
        case .status(let p):
            mutateActive { $0.setProcessingStatus(p.status) }
        case .delta(let p):
            let id = idGenerator()
            mutateActive { $0.appendDelta(p.text, newId: id) }
        case .thinkingStart:
            let id = idGenerator()
            mutateActive { $0.startThinking(newId: id) }
        case .thinkingDelta(let p):
            let id = idGenerator()
            mutateActive { $0.appendThinkingDelta(p.text, newId: id) }
        case .thinkingStop(let p):
            mutateActive { $0.stopThinking(durationMs: Int(p.duration)) }
        case .toolStart(let p):
            mutateActive { $0.startTool(id: p.id, name: p.name) }
        case .toolExecuting(let p):
            mutateActive { $0.setToolInput(id: p.id, input: p.input) }
        case .toolResult(let p):
            mutateActive {
                $0.setToolResult(
                    id: p.id,
                    content: p.content,
                    isError: p.isError,
                    images: p.images
                )
            }
        case .result(let p):
            let id = idGenerator()
            mutateActive { $0.appendResult(p, newId: id) }
        case .done:
            // `done` carries no payload we surface in messages; status
            // already flips to .idle via the trailing `status` event.
            break

        // MARK: Permissions
        case .permissionRequest(let p):
            mutateActive { $0.appendPermissionRequest(p) }
        case .permissionRequestPending(let p):
            mutateActive { $0.appendPermissionRequestPending(p) }
        case .permissionResolved(let p):
            mutateActive { $0.resolvePermission(requestId: p.requestId, decision: p.decision) }
        case .permissionCancel(let p):
            mutateActive { $0.cancelPermission(requestId: p.requestId) }

        // MARK: Top-level signals
        case .toast(let p):
            lastToast = p
        case .rateLimit(let p):
            rateLimit = p
        case .authRequired(let p):
            authRequired = p
        case .error(let p):
            let text = p.message ?? p.text ?? ""
            let id = idGenerator()
            mutateActive { $0.appendSystemError(text, kind: .error, newId: id) }
        case .contextOverflow(let p):
            let id = idGenerator()
            mutateActive { $0.appendSystemError(p.text, kind: .contextOverflow, newId: id) }
        }

        // Report resume cursor outside the session mutation. Skip if
        // history mode suppressed it (recordSeq returned nil).
        if let next = seqToReport, let cliSessionId = activeSessionState?.cliSessionId {
            let conn = connectionRef
            Task { await conn?.updateResume(sessionId: cliSessionId, lastSeq: next) }
        }
    }

    // MARK: - Helpers

    public var activeSessionState: ClaySessionState? {
        guard let id = activeSessionId else { return nil }
        return sessionStates[id]
    }

    private func mutateActive(_ body: (inout ClaySessionState) -> Void) {
        guard let id = activeSessionId else { return }
        mutateSession(id: id, body)
    }

    private func mutateSession(id: Int, _ body: (inout ClaySessionState) -> Void) {
        var state = sessionStates[id] ?? ClaySessionState(sessionId: id)
        body(&state)
        sessionStates[id] = state
    }

    private func applyToActiveSession<T>(_ body: (inout ClaySessionState) -> T) -> T? {
        guard let id = activeSessionId else { return nil }
        var state = sessionStates[id] ?? ClaySessionState(sessionId: id)
        let out = body(&state)
        sessionStates[id] = state
        return out
    }

    private func extractSeq(_ msg: ClayServerMessage) -> Int? {
        switch msg {
        case .delta(let p):                  return p.seq
        case .thinkingStart(let p):          return p.seq
        case .thinkingDelta(let p):          return p.seq
        case .thinkingStop(let p):           return p.seq
        case .toolStart(let p):              return p.seq
        case .toolExecuting(let p):          return p.seq
        case .toolResult(let p):             return p.seq
        case .result(let p):                 return p.seq
        case .done(let p):                   return p.seq
        case .userMessage(let p):            return p.seq
        case .messageUuid(let p):            return p.seq
        case .permissionRequest(let p):      return p.seq
        case .permissionResolved(let p):     return p.seq
        case .permissionCancel(let p):       return p.seq
        case .rateLimit(let p):              return p.seq
        case .authRequired(let p):           return p.seq
        case .contextOverflow(let p):        return p.seq
        case .info, .modelInfo, .configState,
             .sessionList, .sessionSwitched, .sessionId,
             .historyMeta, .historyDone,
             .status, .permissionRequestPending,
             .error, .toast:
            return nil
        }
    }
}
