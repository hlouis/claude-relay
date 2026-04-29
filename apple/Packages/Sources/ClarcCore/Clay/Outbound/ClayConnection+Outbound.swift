import Foundation

// Convenience send-methods on `ClayConnection`, one per Tier 1
// client → server message. Each is a thin wrapper around the
// matching `ClayOutbound` factory plus `send(_:)`.
//
// All methods are `async throws` and propagate
// `ClayConnectionError.notConnected` and any URLSession transport
// errors raised by `send(_:)`.

extension ClayConnection {

    // MARK: - User input

    public func sendMessage(
        text: String? = nil,
        images: [ClayImageAttachment]? = nil,
        pastes: [String]? = nil,
        clientMsgId: String? = nil
    ) async throws {
        try await send(ClayOutbound.message(
            text: text,
            images: images,
            pastes: pastes,
            clientMsgId: clientMsgId
        ))
    }

    // MARK: - Session lifecycle

    public func newSession(
        visibility: ClaySessionVisibility? = nil
    ) async throws {
        try await send(ClayOutbound.newSession(visibility: visibility))
    }

    public func switchSession(
        id: Int,
        lastSeq: Int? = nil
    ) async throws {
        try await send(ClayOutbound.switchSession(id: id, lastSeq: lastSeq))
    }

    public func deleteSession(id: Int) async throws {
        try await send(ClayOutbound.deleteSession(id: id))
    }

    public func renameSession(id: Int, title: String) async throws {
        try await send(ClayOutbound.renameSession(id: id, title: title))
    }

    // MARK: - Generation control

    public func sendStop() async throws {
        try await send(ClayOutbound.stop)
    }

    // MARK: - Permissions

    public func sendPermissionResponse(
        requestId: String,
        decision: ClayPermissionDecision,
        updatedInput: ClayToolInput? = nil,
        planContent: String? = nil
    ) async throws {
        try await send(ClayOutbound.permissionResponse(
            requestId: requestId,
            decision: decision,
            updatedInput: updatedInput,
            planContent: planContent
        ))
    }

    // MARK: - History

    public func loadMoreHistory(before: Int? = nil) async throws {
        try await send(ClayOutbound.loadMoreHistory(before: before))
    }

    // MARK: - Presence

    public func sendTabVisible() async throws {
        try await send(ClayOutbound.tabVisible)
    }

    // MARK: - Configuration

    public func setModel(_ model: String) async throws {
        try await send(ClayOutbound.setModel(model))
    }

    public func setPermissionMode(_ mode: ClayPermissionMode) async throws {
        try await send(ClayOutbound.setPermissionMode(mode))
    }

    public func setEffort(_ effort: ClayEffort) async throws {
        try await send(ClayOutbound.setEffort(effort))
    }
}
