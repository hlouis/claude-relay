import Foundation

// Typed factories for every Tier 1 client → server message.
//
// One `static` constructor per `ClayClientMessage` case. Pure data —
// no networking, no actor isolation, no side effects — so the
// outbound mapping can be exercised in unit tests without spinning up
// a connection. Tests load `protocol/fixtures/c2s/*.json` and assert
// that the natural call-site for each fixture produces an equivalent
// `ClayClientMessage`.
//
// `ClayConnection` exposes `send(_:)` for the raw enum and `sendXxx(...)`
// convenience methods (in `ClayConnection+Outbound.swift`) that wrap
// these factories.

public enum ClayOutbound {

    // MARK: - User input

    public static func message(
        text: String? = nil,
        images: [ClayImageAttachment]? = nil,
        pastes: [String]? = nil,
        clientMsgId: String? = nil
    ) -> ClayClientMessage {
        .message(.init(
            text: text,
            images: images,
            pastes: pastes,
            clientMsgId: clientMsgId
        ))
    }

    // MARK: - Session lifecycle

    public static func newSession(
        visibility: ClaySessionVisibility? = nil
    ) -> ClayClientMessage {
        .newSession(.init(sessionVisibility: visibility))
    }

    public static func switchSession(
        id: Int,
        lastSeq: Int? = nil
    ) -> ClayClientMessage {
        .switchSession(.init(id: id, lastSeq: lastSeq))
    }

    public static func deleteSession(id: Int) -> ClayClientMessage {
        .deleteSession(.init(id: id))
    }

    public static func renameSession(
        id: Int,
        title: String
    ) -> ClayClientMessage {
        .renameSession(.init(id: id, title: title))
    }

    // MARK: - Generation control

    public static let stop: ClayClientMessage = .stop

    // MARK: - Permissions

    public static func permissionResponse(
        requestId: String,
        decision: ClayPermissionDecision,
        updatedInput: ClayToolInput? = nil,
        planContent: String? = nil
    ) -> ClayClientMessage {
        .permissionResponse(.init(
            requestId: requestId,
            decision: decision,
            updatedInput: updatedInput,
            planContent: planContent
        ))
    }

    // MARK: - History

    public static func loadMoreHistory(
        before: Int? = nil
    ) -> ClayClientMessage {
        .loadMoreHistory(.init(before: before))
    }

    // MARK: - Presence

    public static let tabVisible: ClayClientMessage = .tabVisible

    // MARK: - Configuration

    public static func setModel(_ model: String) -> ClayClientMessage {
        .setModel(.init(model: model))
    }

    public static func setPermissionMode(
        _ mode: ClayPermissionMode
    ) -> ClayClientMessage {
        .setPermissionMode(.init(mode: mode))
    }

    public static func setEffort(_ effort: ClayEffort) -> ClayClientMessage {
        .setEffort(.init(effort: effort))
    }
}
