import SwiftUI
import ClarcCore

// Phase 1 entry point — Clay-only.
//
// The legacy CLI-subprocess code paths (AppState / MainView /
// ProjectWindowView / SettingsView) still live in tree but are no
// longer wired to any window. M10 will delete them; until then they
// compile alongside the Clay flow without being instantiated.
//
// The Clay shell owns one ClayConnection, one ClayMessageDispatcher,
// and one ClayProjectState (M9). The connect screen (M7) covers the
// main window as a sheet whenever the shell is not live.

@main
struct ClarcApp: App {
    @State private var shell: ClayShell = {
        let store = ClayConnectionsStore(keychain: ClaySystemKeychainStore())
        return ClayShell(store: store)
    }()

    var body: some Scene {
        WindowGroup {
            ClayMainWindow(shell: shell)
                .focusable(false)
        }
        .defaultSize(width: 1100, height: 720)
        .defaultLaunchBehavior(.presented)
    }
}
