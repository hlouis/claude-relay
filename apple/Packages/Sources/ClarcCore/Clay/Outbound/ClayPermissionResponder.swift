import Foundation

// Abstraction over "something that can send a permission_response
// to the daemon". The production conformer is `ClayConnection` (via
// the existing M3 helper); tests use a recording mock so the
// permission UI can be exercised without standing up a WebSocket.
//
// Kept narrow on purpose — adding more methods would tempt callers
// to use this protocol for general outbound traffic. For anything
// other than permission responses, take a `ClayConnection` directly.

public protocol ClayPermissionResponder: AnyObject, Sendable {
    func sendPermissionResponse(
        requestId: String,
        decision: ClayPermissionDecision,
        updatedInput: ClayToolInput?,
        planContent: String?
    ) async throws
}

extension ClayConnection: ClayPermissionResponder {}

// MARK: - Plan-tool detection

extension ClayChatItem.PermissionItem {
    /// The single plan-mode tool the daemon emits a permission for.
    /// `EnterPlanMode` doesn't require permission; only `ExitPlanMode`
    /// does and is the trigger for the four-button plan UI.
    public static let planToolName = "ExitPlanMode"

    /// True when this permission request should surface the plan-mode
    /// button set (Clear Context / Auto-accept Edits / Manually
    /// Approve / Reject) instead of the generic three-button set.
    public var isPlanTool: Bool { toolName == Self.planToolName }
}
