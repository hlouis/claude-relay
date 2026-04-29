import Foundation
import Testing
import Network
@testable import ClarcCore

// Network-backed integration tests for ClayConnection. Each test
// brings up a tiny in-process server (NWListener) on localhost so the
// actor exercises the real URLSession WebSocket code path.
//
// Out of scope for this suite (need an HTTP+WS unified mock — M1.5):
//   * `GET /info` returning 401 → `.failed(.authExpired)`
//   * Verifying that the second connection's URL query carries
//     resumeSession / lastSeq.
//
// The R4 prototype script (`protocol/scripts/r4-handshake.mjs`) already
// covers the live-daemon happy path so the wire format itself is
// verified end-to-end elsewhere.

@Suite("ClayConnection (integration)", .serialized)
struct ClayConnectionIntegrationTests {

    private static let infoJSON = #"""
    {"type":"info","cwd":"/tmp","slug":"test","project":"test","version":"0.0.0","debug":false,"dangerouslySkipPermissions":false,"lanHost":null,"projectCount":1,"projects":[{"slug":"test","title":null}],"projectOwnerId":null}
    """#

    /// Wait until `predicate` is true on a status update, or fail the
    /// test after `timeout` seconds. Reads from a fresh AsyncStream
    /// iterator so missed early events are tolerated by the caller's
    /// own ordering of "create iterator → trigger".
    private func awaitStatus(
        _ conn: ClayConnection,
        timeout: Duration = .seconds(8),
        where predicate: @escaping @Sendable (ClayConnectionStatus) -> Bool
    ) async -> ClayConnectionStatus? {
        await withTaskGroup(of: ClayConnectionStatus?.self) { group in
            group.addTask {
                for await s in conn.statusUpdates {
                    if predicate(s) { return s }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    // MARK: - Tests

    @Test("happy path: connect → info → live")
    func happyPath() async throws {
        let server = try WebSocketMockServer()
        try await server.start()
        defer { server.stop() }

        server.setOnAccept { [server] _ in
            // First (and only) connection: send the info frame.
            guard let conn = server.connections.first else { return }
            server.sendText(Self.infoJSON, to: conn)
        }

        let cfg = try ClayConnectionConfig(
            fullWebSocketURL: server.websocketURLString()
        )
        let conn = ClayConnection(config: cfg)

        async let live = awaitStatus(conn) {
            if case .live = $0 { return true } else { return false }
        }
        await conn.connect()

        let result = await live
        #expect(result == .live)

        await conn.disconnect()
    }

    @Test("disconnect during live transitions to .failed(.cancelled)")
    func disconnectDuringLive() async throws {
        let server = try WebSocketMockServer()
        try await server.start()
        defer { server.stop() }

        server.setOnAccept { [server] _ in
            guard let conn = server.connections.first else { return }
            server.sendText(Self.infoJSON, to: conn)
        }

        let cfg = try ClayConnectionConfig(
            fullWebSocketURL: server.websocketURLString()
        )
        let conn = ClayConnection(config: cfg)

        async let live = awaitStatus(conn) {
            if case .live = $0 { return true } else { return false }
        }
        await conn.connect()
        _ = await live

        async let cancelled = awaitStatus(conn) {
            if case .failed(.cancelled) = $0 { return true } else { return false }
        }
        await conn.disconnect()
        let final = await cancelled
        #expect(final == .failed(.cancelled))
    }

    @Test("server-initiated close engages reconnect path")
    func serverCloseTriggersReconnect() async throws {
        let server = try WebSocketMockServer()
        try await server.start()
        defer { server.stop() }

        let didFireSecond = LockedFlag()

        server.setOnAccept { [server, didFireSecond] ordinal in
            guard let active = server.connections.last else { return }
            if ordinal == 1 {
                // Send info, then immediately close the connection so
                // the client schedules a reconnect.
                server.sendText(Self.infoJSON, to: active)
                // Brief delay so the client can decode info before close.
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
                    server.close(active)
                }
            } else if ordinal == 2 {
                didFireSecond.set()
                server.sendText(Self.infoJSON, to: active)
            }
        }

        let cfg = try ClayConnectionConfig(
            fullWebSocketURL: server.websocketURLString()
        )
        let conn = ClayConnection(config: cfg)

        // Wait until status reaches reconnecting at least once after the
        // first close.
        async let reconnecting = awaitStatus(conn, timeout: .seconds(8)) {
            if case .reconnecting = $0 { return true } else { return false }
        }
        await conn.connect()
        let r = await reconnecting
        #expect(r != nil, "expected a .reconnecting transition after server close")
        if case .reconnecting(let attempt, _) = (r ?? .idle) {
            #expect(attempt >= 1)
        }

        await conn.disconnect()
        // The mock saw at least the first connection; the second may or
        // may not have raced in before disconnect — the .reconnecting
        // status alone proves the policy fired.
        _ = didFireSecond.value
    }

    @Test("stalled TCP peer triggers connect-timeout → reconnect")
    func connectTimeoutPath() async throws {
        let stall = try StalledTCPListener()
        try await stall.start()
        defer { stall.stop() }

        let cfg = try ClayConnectionConfig(
            fullWebSocketURL: stall.websocketURLString()
        )
        let conn = ClayConnection(config: cfg)

        // The 3-second connect timeout is internal; we just need to see
        // the resulting transition. Allow ~5 s of slack.
        async let outcome = awaitStatus(conn, timeout: .seconds(7)) {
            switch $0 {
            case .reconnecting: return true
            case .failed(let f): return f.allowsReconnect
            default: return false
            }
        }
        await conn.connect()
        let s = await outcome

        switch s {
        case .reconnecting:
            break
        case .failed(let f):
            #expect(f.allowsReconnect)
        case .some(let other):
            Issue.record("unexpected status: \(other)")
        case .none:
            Issue.record("never observed timeout-driven transition")
        }

        await conn.disconnect()
    }
}

// MARK: - Test utilities

/// Tiny thread-safe boolean flag used by the integration tests'
/// connection-ordinal callbacks.
final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = false
    var value: Bool {
        lock.lock(); defer { lock.unlock() }
        return _value
    }
    func set() { lock.lock(); _value = true; lock.unlock() }
}
