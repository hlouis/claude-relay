import Foundation
import Testing
@testable import ClarcCore

// Pure-logic tests for the connection config: URL parsing, scheme
// mapping, query construction. No network involvement.

@Suite("ClayConnectionConfig")
struct ClayConnectionConfigTests {

    // MARK: - Full URL parsing

    @Test("parses canonical wss URL")
    func parsesCanonicalWss() throws {
        let cfg = try ClayConnectionConfig(
            fullWebSocketURL: "wss://daemon.example:2635/p/my-project/ws"
        )
        #expect(cfg.endpoint.absoluteString == "wss://daemon.example:2635")
        #expect(cfg.slug == "my-project")
        #expect(cfg.pin == nil)
        #expect(cfg.resumeSession == nil)
        #expect(cfg.lastSeq == nil)
    }

    @Test("parses ws (TLS-disabled) URL")
    func parsesPlainWs() throws {
        let cfg = try ClayConnectionConfig(
            fullWebSocketURL: "ws://localhost:2633/p/claude-relay/ws"
        )
        #expect(cfg.endpoint.absoluteString == "ws://localhost:2633")
        #expect(cfg.slug == "claude-relay")
    }

    @Test("rejects http(s) scheme")
    func rejectsHttp() {
        #expect(throws: ClayConnectionConfig.ParseError.unsupportedScheme("https")) {
            try ClayConnectionConfig(
                fullWebSocketURL: "https://localhost/p/foo/ws"
            )
        }
    }

    @Test("rejects path that isn't /p/<slug>/ws")
    func rejectsBadPath() {
        #expect(throws: (any Error).self) {
            try ClayConnectionConfig(fullWebSocketURL: "ws://localhost/ws")
        }
        #expect(throws: (any Error).self) {
            try ClayConnectionConfig(fullWebSocketURL: "ws://localhost/p//ws")
        }
        #expect(throws: (any Error).self) {
            try ClayConnectionConfig(fullWebSocketURL: "ws://localhost/p/foo/bar")
        }
    }

    @Test("rejects missing host")
    func rejectsMissingHost() {
        #expect(throws: (any Error).self) {
            try ClayConnectionConfig(fullWebSocketURL: "ws:///p/foo/ws")
        }
    }

    // MARK: - Derived URLs

    @Test("httpOrigin maps ws→http and wss→https")
    func httpOriginMapping() throws {
        let plain = try ClayConnectionConfig(
            fullWebSocketURL: "ws://localhost:2633/p/x/ws"
        )
        #expect(plain.httpOrigin.absoluteString == "http://localhost:2633")
        #expect(plain.authURL.absoluteString == "http://localhost:2633/auth")
        #expect(plain.infoURL.absoluteString == "http://localhost:2633/info")

        let secure = try ClayConnectionConfig(
            fullWebSocketURL: "wss://daemon.example:2635/p/x/ws"
        )
        #expect(secure.httpOrigin.absoluteString == "https://daemon.example:2635")
        #expect(secure.authURL.absoluteString == "https://daemon.example:2635/auth")
    }

    @Test("websocketURL omits query when no resume cursor")
    func websocketURLNoResume() throws {
        let cfg = try ClayConnectionConfig(
            fullWebSocketURL: "ws://localhost:2633/p/claude-relay/ws"
        )
        #expect(cfg.websocketURL.absoluteString
                == "ws://localhost:2633/p/claude-relay/ws")
    }

    @Test("websocketURL appends resumeSession + lastSeq")
    func websocketURLWithResume() throws {
        var cfg = try ClayConnectionConfig(
            fullWebSocketURL: "ws://localhost:2633/p/claude-relay/ws"
        )
        cfg = ClayConnectionConfig(
            endpoint: cfg.endpoint,
            slug: cfg.slug,
            pin: nil,
            resumeSession: "abc-123",
            lastSeq: 42
        )
        let url = cfg.websocketURL
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let items = Dictionary(uniqueKeysWithValues:
            (comps.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(comps.path == "/p/claude-relay/ws")
        #expect(items["resumeSession"] == "abc-123")
        #expect(items["lastSeq"] == "42")
    }

    @Test("websocketURL with only lastSeq still serialises")
    func websocketURLWithLastSeqOnly() throws {
        var cfg = try ClayConnectionConfig(
            fullWebSocketURL: "ws://localhost:2633/p/x/ws"
        )
        cfg = ClayConnectionConfig(
            endpoint: cfg.endpoint, slug: cfg.slug, pin: nil,
            resumeSession: nil, lastSeq: 0
        )
        let url = cfg.websocketURL
        let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems ?? []
        #expect(q == [URLQueryItem(name: "lastSeq", value: "0")])
    }
}
