import SwiftUI
import ClarcCore

// Root window for the Clay flow (M9). Three-pane NavigationSplitView
// per D3:
//   - Left rail: project entry stub (Phase 1 = single fixed entry;
//     Tier 2 will populate this with a real project picker).
//   - Middle:    ClaySessionListView (M6) bound to the live project.
//   - Right:     ClayMessageListView (M8.5) over the active session,
//                with ClayInputBar pinned at the bottom and a
//                permission .sheet bound to
//                pendingPermissions.values.first (M5).
//
// The connect screen (M7) is a fullscreen cover when the shell is
// not yet live — implemented as a `.sheet` since macOS doesn't have
// .fullScreenCover. The sheet's parent always shows the three-pane
// layout (driven off the shell's nullable `project`); when no
// connection is up the panes render their empty states behind the
// modal.

struct ClayMainWindow: View {
    @Bindable var shell: ClayShell

    @State private var presentingConnect = true
    @State private var connectError: String?

    var body: some View {
        NavigationSplitView {
            ProjectRail()
                .navigationSplitViewColumnWidth(min: 140, ideal: 180, max: 220)
        } content: {
            sessionsPane
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 360)
        } detail: {
            chatPane
                .navigationSplitViewColumnWidth(min: 480, ideal: 720)
        }
        .sheet(isPresented: $presentingConnect) {
            ClayConnectScreen(store: shell.store) { config in
                connectError = nil
                presentingConnect = false
                Task { await shell.connect(config: config) }
            }
        }
        .onChange(of: shell.mode) { _, newMode in
            switch newMode {
            case .live:
                presentingConnect = false
                connectError = nil
            case .disconnected:
                presentingConnect = true
            case .failed(let f):
                connectError = humanize(f)
                presentingConnect = true
            case .connecting:
                break
            }
        }
    }

    // MARK: - Panes

    @ViewBuilder
    private var sessionsPane: some View {
        if let project = shell.project, let connection = shell.connection {
            ClaySessionListView(project: project, commands: connection)
        } else {
            VStack(spacing: 8) {
                Spacer()
                Text("Not connected")
                    .font(.subheadline)
                    .foregroundStyle(ClaudeTheme.textTertiary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ClaudeTheme.sidebarBackground)
        }
    }

    @ViewBuilder
    private var chatPane: some View {
        if let project = shell.project,
           let connection = shell.connection,
           let session = project.activeSessionState {
            ChatPaneContent(
                project: project,
                connection: connection,
                session: session
            )
        } else {
            VStack(spacing: 8) {
                Spacer()
                if case .connecting = shell.mode {
                    ProgressView()
                    Text("Connecting…")
                        .font(.callout)
                        .foregroundStyle(ClaudeTheme.textSecondary)
                } else {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 40))
                        .foregroundStyle(ClaudeTheme.textTertiary)
                    Text("Select a session")
                        .font(.callout)
                        .foregroundStyle(ClaudeTheme.textTertiary)
                }
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ClaudeTheme.background)
        }
    }

    // MARK: - Connect-failure formatting

    private func humanize(_ f: ClayConnectionFailure) -> String {
        switch f {
        case .authExpired:                return "Authentication expired. Re-enter the PIN."
        case .authRejected:               return "PIN rejected by the daemon."
        case .connectTimeout:             return "Connection timed out. Is the daemon running?"
        case .protocolMismatch(let v):    return "Protocol mismatch (\(v))."
        case .transport(let s):           return "Transport error: \(s)"
        case .closedByServer(let c, let r): return "Daemon closed the connection (\(c)\(r.isEmpty ? "" : ": \(r)"))."
        case .cancelled:                  return ""  // user-initiated, no error to show
        }
    }
}

// MARK: - Project rail (Phase 1 stub)

private struct ProjectRail: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "folder")
                    .foregroundStyle(ClaudeTheme.accent)
                Text("Project")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ClaudeTheme.textPrimary)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(ClaudeTheme.sidebarItemSelected, in: RoundedRectangle(cornerRadius: 6))
            .padding(.horizontal, 6)
            .padding(.top, 8)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ClaudeTheme.sidebarBackground)
    }
}

// MARK: - Chat pane content

private struct ChatPaneContent: View {
    let project: ClayProjectState
    let connection: ClayConnection
    let session: ClaySessionState

    var body: some View {
        VStack(spacing: 0) {
            ClayMessageListView(session: session)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            ClayInputBar(
                sender: connection,
                processingStatus: session.processingStatus
            )
        }
        .background(ClaudeTheme.background)
        .sheet(item: pendingBinding()) { item in
            ClayPermissionModal(item: item, responder: connection) {
                // Modal-side dismissal is a no-op — the daemon's
                // permission_resolved / permission_cancel echo will
                // remove the entry from pendingPermissions and
                // SwiftUI tears the sheet down automatically.
            }
        }
    }

    /// SwiftUI's `.sheet(item:)` requires a Binding to an Identifiable.
    /// We synthesise one from the pendingPermissions dictionary so
    /// the sheet shows for the first pending request and dismisses
    /// when M4 removes the entry on resolve / cancel.
    private func pendingBinding() -> Binding<ClayChatItem.PermissionItem?> {
        Binding(
            get: { project.activeSessionState?.pendingPermissions.values.first },
            set: { _ in /* dismissal flows through M4, not through this Binding */ }
        )
    }
}
