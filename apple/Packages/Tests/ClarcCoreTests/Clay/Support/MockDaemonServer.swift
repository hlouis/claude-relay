import Foundation
import Network
import CryptoKit

// In-process mock that speaks both HTTP and WebSocket on a single
// localhost port — enough to exercise the parts of ClayConnection
// that the WS-only `WebSocketMockServer` can't:
//
//   * `GET /info` returning 401 (drives `.failed(.authExpired)`).
//   * `POST /auth` setting a cookie (drives the first-connect PIN
//     path, even though no production tests need it yet).
//   * Capturing the WebSocket upgrade URL — including any
//     resumeSession/lastSeq query items — so reconnect-resume tests
//     can assert the actor wrote them onto the wire.
//
// Implementation: raw `NWConnection` per-accept, hand-rolled HTTP/1.1
// request parsing, hand-rolled WS handshake (RFC 6455 §1.3) and
// outbound framing (§5). Inbound WS frames are read into the void;
// we never need to interpret them in tests.
//
// NOT a daemon — only the surfaces the connection actor probes.

final class MockDaemonServer: @unchecked Sendable {

    // MARK: - Public configuration

    private let lock = NSLock()
    private var _infoStatus: Int = 200
    private var _authStatus: Int = 200
    private var _onUpgrade: (@Sendable (URL) -> Void)?
    private var _onWSAccepted: (@Sendable (Int, NWConnection) -> Void)?

    var infoStatus: Int {
        get { lock.lock(); defer { lock.unlock() }; return _infoStatus }
        set { lock.lock(); _infoStatus = newValue; lock.unlock() }
    }

    var authStatus: Int {
        get { lock.lock(); defer { lock.unlock() }; return _authStatus }
        set { lock.lock(); _authStatus = newValue; lock.unlock() }
    }

    /// Called once per accepted WS upgrade with the requested URL
    /// (path + query). Use to assert reconnect query items.
    func setOnUpgrade(_ block: @escaping @Sendable (URL) -> Void) {
        lock.lock(); _onUpgrade = block; lock.unlock()
    }

    /// Called after a successful WS handshake, with a 1-based ordinal
    /// and the held connection. Tests use this to send canned frames.
    func setOnWSAccepted(_ block: @escaping @Sendable (Int, NWConnection) -> Void) {
        lock.lock(); _onWSAccepted = block; lock.unlock()
    }

    // MARK: - Listener

    private let listener: NWListener
    private let queue = DispatchQueue(label: "clay.mock-daemon", qos: .userInitiated)
    private var wsOrdinal: Int = 0

    var port: Int { Int(listener.port?.rawValue ?? 0) }
    func websocketURLString(slug: String = "test") -> String {
        "ws://127.0.0.1:\(port)/p/\(slug)/ws"
    }

    init() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        self.listener = try NWListener(using: params, on: .any)
    }

    func start() async throws {
        let latch = OnceLatch()
        try await withCheckedThrowingContinuation {
            (cont: CheckedContinuation<Void, Error>) in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if latch.fire() { cont.resume() }
                case .failed(let e):
                    if latch.fire() { cont.resume(throwing: e) }
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] conn in
                self?.accept(conn)
            }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }

    // MARK: - Per-connection HTTP handling

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        readRequest(on: conn, accumulated: Data())
    }

    private func readRequest(on conn: NWConnection, accumulated: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) {
            [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error { _ = error; conn.cancel(); return }
            var buffer = accumulated
            if let data { buffer.append(data) }

            // Look for end-of-headers.
            if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = buffer.prefix(upTo: range.lowerBound)
                self.handleHeaders(headerData, on: conn)
                return
            }

            // Cap pathological growth.
            if buffer.count > 64 * 1024 || isComplete {
                conn.cancel()
                return
            }
            self.readRequest(on: conn, accumulated: buffer)
        }
    }

    private func handleHeaders(_ data: Data, on conn: NWConnection) {
        guard let raw = String(data: data, encoding: .utf8) else {
            conn.cancel(); return
        }
        let lines = raw.split(separator: "\r\n", omittingEmptySubsequences: false)
            .map(String.init)
        guard let first = lines.first else { conn.cancel(); return }
        let parts = first.split(separator: " ", maxSplits: 2).map(String.init)
        guard parts.count >= 2 else { conn.cancel(); return }
        let method = parts[0]
        let target = parts[1]

        // Headers (case-insensitive lookup).
        var headers: [String: String] = [:]
        for line in lines.dropFirst() where !line.isEmpty {
            if let idx = line.firstIndex(of: ":") {
                let name = String(line[..<idx]).lowercased()
                var value = String(line[line.index(after: idx)...])
                if value.hasPrefix(" ") { value.removeFirst() }
                headers[name] = value
            }
        }

        let path = target.split(separator: "?").first.map(String.init) ?? target

        switch (method, path) {
        case ("GET", "/info"):
            sendSimpleResponse(status: infoStatus, on: conn, close: true)
        case ("POST", "/auth"):
            sendAuthResponse(status: authStatus, on: conn)
        case ("GET", let p) where p.hasPrefix("/p/") && p.hasSuffix("/ws"):
            handleWSUpgrade(target: target, headers: headers, on: conn)
        default:
            sendSimpleResponse(status: 404, on: conn, close: true)
        }
    }

    // MARK: - HTTP responses

    private func sendSimpleResponse(status: Int, on conn: NWConnection, close: Bool) {
        let body =
            "HTTP/1.1 \(status) \(Self.reason(status))\r\n" +
            "Content-Length: 0\r\n" +
            "Connection: close\r\n" +
            "\r\n"
        conn.send(content: Data(body.utf8), completion: .contentProcessed { _ in
            if close { conn.cancel() }
        })
    }

    private func sendAuthResponse(status: Int, on conn: NWConnection) {
        let setCookie = status == 200
            ? "Set-Cookie: relay_auth=test; Path=/; HttpOnly\r\n"
            : ""
        let body =
            "HTTP/1.1 \(status) \(Self.reason(status))\r\n" +
            setCookie +
            "Content-Length: 0\r\n" +
            "Connection: close\r\n" +
            "\r\n"
        conn.send(content: Data(body.utf8), completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    // MARK: - WebSocket upgrade

    private func handleWSUpgrade(
        target: String,
        headers: [String: String],
        on conn: NWConnection
    ) {
        guard
            headers["upgrade"]?.lowercased() == "websocket",
            let key = headers["sec-websocket-key"]
        else {
            sendSimpleResponse(status: 400, on: conn, close: true)
            return
        }

        let accept = Self.websocketAccept(for: key)
        let response =
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: \(accept)\r\n" +
            "\r\n"

        // Reconstruct the URL the client requested so tests can inspect
        // its query items.
        let requestURL = URL(string: "ws://127.0.0.1:\(port)\(target)")
            ?? URL(string: "ws://127.0.0.1:\(port)/p/test/ws")!

        lock.lock()
        wsOrdinal += 1
        let ordinal = wsOrdinal
        let onUpgrade = _onUpgrade
        let onAccepted = _onWSAccepted
        lock.unlock()

        conn.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] err in
            if err != nil { conn.cancel(); return }
            onUpgrade?(requestURL)
            onAccepted?(ordinal, conn)
            self?.consumeWSFrames(on: conn)
        })
    }

    /// Drain inbound WS frames so the connection doesn't backpressure.
    /// Bytes are not interpreted — tests only need server-to-client
    /// behaviour.
    private func consumeWSFrames(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) {
            [weak self] _, _, isComplete, error in
            if error != nil || isComplete { conn.cancel(); return }
            self?.consumeWSFrames(on: conn)
        }
    }

    // MARK: - Server-side frame I/O (RFC 6455 §5)

    func sendText(_ text: String, on conn: NWConnection) {
        let frame = Self.encodeServerTextFrame(text)
        conn.send(content: frame, completion: .contentProcessed { _ in })
    }

    /// Send a close frame and tear down the connection.
    func close(_ conn: NWConnection, code: UInt16 = 1000) {
        let frame = Self.encodeServerCloseFrame(code: code)
        conn.send(content: frame, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    // MARK: - Helpers

    private static func encodeServerTextFrame(_ text: String) -> Data {
        var data = Data()
        let payload = Data(text.utf8)
        data.append(0x81) // FIN=1, opcode=0x1 (text)
        let len = payload.count
        if len < 126 {
            data.append(UInt8(len)) // mask=0
        } else if len <= 0xFFFF {
            data.append(126)
            data.append(UInt8((len >> 8) & 0xFF))
            data.append(UInt8(len & 0xFF))
        } else {
            data.append(127)
            var be = UInt64(len).bigEndian
            withUnsafeBytes(of: &be) { data.append(contentsOf: $0) }
        }
        data.append(payload)
        return data
    }

    private static func encodeServerCloseFrame(code: UInt16) -> Data {
        var data = Data()
        data.append(0x88) // FIN=1, opcode=0x8 (close)
        data.append(0x02) // payload length 2, mask=0
        data.append(UInt8((code >> 8) & 0xFF))
        data.append(UInt8(code & 0xFF))
        return data
    }

    private static func websocketAccept(for key: String) -> String {
        let guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let digest = Insecure.SHA1.hash(data: Data((key + guid).utf8))
        return Data(digest).base64EncodedString()
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: "OK"
        case 401: "Unauthorized"
        case 403: "Forbidden"
        case 404: "Not Found"
        default: "OK"
        }
    }
}
