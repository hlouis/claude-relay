import SwiftUI
import ClarcCore

// Composer for the Clay flow (M8.5). Plain TextField + send button.
// Out of scope per §2: slash commands, attachments, paste handling,
// edit-and-resend, shortcuts. Those die with the legacy ChatKit
// in M10 anyway.
//
// Behaviour:
//   - Return submits, clears the field, dispatches via
//     ClayMessageSender (M3 helper underneath).
//   - clientMsgId is auto-generated. M4 echoes it back via
//     `user_message.clientMsgId`, allowing optimistic dedup later
//     (out of scope for Phase 1).
//   - Disabled while `processingStatus == .processing` to avoid
//     queueing requests on top of an in-flight stream — the daemon
//     would queue them, but the UX is clearer if we gate at the
//     composer.

struct ClayInputBar: View {
    let sender: ClayMessageSender
    let processingStatus: ClayProcessingStatus

    @State private var text: String = ""
    @State private var inFlight = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message…", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .padding(8)
                .background(ClaudeTheme.surfacePrimary, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(ClaudeTheme.borderSubtle, lineWidth: 0.5))
                .focused($focused)
                .onSubmit(submit)
                .disabled(isDisabled)
            Button(action: submit) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(canSubmit ? ClaudeTheme.accent : ClaudeTheme.textTertiary)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.return)
            .disabled(!canSubmit)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(ClaudeTheme.background)
        .onAppear { focused = true }
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isDisabled: Bool {
        processingStatus == .processing || inFlight
    }

    private var canSubmit: Bool {
        !trimmed.isEmpty && !isDisabled
    }

    private func submit() {
        let payload = trimmed
        guard !payload.isEmpty, !isDisabled else { return }
        inFlight = true
        text = ""
        let sender = self.sender
        Task {
            try? await sender.sendMessage(
                text: payload,
                images: nil,
                pastes: nil,
                clientMsgId: UUID().uuidString
            )
            await MainActor.run { inFlight = false }
        }
    }
}

// MARK: - Preview

#Preview("Idle") {
    ClayInputBar(sender: PreviewSender(), processingStatus: .idle)
        .frame(width: 520)
}

#Preview("Processing") {
    ClayInputBar(sender: PreviewSender(), processingStatus: .processing)
        .frame(width: 520)
}

private final class PreviewSender: ClayMessageSender {
    func sendMessage(text: String?, images: [ClayImageAttachment]?, pastes: [String]?, clientMsgId: String?) async throws {}
}
