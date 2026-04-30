import Testing
@testable import ClarcCore

// Unit tests for ClaySessionState mutators. The big-switch integration
// tests live in ClayProjectStateTests; this file exercises the
// coalescing rules and back-fill semantics in isolation.

@Suite("ClaySessionState (delta coalescing)")
struct ClaySessionStateCoalesceTests {

    @Test("4 deltas in a row collapse into one assistantText item")
    func deltaCoalesce() {
        var s = ClaySessionState(sessionId: 1)
        s.appendDelta("Hel", newId: "a1")
        s.appendDelta("lo, ", newId: "a2")
        s.appendDelta("wor", newId: "a3")
        s.appendDelta("ld", newId: "a4")

        #expect(s.messages.count == 1)
        guard case .assistantText(let item) = s.messages[0] else {
            Issue.record("expected assistantText"); return
        }
        #expect(item.text == "Hello, world")
        #expect(item.id == "a1")  // id from first delta is preserved
    }

    @Test("a tool call between deltas opens a fresh assistantText after")
    func deltaSplitByTool() {
        var s = ClaySessionState(sessionId: 1)
        s.appendDelta("before", newId: "a1")
        s.startTool(id: "tool-1", name: "Bash")
        s.setToolResult(id: "tool-1", content: "ok", isError: false, images: nil)
        s.appendDelta("after", newId: "a2")

        #expect(s.messages.count == 3)
        guard case .assistantText(let first) = s.messages[0],
              case .tool = s.messages[1],
              case .assistantText(let second) = s.messages[2] else {
            Issue.record("unexpected shape: \(s.messages)"); return
        }
        #expect(first.text == "before")
        #expect(first.id == "a1")
        #expect(second.text == "after")
        #expect(second.id == "a2")
    }

    @Test("thinking_start always opens a new thinking block")
    func thinkingDoesNotCoalesceAcrossStarts() {
        var s = ClaySessionState(sessionId: 1)
        s.startThinking(newId: "t1")
        s.appendThinkingDelta("first ", newId: "ignored")
        s.appendThinkingDelta("thought", newId: "ignored")
        s.stopThinking(durationMs: 100)
        s.startThinking(newId: "t2")
        s.appendThinkingDelta("second", newId: "ignored")
        s.stopThinking(durationMs: 200)

        let thinkings = s.messages.compactMap { item -> ClayChatItem.ThinkingItem? in
            if case .thinking(let t) = item { return t } else { return nil }
        }
        #expect(thinkings.count == 2)
        #expect(thinkings[0].text == "first thought")
        #expect(thinkings[0].durationMs == 100)
        #expect(thinkings[1].text == "second")
        #expect(thinkings[1].durationMs == 200)
    }

    @Test("tool input and result back-fill the matching tool item")
    func toolBackFill() {
        var s = ClaySessionState(sessionId: 1)
        s.startTool(id: "t-A", name: "Read")
        s.startTool(id: "t-B", name: "Write")
        s.setToolInput(id: "t-A", input: ["path": .string("/tmp/a")])
        s.setToolResult(id: "t-B", content: "wrote", isError: false, images: nil)
        s.setToolResult(id: "t-A", content: "contents", isError: false, images: nil)

        let tools = s.messages.compactMap { item -> ClayChatItem.ToolItem? in
            if case .tool(let t) = item { return t } else { return nil }
        }
        #expect(tools.count == 2)
        #expect(tools[0].id == "t-A")
        #expect(tools[0].input?["path"] == .string("/tmp/a"))
        #expect(tools[0].result?.content == "contents")
        #expect(tools[1].id == "t-B")
        #expect(tools[1].input == nil)
        #expect(tools[1].result?.content == "wrote")
    }
}

@Suite("ClaySessionState (permissions)")
struct ClaySessionStatePermissionTests {

    @Test("request → resolved updates inline item and clears pending dict")
    func resolveFlow() {
        var s = ClaySessionState(sessionId: 1)
        let req = ClayServerMessage.PermissionRequest(
            requestId: "p-1",
            toolName: "Bash",
            toolInput: ["cmd": .string("ls")],
            toolUseId: "u-1",
            decisionReason: "untrusted",
            seq: 5
        )
        s.appendPermissionRequest(req)
        #expect(s.pendingPermissions["p-1"] != nil)

        s.resolvePermission(requestId: "p-1", decision: .allow)
        #expect(s.pendingPermissions["p-1"] == nil)
        guard case .permission(let item) = s.messages.last else {
            Issue.record("expected permission item"); return
        }
        #expect(item.status == .resolved(.allow))
    }

    @Test("permission_request_pending after a request is a no-op (no duplicate)")
    func resumeIdempotent() {
        var s = ClaySessionState(sessionId: 1)
        let req = ClayServerMessage.PermissionRequest(
            requestId: "p-1",
            toolName: "Bash",
            toolInput: [:],
            toolUseId: "u-1",
            decisionReason: "",
            seq: 5
        )
        s.appendPermissionRequest(req)
        let pending = ClayServerMessage.PermissionRequestPending(
            requestId: "p-1",
            toolName: "Bash",
            toolInput: [:],
            toolUseId: "u-1",
            decisionReason: ""
        )
        s.appendPermissionRequestPending(pending)
        #expect(s.messages.count == 1)
    }
}

@Suite("ClaySessionState (resume cursor)")
struct ClaySessionStateResumeTests {

    @Test("recordSeq returns next-expected and bumps lastSeq")
    func liveBumpsLastSeq() {
        var s = ClaySessionState(sessionId: 1)
        #expect(s.recordSeq(7) == 8)
        #expect(s.lastSeq == 8)
        #expect(s.recordSeq(8) == 9)
        #expect(s.lastSeq == 9)
    }

    @Test("nil seq is a no-op")
    func nilSeqIgnored() {
        var s = ClaySessionState(sessionId: 1)
        s.lastSeq = 42
        #expect(s.recordSeq(nil) == nil)
        #expect(s.lastSeq == 42)
    }

    @Test("history mode suppresses lastSeq updates")
    func historySuppresses() {
        var s = ClaySessionState(sessionId: 1)
        s.beginHistory(.init(total: 10, from: 0, resumed: false))
        #expect(s.recordSeq(5) == nil)
        #expect(s.lastSeq == nil)
        s.endHistory(.init(lastUsage: nil, lastModelUsage: nil, lastCost: nil, lastStreamInputTokens: nil))
        #expect(s.recordSeq(11) == 12)
        #expect(s.lastSeq == 12)
    }
}
