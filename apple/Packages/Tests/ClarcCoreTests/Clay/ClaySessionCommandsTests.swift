import Testing
import Foundation
@testable import ClarcCore

// Unit tests for the M6 sidebar's outbound surface. The view layer
// is not part of the SPM package; these tests cover the protocol
// + lastSeq lookup logic the view will compose.

// MARK: - Mock

actor RecordingSessionCommands: ClaySessionCommands {
    enum Call: Equatable {
        case new(ClaySessionVisibility?)
        case switchTo(id: Int, lastSeq: Int?)
        case delete(id: Int)
        case rename(id: Int, title: String)
    }

    private(set) var calls: [Call] = []

    func newSession(visibility: ClaySessionVisibility?) async throws {
        calls.append(.new(visibility))
    }
    func switchSession(id: Int, lastSeq: Int?) async throws {
        calls.append(.switchTo(id: id, lastSeq: lastSeq))
    }
    func deleteSession(id: Int) async throws {
        calls.append(.delete(id: id))
    }
    func renameSession(id: Int, title: String) async throws {
        calls.append(.rename(id: id, title: title))
    }
}

// MARK: - lastSeqForResume

@Suite("ClayProjectState.lastSeqForResume")
@MainActor
struct LastSeqForResumeTests {

    @Test("returns the target session's lastSeq, not the active session's")
    func targetSessionCursor() {
        let state = ClayProjectState()
        state.sessionStates[1] = {
            var s = ClaySessionState(sessionId: 1, cliSessionId: "cli-1")
            s.lastSeq = 11
            return s
        }()
        state.sessionStates[2] = {
            var s = ClaySessionState(sessionId: 2, cliSessionId: "cli-2")
            s.lastSeq = 99
            return s
        }()
        state.activeSessionId = 1

        // Switching to session 2: should pull session 2's cursor, not 1's.
        #expect(state.lastSeqForResume(sessionId: 2) == 99)
        #expect(state.lastSeqForResume(sessionId: 1) == 11)
    }

    @Test("returns nil for an unknown or never-seen session")
    func nilForUnseen() {
        let state = ClayProjectState()
        state.sessionStates[1] = ClaySessionState(sessionId: 1)  // lastSeq = nil
        #expect(state.lastSeqForResume(sessionId: 1) == nil)
        #expect(state.lastSeqForResume(sessionId: 99) == nil)
    }
}

// MARK: - Outbound dispatch

@Suite("ClaySessionCommands dispatch")
struct SessionCommandsDispatchTests {

    @Test("new / delete / rename pass through verbatim")
    func passthrough() async throws {
        let cmd = RecordingSessionCommands()
        try await cmd.newSession(visibility: nil)
        try await cmd.newSession(visibility: .private)
        try await cmd.deleteSession(id: 7)
        try await cmd.renameSession(id: 7, title: "Refactor X")

        let calls = await cmd.calls
        #expect(calls == [
            .new(nil),
            .new(.private),
            .delete(id: 7),
            .rename(id: 7, title: "Refactor X"),
        ])
    }

    @Test("switch carries the target session's lastSeq, not the active one")
    func switchCarriesTargetCursor() async throws {
        let state = await ClayProjectState()
        await MainActor.run {
            state.sessionStates[1] = {
                var s = ClaySessionState(sessionId: 1)
                s.lastSeq = 5
                return s
            }()
            state.sessionStates[2] = {
                var s = ClaySessionState(sessionId: 2)
                s.lastSeq = 42
                return s
            }()
            state.activeSessionId = 1
        }
        let cmd = RecordingSessionCommands()

        // Simulate the view's "user clicked session 2" handler: pull
        // target cursor first, then send.
        let target = 2
        let cursor = await MainActor.run { state.lastSeqForResume(sessionId: target) }
        try await cmd.switchSession(id: target, lastSeq: cursor)

        let calls = await cmd.calls
        #expect(calls == [.switchTo(id: 2, lastSeq: 42)])
    }

    @Test("switch with no prior cursor sends lastSeq = nil")
    func switchNilCursor() async throws {
        let state = await ClayProjectState()
        await MainActor.run {
            state.sessionStates[3] = ClaySessionState(sessionId: 3)
            state.activeSessionId = 3
        }
        let cmd = RecordingSessionCommands()
        let cursor = await MainActor.run { state.lastSeqForResume(sessionId: 3) }
        try await cmd.switchSession(id: 3, lastSeq: cursor)

        let calls = await cmd.calls
        #expect(calls == [.switchTo(id: 3, lastSeq: nil)])
    }

    @Test("wire encoding spot-check: switch_session shape")
    func switchEncodingShape() throws {
        let msg = ClayOutbound.switchSession(id: 7, lastSeq: 42)
        let data = try JSONEncoder().encode(msg)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        #expect(json["type"] as? String == "switch_session")
        #expect(json["id"] as? Int == 7)
        #expect(json["lastSeq"] as? Int == 42)
    }
}
