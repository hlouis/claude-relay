import Foundation
import Network

// Minimal in-process WebSocket peer for ClayConnection integration
// tests. Built on Network.framework with NWProtocolWebSocket so the
// Sec-WebSocket-Accept handshake is handled for us.
//
// NOT a full daemon mock — it does NOT speak HTTP, so it cannot serve
// /auth or /info. Cases that exercise those probes need a heavier
// mock; see PLAN M1.5.

final class WebSocketMockServer: @unchecked Sendable {

    private let listener: NWListener
    private let queue = DispatchQueue(label: "clay.ws-mock", qos: .userInitiated)

    private let lock = NSLock()
    private var _connections: [NWConnection] = []
    private var _onAccept: (@Sendable (Int) -> Void)?

    var connections: [NWConnection] {
        lock.lock(); defer { lock.unlock() }
        return _connections
    }

    /// Called on every newly-accepted (and ready) connection. The Int
    /// is the 1-based ordinal — useful to drive different behaviour
    /// for the first vs. second connection in reconnect tests.
    func setOnAccept(_ block: @escaping @Sendable (Int) -> Void) {
        lock.lock(); _onAccept = block; lock.unlock()
    }

    var port: Int {
        Int(listener.port?.rawValue ?? 0)
    }

    /// Build the URL string a client can use to connect.
    func websocketURLString(slug: String = "test") -> String {
        "ws://127.0.0.1:\(port)/p/\(slug)/ws"
    }

    init() throws {
        let opts = NWProtocolWebSocket.Options()
        opts.autoReplyPing = true
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.defaultProtocolStack.applicationProtocols
            .insert(opts, at: 0)

        self.listener = try NWListener(using: params, on: .any)
    }

    func start() async throws {
        let latch = OnceLatch()
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    if latch.fire() { cont.resume() }
                case .failed(let err):
                    if latch.fire() { cont.resume(throwing: err) }
                default:
                    break
                }
                _ = self
            }
            listener.newConnectionHandler = { [weak self] conn in
                self?.accept(conn)
            }
            listener.start(queue: queue)
        }
    }

    func stop() {
        listener.cancel()
        let active = connections
        for c in active { c.cancel() }
    }

    private func accept(_ conn: NWConnection) {
        lock.lock()
        _connections.append(conn)
        let ordinal = _connections.count
        let cb = _onAccept
        lock.unlock()

        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                cb?(ordinal)
                self.receiveLoop(on: conn)
            case .failed, .cancelled:
                break
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    private func receiveLoop(on conn: NWConnection) {
        conn.receiveMessage { [weak self] _, _, _, error in
            if error != nil { return }
            self?.receiveLoop(on: conn)
        }
    }

    // MARK: - Sending

    func sendText(_ text: String, to conn: NWConnection) {
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(
            identifier: "ws-text",
            metadata: [meta]
        )
        conn.send(
            content: Data(text.utf8),
            contentContext: ctx,
            isComplete: true,
            completion: .idempotent
        )
    }

    /// Send a server-side close. Triggers the client's onClose path.
    func close(_ conn: NWConnection, code: NWProtocolWebSocket.CloseCode = .protocolCode(.normalClosure)) {
        let meta = NWProtocolWebSocket.Metadata(opcode: .close)
        meta.closeCode = code
        let ctx = NWConnection.ContentContext(
            identifier: "ws-close",
            metadata: [meta]
        )
        conn.send(
            content: nil,
            contentContext: ctx,
            isComplete: true,
            completion: .idempotent
        )
    }
}

/// Listener that accepts a TCP connection and never speaks the WS
/// upgrade. Used to prove ClayConnection's 3-second connect-timeout
/// kicks in even when the server is unresponsive at the protocol layer.
final class StalledTCPListener: @unchecked Sendable {

    private let listener: NWListener
    private let queue = DispatchQueue(label: "clay.stall", qos: .userInitiated)

    init() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        self.listener = try NWListener(using: params, on: .any)
    }

    var port: Int { Int(listener.port?.rawValue ?? 0) }

    func websocketURLString(slug: String = "test") -> String {
        "ws://127.0.0.1:\(port)/p/\(slug)/ws"
    }

    func start() async throws {
        let latch = OnceLatch()
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if latch.fire() { cont.resume() }
                case .failed(let e):
                    if latch.fire() { cont.resume(throwing: e) }
                default: break
                }
            }
            listener.newConnectionHandler = { conn in
                // Accept the TCP layer; never reply. URLSession will sit
                // there waiting for the HTTP 101.
                conn.start(queue: DispatchQueue.global())
            }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }
}

// MARK: - OnceLatch

/// One-shot guard for "fire exactly once" callbacks; works inside
/// Sendable closures where mutating a captured `var` is forbidden.
final class OnceLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    /// Returns true exactly the first time it's called.
    func fire() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if fired { return false }
        fired = true
        return true
    }
}
