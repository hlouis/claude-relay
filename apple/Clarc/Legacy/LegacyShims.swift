import SwiftUI

// Shim file holding declarations that the legacy CLI-subprocess
// code paths (AppState / MainView / ProjectWindowView) still
// reference. Phase 1 entry point (ClarcApp) does not use them, but
// the legacy types must still compile to keep `xcodebuild` green
// until M10 deletes the entire CLI subprocess mode.
//
// M10 will delete this file along with everything else it shims.

// MARK: - FocusedValues

private struct StartNewChatKey: FocusedValueKey {
    typealias Value = () -> Void
}

extension FocusedValues {
    var startNewChat: (() -> Void)? {
        get { self[StartNewChatKey.self] }
        set { self[StartNewChatKey.self] = newValue }
    }
}

// MARK: - Project window value

struct ProjectWindowValue: Codable, Hashable {
    let projectId: UUID
    let instanceId: UUID
}
