import SwiftUI
import ClarcCore

// Permission modal for the WebSocket / Clay flow (M5).
//
// Two button sets, gated by `item.isPlanTool`:
//   - Generic tools: Allow / Allow Always / Deny
//   - ExitPlanMode:  Clear Context / Auto-accept Edits / Manually
//                    Approve / Reject
//
// The modal owns no state of its own beyond the in-flight Task. It
// delegates wire encoding to a `ClayPermissionResponder` (the
// production conformer is `ClayConnection`); the parent view drives
// dismissal by removing the matching entry from
// `ClaySessionState.pendingPermissions` once the daemon echoes the
// resolution.
//
// Phase 1 limitation: `planContent` is not stitched yet. The daemon
// falls back to `pending.toolInput.planFilePath` when the field is
// missing, so `allow_clear_context` still works — it just won't pass
// inline plan markdown until Phase 2.

struct ClayPermissionModal: View {
    let item: ClayChatItem.PermissionItem
    let responder: ClayPermissionResponder
    var onDismiss: (() -> Void)? = nil

    @State private var inFlight = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            ClaudeThemeDivider()
            details
            if !item.decisionReason.isEmpty {
                reasonSection
            }
            Spacer(minLength: 8)
            buttons
        }
        .padding(20)
        .frame(width: 520)
        .background(ClaudeTheme.surfaceElevated)
        .disabled(inFlight)
    }

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: item.isPlanTool ? "checkmark.seal" : "shield")
                .font(.title2)
                .foregroundStyle(ClaudeTheme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.isPlanTool ? "Plan Approval" : "Permission Required")
                    .font(.headline)
                    .foregroundStyle(ClaudeTheme.textPrimary)
                Text(item.toolName)
                    .font(.subheadline.monospaced())
                    .foregroundStyle(ClaudeTheme.textSecondary)
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Tool input")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ClaudeTheme.textTertiary)
            ScrollView {
                Text(toolInputSummary)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(ClaudeTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxHeight: 160)
            .background(ClaudeTheme.codeBackground)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var reasonSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Reason")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ClaudeTheme.textTertiary)
            Text(item.decisionReason)
                .font(.callout)
                .foregroundStyle(ClaudeTheme.textSecondary)
        }
    }

    @ViewBuilder
    private var buttons: some View {
        if item.isPlanTool {
            planButtons
        } else {
            genericButtons
        }
    }

    private var genericButtons: some View {
        HStack(spacing: 8) {
            Button("Deny") { decide(.deny) }
                .buttonStyle(.bordered)
                .keyboardShortcut(.escape)
            Spacer()
            Button("Allow Always") { decide(.allowAlways) }
                .buttonStyle(.bordered)
            Button("Allow") { decide(.allow) }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.return)
        }
    }

    private var planButtons: some View {
        VStack(alignment: .trailing, spacing: 8) {
            HStack(spacing: 8) {
                Button("Reject") { decide(.deny) }
                    .buttonStyle(.bordered)
                    .keyboardShortcut(.escape)
                Spacer()
                Button("Manually Approve") { decide(.allow) }
                    .buttonStyle(.bordered)
                Button("Auto-accept Edits") { decide(.allowAcceptEdits) }
                    .buttonStyle(.bordered)
                Button("Clear Context & Auto-accept") { decide(.allowClearContext) }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return)
            }
        }
    }

    // MARK: - Action

    private func decide(_ decision: ClayPermissionDecision) {
        guard !inFlight else { return }
        inFlight = true
        let requestId = item.id
        let responder = self.responder
        Task {
            // Best-effort send. Errors are surfaced via the
            // connection's status stream — no inline error UI here so
            // a transient transport blip doesn't strand the modal in
            // a "failed" state. The daemon will redeliver
            // `permission_request_pending` on reconnect, which M4
            // already deduplicates.
            try? await responder.sendPermissionResponse(
                requestId: requestId,
                decision: decision,
                updatedInput: nil,
                planContent: nil
            )
            await MainActor.run { onDismiss?() }
        }
    }

    private var toolInputSummary: String {
        guard let data = try? JSONEncoder().encode(item.toolInput),
              let pretty = (try? JSONSerialization.jsonObject(with: data))
                .flatMap({ try? JSONSerialization.data(withJSONObject: $0, options: [.prettyPrinted, .sortedKeys]) }),
              let str = String(data: pretty, encoding: .utf8)
        else {
            return "(no input)"
        }
        return str
    }
}

// MARK: - Preview

#Preview("Generic tool") {
    ClayPermissionModal(
        item: .init(
            id: "p-1",
            toolName: "Bash",
            toolInput: ["cmd": .string("rm -rf /tmp/build")],
            toolUseId: "u-1",
            decisionReason: "This command modifies the filesystem outside the project root."
        ),
        responder: PreviewResponder()
    )
}

#Preview("Plan approval") {
    ClayPermissionModal(
        item: .init(
            id: "p-2",
            toolName: "ExitPlanMode",
            toolInput: ["planFilePath": .string("/tmp/plan.md")],
            toolUseId: "u-2",
            decisionReason: ""
        ),
        responder: PreviewResponder()
    )
}

private final class PreviewResponder: ClayPermissionResponder {
    func sendPermissionResponse(
        requestId: String,
        decision: ClayPermissionDecision,
        updatedInput: ClayToolInput?,
        planContent: String?
    ) async throws {}
}
