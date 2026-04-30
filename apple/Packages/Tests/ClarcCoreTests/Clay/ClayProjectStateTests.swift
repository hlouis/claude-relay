import Testing
@testable import ClarcCore

// Integration tests for ClayProjectState — drive a synthetic
// `ClayServerMessage` stream through `apply(_:)` and assert the final
// session-state shape. Also covers PLAN R5 (seq-based incremental
// replay across reconnect).

@Suite("ClayProjectState (synthetic stream)")
@MainActor
struct ClayProjectStateStreamTests {

    // Deterministic id generator: returns "id-1", "id-2", … per call.
    static func makeState() -> ClayProjectState {
        let s = ClayProjectState()
        var counter = 0
        s.idGenerator = {
            counter += 1
            return "id-\(counter)"
        }
        // Seed an active session so streaming events have somewhere to land.
        s.sessionStates[1] = ClaySessionState(sessionId: 1, cliSessionId: "cli-1", title: "t")
        s.activeSessionId = 1
        return s
    }

    @Test("user → 4 deltas → tool round-trip → result → done collapses correctly")
    func happyPath() {
        let state = Self.makeState()

        state.apply(.userMessage(.init(text: "hi", imageCount: nil, pastes: nil, clientMsgId: "c1", planContent: nil, seq: 1)))
        state.apply(.status(.init(status: .processing)))
        state.apply(.delta(.init(text: "Hel", seq: 2)))
        state.apply(.delta(.init(text: "lo, ", seq: 3)))
        state.apply(.delta(.init(text: "wor", seq: 4)))
        state.apply(.delta(.init(text: "ld.", seq: 5)))
        state.apply(.toolStart(.init(id: "tool-1", name: "Bash", seq: 6)))
        state.apply(.toolExecuting(.init(id: "tool-1", name: "Bash", input: ["cmd": .string("ls")], seq: 7)))
        state.apply(.toolResult(.init(id: "tool-1", content: "a\nb", isError: false, images: nil, seq: 8)))
        state.apply(.result(.init(cost: 0.001, duration: 1.5, usage: ["in": 100], modelUsage: nil, sessionId: "cli-1", lastStreamInputTokens: 100, seq: 9)))
        state.apply(.done(.init(code: 0, seq: 10)))
        state.apply(.status(.init(status: .idle)))

        guard let session = state.sessionStates[1] else {
            Issue.record("missing session"); return
        }

        // Expected: user, assistantText (coalesced), tool (with input + result), result.
        #expect(session.messages.count == 4)
        #expect(session.processingStatus == .idle)

        guard case .user(let u) = session.messages[0] else {
            Issue.record("expected user"); return
        }
        #expect(u.text == "hi")
        #expect(u.clientMsgId == "c1")

        guard case .assistantText(let t) = session.messages[1] else {
            Issue.record("expected assistantText"); return
        }
        #expect(t.text == "Hello, world.")

        guard case .tool(let tool) = session.messages[2] else {
            Issue.record("expected tool"); return
        }
        #expect(tool.id == "tool-1")
        #expect(tool.input?["cmd"] == .string("ls"))
        #expect(tool.result?.content == "a\nb")
        #expect(tool.result?.isError == false)

        guard case .result(let r) = session.messages[3] else {
            Issue.record("expected result"); return
        }
        #expect(r.cost == 0.001)
        #expect(session.lastUsage == ["in": 100])
        #expect(session.lastCost == 0.001)
        #expect(session.lastSeq == 11)  // last seq-bearing event was done(seq:10) → next-expected 11
    }

    @Test("permission request inside the stream resolves cleanly")
    func permissionInStream() {
        let state = Self.makeState()
        state.apply(.toolStart(.init(id: "t-X", name: "Bash", seq: 1)))
        state.apply(.permissionRequest(.init(
            requestId: "p-1", toolName: "Bash",
            toolInput: ["cmd": .string("rm -rf /")],
            toolUseId: "t-X", decisionReason: "destructive", seq: 2
        )))
        state.apply(.permissionResolved(.init(requestId: "p-1", decision: .deny, seq: 3)))
        state.apply(.toolResult(.init(id: "t-X", content: "denied", isError: true, images: nil, seq: 4)))

        let session = state.sessionStates[1]!
        #expect(session.pendingPermissions.isEmpty)
        // Sequence: tool, permission(resolved), then tool's result back-filled
        guard case .tool(let tool) = session.messages.first(where: { if case .tool = $0 { true } else { false } }) else {
            Issue.record("expected tool"); return
        }
        #expect(tool.result?.isError == true)
        guard case .permission(let perm) = session.messages.first(where: { if case .permission = $0 { true } else { false } }) else {
            Issue.record("expected permission"); return
        }
        #expect(perm.status == .resolved(.deny))
    }
}

@Suite("ClayProjectState (history vs live equivalence)")
@MainActor
struct ClayProjectStateHistoryTests {

    @Test("history replay produces the same messages as live streaming, lastSeq untouched")
    func historyEquivalence() {
        // Live run.
        let live = ClayProjectStateStreamTests.makeState()
        let liveStream: [ClayServerMessage] = [
            .userMessage(.init(text: "hi", imageCount: nil, pastes: nil, clientMsgId: nil, planContent: nil, seq: 1)),
            .delta(.init(text: "ok", seq: 2)),
            .delta(.init(text: "ay", seq: 3)),
            .result(.init(cost: nil, duration: nil, usage: nil, modelUsage: nil, sessionId: nil, lastStreamInputTokens: nil, seq: 4)),
        ]
        for m in liveStream { live.apply(m) }

        // History run: same payloads sandwiched between history_meta / history_done.
        let history = ClayProjectStateStreamTests.makeState()
        history.apply(.historyMeta(.init(total: liveStream.count, from: 0, resumed: false)))
        for m in liveStream { history.apply(m) }
        history.apply(.historyDone(.init(lastUsage: nil, lastModelUsage: nil, lastCost: nil, lastStreamInputTokens: nil)))

        // Compare just the chat-item arrays — ids will differ across runs
        // because idGenerator is fresh per state, so compare structural
        // shape via a projection.
        let liveShape = live.sessionStates[1]!.messages.map(structuralShape)
        let historyShape = history.sessionStates[1]!.messages.map(structuralShape)
        #expect(liveShape == historyShape)

        // History mode must NOT advance lastSeq. Live must.
        #expect(live.sessionStates[1]!.lastSeq == 5)
        #expect(history.sessionStates[1]!.lastSeq == nil)
        #expect(history.sessionStates[1]!.historyLoading == .done)
    }

    private func structuralShape(_ item: ClayChatItem) -> String {
        switch item {
        case .user(let p):          return "user(\(p.text))"
        case .assistantText(let p): return "ast(\(p.text))"
        case .thinking(let p):      return "thk(\(p.text))"
        case .tool(let p):          return "tool(\(p.id),\(p.name))"
        case .permission(let p):    return "perm(\(p.id))"
        case .result:               return "result"
        case .systemError(let p):   return "err(\(p.text))"
        }
    }
}

@Suite("ClayProjectState (R5 resume cursor)")
@MainActor
struct ClayProjectStateResumeTests {

    @Test("incremental replay across reconnect: lastSeq=N → daemon emits N+1, N+2 → expects them")
    func r5Replay() {
        // PLAN R5: client at seq=N → disconnect → reconnect with
        // lastSeq=N+1 (next-expected) → daemon emits N+1, N+2 → state
        // should advance lastSeq to N+3, no duplicate items.

        let state = ClayProjectStateStreamTests.makeState()

        // Phase 1: receive up to seq=10.
        state.apply(.delta(.init(text: "first", seq: 10)))
        #expect(state.sessionStates[1]!.lastSeq == 11)

        // Phase 2: simulate disconnect — no apply. Reconnect, daemon
        // resumes from seq=11.
        state.apply(.delta(.init(text: "-second", seq: 11)))
        state.apply(.delta(.init(text: "-third", seq: 12)))

        let session = state.sessionStates[1]!
        #expect(session.lastSeq == 13)
        #expect(session.messages.count == 1)
        guard case .assistantText(let t) = session.messages[0] else {
            Issue.record("expected assistantText"); return
        }
        #expect(t.text == "first-second-third")
    }

    @Test("messages without seq do not touch lastSeq")
    func nonSeqEventsIgnored() {
        let state = ClayProjectStateStreamTests.makeState()
        state.apply(.delta(.init(text: "x", seq: 5)))
        #expect(state.sessionStates[1]!.lastSeq == 6)

        // status / historyMeta / sessionList / info etc. carry no seq.
        state.apply(.status(.init(status: .idle)))
        state.apply(.info(.init(
            cwd: "/", slug: "s", project: "p", version: "1",
            debug: false, dangerouslySkipPermissions: nil, osUsers: nil,
            lanHost: nil, projectCount: nil, projects: nil, projectOwnerId: nil
        )))
        #expect(state.sessionStates[1]!.lastSeq == 6)
    }

    @Test("session_list seeds session states keyed by id")
    func sessionListSeed() {
        let state = ClayProjectState()
        state.apply(.sessionList(.init(sessions: [
            .init(id: 1, cliSessionId: "cli-1", title: "alpha", active: true,
                  isProcessing: false, lastActivity: 0, loop: nil, ownerId: nil,
                  sessionVisibility: .shared, unread: 0),
            .init(id: 2, cliSessionId: nil, title: "beta", active: false,
                  isProcessing: false, lastActivity: 0, loop: nil, ownerId: nil,
                  sessionVisibility: .shared, unread: 0),
        ])))
        #expect(state.sessions.count == 2)
        #expect(state.sessionStates[1]?.title == "alpha")
        #expect(state.sessionStates[2]?.title == "beta")
        #expect(state.activeSessionId == 1)
    }
}
