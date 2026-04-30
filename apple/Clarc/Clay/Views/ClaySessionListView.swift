import SwiftUI
import ClarcCore

// Session sidebar for the Clay flow (M6). Renders the
// `ClayProjectState.sessions` array, with selection feeding
// `switch_session` and the row context menu / toolbar driving
// new / delete / rename.
//
// The view trusts the daemon's broadcast for state convergence:
//   - Tap a row → send `switch_session(id, lastSeq)`. M4's
//     handler for `session_switched` flips `activeSessionId`.
//   - Tap "+" → send `new_session`. Daemon broadcasts
//     `session_list` + `session_switched`; M4 lands them.
//   - Delete row → send `delete_session`. Daemon picks the
//     replacement session itself (sessions.js:411-419) and emits
//     `session_switched`. We do nothing locally.
//   - Rename → send `rename_session(id, title)`. Daemon
//     broadcasts a fresh `session_list`.
//
// Phase 1 limitation: no search, no per-session loop indicators,
// no drag-reorder. Those are Tier 2 territory.

struct ClaySessionListView: View {
    let project: ClayProjectState
    let commands: ClaySessionCommands

    @State private var renamingId: Int?
    @State private var renameDraft: String = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            ClaudeThemeDivider()
            list
        }
        .background(ClaudeTheme.sidebarBackground)
    }

    private var header: some View {
        HStack {
            Text("Sessions")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ClaudeTheme.textSecondary)
            Spacer()
            Button {
                Task { try? await commands.newSession(visibility: nil) }
            } label: {
                Image(systemName: "plus.circle")
                    .imageScale(.large)
                    .foregroundStyle(ClaudeTheme.accent)
            }
            .buttonStyle(.plain)
            .help("New session")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(project.sessions, id: \.id) { entry in
                    row(for: entry)
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func row(for entry: ClaySessionListEntry) -> some View {
        let isActive = project.activeSessionId == entry.id
        let isRenaming = renamingId == entry.id

        HStack(spacing: 8) {
            statusDot(for: entry)
            if isRenaming {
                renameField(for: entry)
            } else {
                Text(entry.title.isEmpty ? "(untitled)" : entry.title)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .foregroundStyle(isActive ? ClaudeTheme.textPrimary : ClaudeTheme.textSecondary)
            }
            Spacer(minLength: 4)
            if entry.unread > 0 && !isActive {
                Text("\(entry.unread)")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(ClaudeTheme.accentSubtle, in: Capsule())
                    .foregroundStyle(ClaudeTheme.accent)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isActive ? ClaudeTheme.sidebarItemSelected : .clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture {
            guard !isRenaming, !isActive else { return }
            select(entry.id)
        }
        .contextMenu {
            Button("Rename") { beginRename(entry) }
            Button("Delete", role: .destructive) { delete(entry.id) }
        }
    }

    private func statusDot(for entry: ClaySessionListEntry) -> some View {
        Circle()
            .fill(entry.isProcessing ? ClaudeTheme.accent : ClaudeTheme.borderSubtle)
            .frame(width: 6, height: 6)
    }

    private func renameField(for entry: ClaySessionListEntry) -> some View {
        TextField("Session title", text: $renameDraft, onCommit: { commitRename(entry.id) })
            .textFieldStyle(.roundedBorder)
            .onExitCommand { cancelRename() }
    }

    // MARK: - Actions

    private func select(_ id: Int) {
        let cursor = project.lastSeqForResume(sessionId: id)
        Task { try? await commands.switchSession(id: id, lastSeq: cursor) }
    }

    private func beginRename(_ entry: ClaySessionListEntry) {
        renamingId = entry.id
        renameDraft = entry.title
    }

    private func commitRename(_ id: Int) {
        let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        renamingId = nil
        guard !title.isEmpty else { return }
        Task { try? await commands.renameSession(id: id, title: title) }
    }

    private func cancelRename() {
        renamingId = nil
        renameDraft = ""
    }

    private func delete(_ id: Int) {
        Task { try? await commands.deleteSession(id: id) }
    }
}

// MARK: - Preview

#Preview {
    let state = ClayProjectState()
    state.sessions = [
        .init(id: 1, cliSessionId: "cli-1", title: "Refactor permission flow",
              active: true, isProcessing: true, lastActivity: 0,
              loop: nil, ownerId: nil, sessionVisibility: .shared, unread: 0),
        .init(id: 2, cliSessionId: "cli-2", title: "Read PLAN.md",
              active: false, isProcessing: false, lastActivity: 0,
              loop: nil, ownerId: nil, sessionVisibility: .shared, unread: 3),
        .init(id: 3, cliSessionId: nil, title: "",
              active: false, isProcessing: false, lastActivity: 0,
              loop: nil, ownerId: nil, sessionVisibility: .private, unread: 0),
    ]
    state.activeSessionId = 1
    return ClaySessionListView(project: state, commands: PreviewCommands())
        .frame(width: 240, height: 320)
}

private final class PreviewCommands: ClaySessionCommands {
    func newSession(visibility: ClaySessionVisibility?) async throws {}
    func switchSession(id: Int, lastSeq: Int?) async throws {}
    func deleteSession(id: Int) async throws {}
    func renameSession(id: Int, title: String) async throws {}
}
