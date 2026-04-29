import Foundation
import Testing
@testable import ClarcCore

// Behavioural tests for the ClayConnection actor that don't need a
// real WebSocket peer. Network-level scenarios (connect / reconnect-
// resume / connect-timeout / 401-on-info / server-close) are tracked
// for M1.5 against an NWListener-based mock server.

@Suite("ClayConnection (offline behaviour)")
struct ClayConnectionTests {

    private func makeConfig() throws -> ClayConnectionConfig {
        try ClayConnectionConfig(
            fullWebSocketURL: "ws://127.0.0.1:1/p/test/ws"
        )
    }

    @Test("starts idle")
    func startsIdle() async throws {
        let conn = ClayConnection(config: try makeConfig())
        let status = await conn.status
        #expect(status == .idle)
    }

    @Test("send before connect throws notConnected")
    func sendBeforeConnectThrows() async throws {
        let conn = ClayConnection(config: try makeConfig())
        await #expect(throws: ClayConnectionError.notConnected) {
            try await conn.send(.message(ClayClientMessage.Message(text: "hi")))
        }
    }

    @Test("disconnect on idle connection terminates cleanly")
    func disconnectOnIdle() async throws {
        let conn = ClayConnection(config: try makeConfig())

        // Drain status updates in the background; should see idle then
        // failed(.cancelled) and then the stream finishes.
        let collected = Task<[ClayConnectionStatus], Never> { [conn] in
            var out: [ClayConnectionStatus] = []
            for await s in conn.statusUpdates {
                out.append(s)
            }
            return out
        }

        await conn.disconnect()
        let updates = await collected.value

        #expect(updates.first == .idle)
        #expect(updates.last == .failed(.cancelled))
    }

    @Test("connect to dead port eventually transitions to reconnecting")
    func connectFailureSchedulesReconnect() async throws {
        // Port 1 is reserved/closed; connect must fail. We don't wait
        // for the full 1 s reconnect delay — just that the actor does
        // NOT terminate (allowsReconnect for transport failures) and
        // ends up in either .reconnecting or another non-terminal state.
        let conn = ClayConnection(config: try makeConfig())

        let captured = Task<ClayConnectionStatus?, Never> { [conn] in
            for await s in conn.statusUpdates {
                if case .reconnecting = s { return s }
                if case .failed = s { return s }
            }
            return nil
        }

        await conn.connect()

        // Bound the wait — connect timeout is 3 s; first reconnect at +1 s
        // after that. Give it 6 s of headroom.
        let result = await withTaskGroup(of: ClayConnectionStatus?.self) { group in
            group.addTask { await captured.value }
            group.addTask {
                try? await Task.sleep(for: .seconds(6))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        await conn.disconnect()

        // Either reconnecting (good — retry path engaged) or a transport
        // failure that allowsReconnect (also good — same allowed-state class).
        switch result {
        case .reconnecting:
            break
        case .failed(let f):
            #expect(f.allowsReconnect, "unexpected terminal failure: \(f)")
        case .some(let other):
            Issue.record("unexpected status: \(other)")
        case .none:
            Issue.record("no status transition observed within budget")
        }
    }
}
