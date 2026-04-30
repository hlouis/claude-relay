import SwiftUI
import ClarcCore
import ClarcChatKit

// Single chat bubble for the Clay flow (M8.5). Switches over every
// `ClayChatItem` case and routes to the right rendering. Reuses
// `MarkdownContentView` and `BubbleStyle` from `ClarcChatKit` (made
// public in the M8.5 patch); tool blocks are a self-contained
// collapsible JSON+text panel rather than a fork of the legacy
// `ToolResultView` (which depends on `WindowState` for file/diff
// preview hooks the WS flow doesn't have yet).
//
// Phase 1 omissions per §2 / R2: no edit-and-resend, no
// long-text fold, no transient-tool hiding, no agent/edit/multi-edit
// specialised rendering, no inline file diff. These die with the
// legacy ChatKit in M10.

struct ClayMessageBubble: View {
    let item: ClayChatItem

    var body: some View {
        switch item {
        case .user(let p):
            userBubble(p)
        case .assistantText(let p):
            assistantTextBubble(p)
        case .thinking(let p):
            thinkingBubble(p)
        case .tool(let p):
            ClayToolBlock(item: p)
        case .permission(let p):
            permissionEcho(p)
        case .result(let p):
            resultFooter(p)
        case .systemError(let p):
            errorPill(p)
        }
    }

    // MARK: - User

    private func userBubble(_ p: ClayChatItem.UserItem) -> some View {
        HStack(alignment: .top) {
            Spacer(minLength: 60)
            Text(p.text)
                .foregroundStyle(ClaudeTheme.userBubbleText)
                .textSelection(.enabled)
                .bubbleStyle(.user)
        }
    }

    // MARK: - Assistant text

    private func assistantTextBubble(_ p: ClayChatItem.TextItem) -> some View {
        HStack(alignment: .top) {
            MarkdownContentView(text: p.text)
                .bubbleStyle(.assistant)
            Spacer(minLength: 60)
        }
    }

    // MARK: - Thinking

    private func thinkingBubble(_ p: ClayChatItem.ThinkingItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "sparkles")
                .foregroundStyle(ClaudeTheme.textTertiary)
                .imageScale(.small)
            VStack(alignment: .leading, spacing: 4) {
                Text(p.text.isEmpty ? "Thinking..." : p.text)
                    .font(.callout)
                    .foregroundStyle(ClaudeTheme.textTertiary)
                    .textSelection(.enabled)
                if let ms = p.durationMs, ms > 0 {
                    Text("\(Double(ms) / 1000.0, specifier: "%.1f")s")
                        .font(.caption2)
                        .foregroundStyle(ClaudeTheme.textTertiary.opacity(0.7))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Permission echo

    private func permissionEcho(_ p: ClayChatItem.PermissionItem) -> some View {
        HStack(spacing: 8) {
            Image(systemName: statusIcon(for: p.status))
                .foregroundStyle(statusColor(for: p.status))
            Text(statusLabel(for: p))
                .font(.callout)
                .foregroundStyle(ClaudeTheme.textSecondary)
            Spacer()
        }
        .padding(8)
        .background(ClaudeTheme.surfacePrimary, in: RoundedRectangle(cornerRadius: ClaudeTheme.cornerRadiusSmall))
    }

    private func statusIcon(for s: ClayChatItem.PermissionItem.Status) -> String {
        switch s {
        case .pending:    return "shield"
        case .resolved:   return "checkmark.shield"
        case .cancelled:  return "xmark.shield"
        }
    }

    private func statusColor(for s: ClayChatItem.PermissionItem.Status) -> Color {
        switch s {
        case .pending:    return ClaudeTheme.accent
        case .resolved:   return ClaudeTheme.textSecondary
        case .cancelled:  return ClaudeTheme.textTertiary
        }
    }

    private func statusLabel(for p: ClayChatItem.PermissionItem) -> String {
        switch p.status {
        case .pending:                  return "Permission requested for \(p.toolName)"
        case .resolved(let d):          return "\(p.toolName): \(humanize(d))"
        case .cancelled:                return "\(p.toolName): cancelled"
        }
    }

    private func humanize(_ d: ClayPermissionDecision) -> String {
        switch d {
        case .allow:              return "allowed"
        case .allowAlways:        return "allowed (always)"
        case .deny:               return "denied"
        case .allowAcceptEdits:   return "allowed (auto-accept edits)"
        case .allowClearContext:  return "allowed (clear context)"
        }
    }

    // MARK: - Result footer

    private func resultFooter(_ p: ClayChatItem.ResultItem) -> some View {
        HStack(spacing: 12) {
            if let cost = p.cost {
                Label(String(format: "$%.4f", cost), systemImage: "dollarsign.circle")
            }
            if let d = p.duration {
                Label(String(format: "%.1fs", d), systemImage: "clock")
            }
            if let usage = p.usage,
               let input = usage["input_tokens"],
               let output = usage["output_tokens"] {
                Label("\(input)→\(output) tok", systemImage: "arrow.left.arrow.right")
            }
            Spacer()
        }
        .font(.caption)
        .foregroundStyle(ClaudeTheme.textTertiary)
        .padding(.top, 4)
    }

    // MARK: - Error pill

    private func errorPill(_ p: ClayChatItem.SystemErrorItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: p.kind == .contextOverflow ? "exclamationmark.triangle" : "xmark.octagon")
                .foregroundStyle(.red)
            Text(p.text.isEmpty ? "Unknown error" : p.text)
                .font(.callout)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .bubbleStyle(.error)
    }
}

// MARK: - Tool block

private struct ClayToolBlock: View {
    let item: ClayChatItem.ToolItem
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if isExpanded {
                inputBlock
                if let result = item.result {
                    resultBlock(result)
                }
            }
        }
        .bubbleStyle(item.result?.isError == true ? .toolError : .tool)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) { isExpanded.toggle() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: stateIcon)
                    .foregroundStyle(stateColor)
                Text(item.name)
                    .font(.callout.weight(.semibold).monospaced())
                    .foregroundStyle(ClaudeTheme.textPrimary)
                if let snippet = inputSnippet {
                    Text(snippet)
                        .font(.callout.monospaced())
                        .foregroundStyle(ClaudeTheme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer()
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .imageScale(.small)
                    .foregroundStyle(ClaudeTheme.textTertiary)
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var inputBlock: some View {
        if let input = item.input, !input.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text("Input")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(ClaudeTheme.textTertiary)
                Text(prettyJSON(input))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ClaudeTheme.textSecondary)
                    .textSelection(.enabled)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(ClaudeTheme.codeBackground, in: RoundedRectangle(cornerRadius: 4))
            }
        }
    }

    private func resultBlock(_ result: ClayChatItem.ToolItem.ToolResult) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(result.isError ? "Error" : "Result")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(result.isError ? .red : ClaudeTheme.textTertiary)
            Text(result.content)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ClaudeTheme.textPrimary)
                .textSelection(.enabled)
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ClaudeTheme.codeBackground, in: RoundedRectangle(cornerRadius: 4))
        }
    }

    private var stateIcon: String {
        if item.result == nil { return "hourglass" }
        return item.result?.isError == true ? "xmark.circle" : "checkmark.circle"
    }

    private var stateColor: Color {
        if item.result == nil { return ClaudeTheme.accent }
        return item.result?.isError == true ? .red : ClaudeTheme.textSecondary
    }

    private var inputSnippet: String? {
        guard let input = item.input, !input.isEmpty else { return nil }
        // Most tools have one or two key fields worth surfacing.
        // Pick a deterministic order so the snippet doesn't shimmer.
        let preferred = ["cmd", "command", "path", "file_path", "url", "query", "description"]
        for key in preferred {
            if case let .string(s)? = input[key] { return "\(key): \(s)" }
        }
        // Fallback: first key in sorted order.
        if let key = input.keys.sorted().first, case let .string(s)? = input[key] {
            return "\(key): \(s)"
        }
        return nil
    }

    private func prettyJSON(_ value: ClayToolInput) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
              let str = String(data: pretty, encoding: .utf8)
        else { return "(unrenderable)" }
        return str
    }
}

// MARK: - Preview

#Preview {
    VStack(alignment: .leading, spacing: 12) {
        ClayMessageBubble(item: .user(.init(id: "u-1", text: "Refactor permission flow to share state with M5.")))
        ClayMessageBubble(item: .assistantText(.init(id: "a-1", text: "I'll start by reading the **PLAN.md** file:\n\n```swift\nlet x = 42\n```\n\nThen apply the changes.")))
        ClayMessageBubble(item: .thinking(.init(id: "t-1", text: "Let me consider the tradeoffs...", durationMs: 1234)))
        ClayMessageBubble(item: .tool(.init(
            id: "tool-1",
            name: "Read",
            input: ["file_path": .string("/Users/x/PLAN.md")],
            result: .init(content: "# PLAN\nMilestone list...\n", isError: false)
        )))
        ClayMessageBubble(item: .permission(.init(
            id: "p-1", toolName: "Bash", toolInput: [:], toolUseId: "u-1",
            decisionReason: "destructive", status: .resolved(.allow)
        )))
        ClayMessageBubble(item: .result(.init(
            id: "r-1", cost: 0.0042, duration: 1.7,
            usage: ["input_tokens": 1200, "output_tokens": 350]
        )))
        ClayMessageBubble(item: .systemError(.init(id: "e-1", text: "Connection reset", kind: .error)))
    }
    .padding(20)
    .frame(width: 560)
    .background(ClaudeTheme.background)
}
