import SwiftUI
import ClarcCore
import ClarcChatKit

// Scrollable message list for the Clay flow (M8.5).
//
// Auto-scroll behaviour (Phase 1, simple):
//   - Whenever the trailing item id changes OR the trailing assistant
//     text grows (delta coalesce), scroll to bottom.
//   - When `processingStatus == .processing`, also keep pinning to
//     bottom so streaming output stays visible.
// Phase 2 will respect "user scrolled up — pause auto-scroll".
//
// The view binds directly to `ClaySessionState` rather than reaching
// through the project state, so callers can swap sessions without
// re-instantiating the view.

struct ClayMessageListView: View {
    let session: ClaySessionState

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(session.messages) { item in
                        ClayMessageBubble(item: item)
                            .id(item.id)
                    }
                    if session.processingStatus == .processing {
                        HStack(spacing: 8) {
                            PulseRingView()
                            Text("Streaming...")
                                .font(.caption)
                                .foregroundStyle(ClaudeTheme.textTertiary)
                            Spacer()
                        }
                        .padding(.vertical, 4)
                        .id("clay-streaming-anchor")
                    }
                    // Bottom sentinel for the auto-scroll anchor when no
                    // streaming indicator is showing.
                    Color.clear
                        .frame(height: 1)
                        .id("clay-bottom")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(ClaudeTheme.background)
            .onChange(of: session.messages.count) {
                pinToBottom(proxy: proxy)
            }
            .onChange(of: trailingTextLength) {
                pinToBottom(proxy: proxy)
            }
            .onChange(of: session.processingStatus) {
                pinToBottom(proxy: proxy)
            }
            .onAppear { pinToBottom(proxy: proxy, animated: false) }
        }
    }

    /// Returns the length of the trailing assistant/thinking text so
    /// `onChange` fires every coalesce step, not only on count change.
    private var trailingTextLength: Int {
        switch session.messages.last {
        case .assistantText(let p): return p.text.count
        case .thinking(let p):      return p.text.count
        default:                    return 0
        }
    }

    private func pinToBottom(proxy: ScrollViewProxy, animated: Bool = true) {
        let anchor = session.processingStatus == .processing ? "clay-streaming-anchor" : "clay-bottom"
        if animated {
            withAnimation(.easeOut(duration: 0.15)) {
                proxy.scrollTo(anchor, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(anchor, anchor: .bottom)
        }
    }
}

// MARK: - Preview

#Preview {
    var s = ClaySessionState(sessionId: 1, cliSessionId: "cli", title: "demo")
    s.messages = [
        .user(.init(id: "u1", text: "Hi.")),
        .assistantText(.init(id: "a1", text: "Hello! How can I help?")),
        .user(.init(id: "u2", text: "List the files in /tmp.")),
        .tool(.init(id: "t1", name: "Bash", input: ["cmd": .string("ls /tmp")], result: .init(content: "a\nb\nc", isError: false))),
        .assistantText(.init(id: "a2", text: "Three files: a, b, c.")),
        .result(.init(id: "r1", cost: 0.0021, duration: 0.8, usage: ["input_tokens": 80, "output_tokens": 30])),
    ]
    s.processingStatus = .idle
    return ClayMessageListView(session: s)
        .frame(width: 600, height: 500)
}
