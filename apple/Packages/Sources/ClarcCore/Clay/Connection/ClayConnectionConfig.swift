import Foundation

// Connection parameters — everything needed to (re)build the WS URL,
// the matching HTTP origin for /auth and /info, and the resume cursor.
//
// The wire format mirrors the daemon's bundled web client exactly:
//   ws[s]://host:port/p/<slug>/ws[?resumeSession=<id>&lastSeq=<n>]
// See `daemon/lib/public/app.js` around line 2900.

public struct ClayConnectionConfig: Sendable, Equatable {

    /// Origin URL with scheme + host + port; no path, no query.
    /// Scheme must be `ws` or `wss`.
    public let endpoint: URL

    /// Project slug — the `<slug>` in `/p/<slug>/ws`.
    public let slug: String

    /// Optional PIN. When non-nil, M1 will POST it to `/auth` before
    /// the WS upgrade. nil means the daemon has no PIN set.
    public var pin: String?

    /// Resume cursor — set by the dispatcher (M2/M4) so that a
    /// reconnect picks up where we left off.
    public var resumeSession: String?
    public var lastSeq: Int?

    public init(
        endpoint: URL,
        slug: String,
        pin: String? = nil,
        resumeSession: String? = nil,
        lastSeq: Int? = nil
    ) {
        self.endpoint = endpoint
        self.slug = slug
        self.pin = pin
        self.resumeSession = resumeSession
        self.lastSeq = lastSeq
    }

    // MARK: - Parsing a full WS URL

    public enum ParseError: Error, Equatable, Sendable {
        case invalidURL
        case unsupportedScheme(String)
        case missingHost
        case unexpectedPath(String)
        case emptySlug
    }

    /// Parse a complete WebSocket URL of the form
    /// `wss://host:port/p/<slug>/ws` (the format users paste into the
    /// connect screen) into a config.
    ///
    /// Query params are ignored on input — `resumeSession` / `lastSeq`
    /// are populated separately by the dispatcher on reconnect.
    public init(fullWebSocketURL string: String, pin: String? = nil) throws {
        guard let url = URL(string: string),
              var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else {
            throw ParseError.invalidURL
        }

        switch comps.scheme?.lowercased() {
        case "ws", "wss":
            break
        case let other?:
            throw ParseError.unsupportedScheme(other)
        case nil:
            throw ParseError.invalidURL
        }

        guard let host = comps.host, !host.isEmpty else {
            throw ParseError.missingHost
        }

        // Expect path "/p/<slug>/ws". Tolerate trailing slash.
        let parts = comps.path.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count == 3, parts[0] == "p", parts[2] == "ws" else {
            throw ParseError.unexpectedPath(comps.path)
        }
        let slug = String(parts[1])
        guard !slug.isEmpty else {
            throw ParseError.emptySlug
        }

        // Strip path/query for the endpoint.
        comps.path = ""
        comps.query = nil
        comps.fragment = nil
        guard let endpoint = comps.url else {
            throw ParseError.invalidURL
        }

        self.init(endpoint: endpoint, slug: slug, pin: pin)
    }

    // MARK: - Derived URLs

    /// HTTP origin used for `/auth` and `/info`. `ws` → `http`, `wss` → `https`.
    public var httpOrigin: URL {
        var comps = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
            ?? URLComponents()
        switch comps.scheme?.lowercased() {
        case "wss": comps.scheme = "https"
        case "ws":  comps.scheme = "http"
        default:    break // already http(s); leave it alone
        }
        return comps.url ?? endpoint
    }

    public var authURL: URL { httpOrigin.appendingPathComponent("auth") }
    public var infoURL: URL { httpOrigin.appendingPathComponent("info") }

    /// Final WebSocket URL including resume params when present.
    public var websocketURL: URL {
        var comps = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
            ?? URLComponents()
        comps.path = "/p/\(slug)/ws"
        var items: [URLQueryItem] = []
        if let id = resumeSession {
            items.append(URLQueryItem(name: "resumeSession", value: id))
        }
        if let seq = lastSeq {
            items.append(URLQueryItem(name: "lastSeq", value: String(seq)))
        }
        comps.queryItems = items.isEmpty ? nil : items
        return comps.url ?? endpoint
    }
}
