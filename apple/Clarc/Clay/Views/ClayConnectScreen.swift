import SwiftUI
import ClarcCore

// First-run / reconnect screen for the Clay flow (M7).
//
// Two fields: WebSocket URL and PIN. URL validation reuses M1's
// `ClayConnectionConfig(fullWebSocketURL:)` — the connect screen
// is not allowed to invent its own URL parser. PIN goes to the
// Keychain (via `ClayConnectionsStore`); URL list goes to
// UserDefaults.
//
// On Connect: hands a parsed `ClayConnectionConfig` (with PIN set)
// to `onConnect`. The caller (M9 shell, eventually) is responsible
// for instantiating `ClayConnection`, attaching a
// `ClayMessageDispatcher`, and wiring a `ClayProjectState` as the
// receiver. This view is intentionally dumb about what "connecting"
// means at the network layer — it just produces a valid config.

struct ClayConnectScreen: View {
    let store: ClayConnectionsStore
    let onConnect: (ClayConnectionConfig) -> Void

    @State private var url: String = ""
    @State private var pin: String = ""
    @State private var error: String?
    @State private var recents: [ClayRecentConnection] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            ClaudeThemeDivider()
            form
            if !recents.isEmpty {
                ClaudeThemeDivider()
                recentsList
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(width: 480, height: 480)
        .background(ClaudeTheme.surfaceElevated)
        .onAppear { reloadRecents() }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Connect to Clay")
                .font(.title2.weight(.semibold))
                .foregroundStyle(ClaudeTheme.textPrimary)
            Text("Paste the project's full WebSocket URL.")
                .font(.callout)
                .foregroundStyle(ClaudeTheme.textSecondary)
        }
    }

    // MARK: - Form

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("WebSocket URL")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ClaudeTheme.textTertiary)
                TextField("wss://host:port/p/<slug>/ws", text: $url)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(connect)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("PIN (optional)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ClaudeTheme.textTertiary)
                SecureField("Leave empty if the daemon has no PIN", text: $pin)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(connect)
            }
            if let error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Spacer()
                Button("Connect", action: connect)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return)
                    .disabled(url.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    // MARK: - Recents

    private var recentsList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Recent")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ClaudeTheme.textTertiary)
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(recents) { entry in
                        recentRow(entry)
                    }
                }
            }
            .frame(maxHeight: 160)
        }
    }

    private func recentRow(_ entry: ClayRecentConnection) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.url)
                    .font(.callout.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(ClaudeTheme.textPrimary)
                Text(entry.lastUsed.formatted(.relative(presentation: .named)))
                    .font(.caption)
                    .foregroundStyle(ClaudeTheme.textTertiary)
            }
            Spacer(minLength: 4)
            Button {
                deleteRecent(entry.url)
            } label: {
                Image(systemName: "trash")
                    .imageScale(.small)
                    .foregroundStyle(ClaudeTheme.textTertiary)
            }
            .buttonStyle(.plain)
            .help("Forget this connection")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ClaudeTheme.sidebarItemHover.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { fillForm(from: entry) }
    }

    // MARK: - Actions

    private func connect() {
        error = nil
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPin = pin.trimmingCharacters(in: .whitespacesAndNewlines)

        let config: ClayConnectionConfig
        do {
            config = try ClayConnectionConfig(
                fullWebSocketURL: trimmed,
                pin: trimmedPin.isEmpty ? nil : trimmedPin
            )
        } catch let err as ClayConnectionConfig.ParseError {
            error = humanize(err)
            return
        } catch {
            self.error = "Could not parse URL: \(error.localizedDescription)"
            return
        }

        do {
            try store.save(url: trimmed, pin: trimmedPin.isEmpty ? nil : trimmedPin)
        } catch {
            // Persisting is best-effort. A keychain failure here
            // shouldn't block the user from connecting.
            self.error = "Saved connection but keychain write failed: \(error.localizedDescription)"
        }
        onConnect(config)
    }

    private func fillForm(from entry: ClayRecentConnection) {
        url = entry.url
        pin = (try? store.pin(for: entry.url)) ?? ""
        error = nil
    }

    private func deleteRecent(_ url: String) {
        try? store.delete(url: url)
        reloadRecents()
    }

    private func reloadRecents() {
        recents = store.recents()
    }

    // MARK: - Error formatting

    private func humanize(_ err: ClayConnectionConfig.ParseError) -> String {
        switch err {
        case .invalidURL:                return "That doesn't look like a URL."
        case .unsupportedScheme(let s):  return "Unsupported scheme \"\(s)\". Use ws:// or wss://."
        case .missingHost:               return "URL is missing a host."
        case .unexpectedPath(let p):     return "Path must be /p/<slug>/ws (got \"\(p)\")."
        case .emptySlug:                 return "Project slug is empty."
        }
    }
}

// MARK: - Preview

#Preview {
    let keychain = ClayInMemoryKeychainStore()
    let defaults = UserDefaults(suiteName: "preview")!
    defaults.removePersistentDomain(forName: "preview")
    let store = ClayConnectionsStore(defaults: defaults, keychain: keychain, recentsKey: "preview.recents")
    try? store.save(url: "wss://localhost:2635/p/demo/ws", pin: "1234")
    try? store.save(url: "wss://lan.local:2636/p/work/ws", pin: nil)
    return ClayConnectScreen(store: store) { config in
        print("would connect to \(config.websocketURL)")
    }
}
