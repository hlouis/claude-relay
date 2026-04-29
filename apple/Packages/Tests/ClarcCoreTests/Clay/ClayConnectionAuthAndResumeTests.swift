import Foundation
import Testing
import Network
@testable import ClarcCore

// Integration scenarios that need a peer speaking both HTTP and WS on
// a single port — closes the M1.5 gap left by `ClayConnectionIntegration`.
//
// Covers:
//   * `GET /info` returning 401 surfaces as `.failed(.authExpired)`
//     and prevents further reconnect attempts.
//   * Reconnect URL carries `resumeSession` + `lastSeq` query items
//     populated via `ClayConnection.updateResume`.

@Suite("ClayConnection (auth + resume)", .serialized)
struct ClayConnectionAuthAndResumeTests {

    private static let infoJSON = #"""
    {"type":"info","cwd":"/tmp","slug":"test","project":"test","version":"0.0.0","debug":false,"dangerouslySkipPermissions":false,"osUsers":false,"lanHost":null,"projectCount":1,"projects":[{"slug":"test","title":null}],"projectOwnerId":null}
    """#

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

    // MARK: - Test: 401 on /info terminates with .authExpired

    @Test("GET /info returning 401 stops the reconnect loop")
    func infoUnauthorisedTerminates() async throws {
        let server = try MockDaemonServer()
        try await server.start()
        defer { server.stop() }

        // First attempt: WS upgrade succeeds, server sends info, then
        // closes the connection — that triggers the actor's reconnect.
        // Before the reconnect runs the actor will call GET /info,
        // which now returns 401.
        server.setOnWSAccepted { [server] ordinal, conn in
            guard ordinal == 1 else { return }
            server.sendText(Self.infoJSON, on: conn)
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
                // Flip /info to 401 *before* closing so the very next
                // reconnect probe sees it.
                server.infoStatus = 401
                server.close(conn)
            }
        }

        let cfg = try ClayConnectionConfig(
            fullWebSocketURL: server.websocketURLString()
        )
        let conn = ClayConnection(config: cfg)

        async let final = awaitStatus(conn, timeout: .seconds(8)) {
            if case .failed = $0 { return true } else { return false }
        }
        await conn.connect()
        let result = await final

        guard case .failed(let f) = result ?? .idle else {
            Issue.record("did not reach a terminal failure: \(String(describing: result))")
            await conn.disconnect()
            return
        }
        #expect(f == .authExpired)
        #expect(f.allowsReconnect == false)

        await conn.disconnect()
    }

    // MARK: - Test: reconnect URL carries resumeSession + lastSeq

    @Test("reconnect URL carries resumeSession + lastSeq")
    func reconnectCarriesResumeQuery() async throws {
        let server = try MockDaemonServer()
        try await server.start()
        defer { server.stop() }

        let captured = CapturedURLs()

        server.setOnUpgrade { url in
            captured.append(url)
        }
        server.setOnWSAccepted { [server] ordinal, conn in
            // Send info on every accepted upgrade; close the first
            // immediately so the actor reconnects.
            server.sendText(Self.infoJSON, on: conn)
            if ordinal == 1 {
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
                    server.close(conn)
                }
            }
        }

        let cfg = try ClayConnectionConfig(
            fullWebSocketURL: server.websocketURLString()
        )
        let conn = ClayConnection(config: cfg)

        // Wait for the first .live before installing the resume cursor —
        // mirrors what the dispatcher will do once it sees `info`.
        async let firstLive = awaitStatus(conn, timeout: .seconds(5)) {
            if case .live = $0 { return true } else { return false }
        }
        await conn.connect()
        _ = await firstLive

        await conn.updateResume(sessionId: "abc-123", lastSeq: 42)

        // Wait for a second .live — that means the reconnect happened
        // and the server accepted the upgrade with the new query items.
        async let secondLive = awaitStatus(conn, timeout: .seconds(8)) {
            if case .live = $0 { return true } else { return false }
        }
        _ = await secondLive

        let urls = captured.snapshot
        #expect(urls.count >= 2,
                "expected at least 2 upgrade requests, saw \(urls.count)")

        // First upgrade has no resume params.
        let first = urls.first!
        let firstQuery = URLComponents(url: first, resolvingAgainstBaseURL: false)?
            .queryItems ?? []
        #expect(firstQuery.isEmpty,
                "first upgrade must not carry resume params, got \(firstQuery)")

        // Second upgrade carries the cursor we installed.
        let second = urls[1]
        let items = URLComponents(url: second, resolvingAgainstBaseURL: false)?
            .queryItems ?? []
        let dict = Dictionary(uniqueKeysWithValues:
            items.map { ($0.name, $0.value ?? "") })
        #expect(dict["resumeSession"] == "abc-123")
        #expect(dict["lastSeq"] == "42")

        await conn.disconnect()
    }
}

// MARK: - Test utility

/// Thread-safe accumulator for upgrade URLs observed by the mock.
private final class CapturedURLs: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [URL] = []
    func append(_ url: URL) {
        lock.lock(); items.append(url); lock.unlock()
    }
    var snapshot: [URL] {
        lock.lock(); defer { lock.unlock() }
        return items
    }
}
