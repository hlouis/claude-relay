import Foundation

// MARK: - Public errors

public enum ClayConnectionError: Error, Sendable, Equatable {
    /// `send(_:)` was called while the transport is not open.
    case notConnected
    /// JSON encoding of an outbound message failed.
    case encodingFailed
}

// MARK: - ClayConnection

/// WebSocket connection to a Clay daemon.
///
/// Mirrors the strategies of the daemon's bundled web client
/// (`daemon/lib/public/app.js`):
///
/// * Cookie-based auth via a per-actor in-memory `HTTPCookieStorage`;
///   `POST /auth` once on first connect when a PIN is supplied; the
///   resulting `relay_auth` cookie is auto-attached to the WS upgrade
///   and to the `/info` re-probe before each reconnect.
/// * Two distinct "up" states: `.connected` on the URLSession's
///   `didOpenWithProtocol` callback, then `.live` once the daemon's
///   `info` frame arrives. `client_count` and other frames may slip
///   between the two — that's expected.
/// * 3-second connect timeout (`Task.sleep` race against
///   `didOpenWithProtocol`).
/// * Reconnect backoff: 1 000 ms → ×1.5 → 10 000 ms cap, reset on a
///   successful open. Before each reconnect, `GET /info`; a 401 there
///   terminates with `.failed(.authExpired)` and stops the loop.
/// * No outbound queue: `send(_:)` throws when offline.
///
/// The actor owns one `URLSession` for its entire lifetime so that
/// cookies persist across reconnect attempts. `disconnect()` invalidates
/// it and finishes both streams.
public actor ClayConnection {

    // MARK: - Tunables (mirror web client)

    private static let connectTimeoutSeconds: Double = 3
    private static let initialReconnectMs: Int = 1_000
    private static let reconnectMultiplier: Double = 1.5
    private static let reconnectCapMs: Int = 10_000

    // MARK: - Public surface

    public nonisolated let messages: AsyncThrowingStream<ClayServerMessage, Error>
    public nonisolated let statusUpdates: AsyncStream<ClayConnectionStatus>

    public private(set) var status: ClayConnectionStatus = .idle {
        didSet { statusContinuation.yield(status) }
    }

    public var config: ClayConnectionConfig { configuration }

    // MARK: - Private state

    private let messageContinuation: AsyncThrowingStream<ClayServerMessage, Error>.Continuation
    private let statusContinuation: AsyncStream<ClayConnectionStatus>.Continuation

    private var configuration: ClayConnectionConfig
    private let session: URLSession
    private let delegate: ClayWSDelegate

    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var connectTimeout: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?

    private var reconnectAttempt: Int = 0
    private var reconnectDelayMs: Int = ClayConnection.initialReconnectMs
    private var didPostAuth: Bool = false

    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    // MARK: - Init

    public init(config: ClayConnectionConfig) {
        self.configuration = config

        let (mStream, mCont) = AsyncThrowingStream<ClayServerMessage, Error>.makeStream()
        self.messages = mStream
        self.messageContinuation = mCont

        let (sStream, sCont) = AsyncStream<ClayConnectionStatus>.makeStream()
        self.statusUpdates = sStream
        self.statusContinuation = sCont

        let urlConfig = URLSessionConfiguration.ephemeral
        urlConfig.httpCookieAcceptPolicy = .always
        urlConfig.httpShouldSetCookies = true
        urlConfig.timeoutIntervalForRequest = 30
        urlConfig.waitsForConnectivity = false

        let d = ClayWSDelegate()
        self.delegate = d
        self.session = URLSession(configuration: urlConfig, delegate: d, delegateQueue: nil)

        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()

        // Wire delegate → actor. Weak self so URLSession (which strongly
        // retains the delegate until invalidate) cannot keep us alive.
        d.onOpen = { [weak self] in
            Task { await self?.handleDidOpen() }
        }
        d.onClose = { [weak self] code, reason in
            Task { await self?.handleDidClose(code: code, reason: reason) }
        }

        sCont.yield(.idle)
    }

    deinit {
        // Belt-and-suspenders: if the consumer forgot to disconnect,
        // make sure the session lets go.
        session.invalidateAndCancel()
        messageContinuation.finish()
        statusContinuation.finish()
    }

    // MARK: - Public API

    /// Open the connection. Idempotent: ignored unless currently `.idle`.
    public func connect() async {
        guard case .idle = status else { return }
        await runAttempt(isReconnect: false)
    }

    /// Send a client message. Throws `notConnected` unless transport
    /// is currently `.connected` or `.live`.
    public func send(_ message: ClayClientMessage) async throws {
        switch status {
        case .connected, .live: break
        default: throw ClayConnectionError.notConnected
        }
        guard let task else { throw ClayConnectionError.notConnected }
        let data = try encoder.encode(message)
        guard let s = String(data: data, encoding: .utf8) else {
            throw ClayConnectionError.encodingFailed
        }
        try await task.send(.string(s))
    }

    /// Update the resume cursor (called by M2/M4 dispatcher as `seq`
    /// values arrive). Takes effect on the next connect attempt.
    public func updateResume(sessionId: String?, lastSeq: Int?) {
        configuration.resumeSession = sessionId
        configuration.lastSeq = lastSeq
    }

    /// Permanently shut down the connection. Both streams finish.
    public func disconnect() async {
        cancelInFlight(includingReconnect: true)
        if !status.isTerminalFailure {
            status = .failed(.cancelled)
        }
        finishStreams()
        session.invalidateAndCancel()
    }

    // MARK: - Connect attempt

    private func runAttempt(isReconnect: Bool) async {
        // Pre-flight HTTP: /auth on first attempt with PIN, /info on reconnect.
        do {
            if isReconnect {
                try await probeInfo()
            } else if let pin = configuration.pin, !didPostAuth {
                try await postAuth(pin: pin)
                didPostAuth = true
            }
        } catch let failure as ClayConnectionFailure {
            // Treat thrown failures as authoritative. Never retry on auth errors.
            terminate(with: failure)
            return
        } catch {
            // Non-auth pre-flight error: treat as transport, allow retry.
            scheduleReconnect(after: .transport(String(describing: error)))
            return
        }

        status = .connecting

        let url = configuration.websocketURL
        var req = URLRequest(url: url)
        req.timeoutInterval = 30
        let newTask = session.webSocketTask(with: req)
        self.task = newTask

        // 3-second connect timeout — wins if didOpenWithProtocol stalls.
        connectTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.connectTimeoutSeconds))
            guard !Task.isCancelled else { return }
            await self?.handleConnectTimeout()
        }

        newTask.resume()
        startReceiveLoop(task: newTask)
    }

    // MARK: - Delegate hops

    private func handleDidOpen() {
        connectTimeout?.cancel()
        connectTimeout = nil
        reconnectAttempt = 0
        reconnectDelayMs = Self.initialReconnectMs

        switch status {
        case .connecting, .reconnecting:
            status = .connected
        case .live:
            // The `info` frame raced ahead of this delegate callback —
            // we're already live. Don't downgrade.
            break
        default:
            // Stale callback after we already moved on; ignore.
            break
        }
    }

    private func handleDidClose(code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let reasonStr = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        cancelInFlight(includingReconnect: false)
        if case .failed = status { return }
        scheduleReconnect(after: .closedByServer(code: code.rawValue, reason: reasonStr))
    }

    private func handleConnectTimeout() {
        // Only act if we're still waiting on open.
        switch status {
        case .connecting, .reconnecting: break
        default: return
        }
        cancelInFlight(includingReconnect: false)
        scheduleReconnect(after: .connectTimeout)
    }

    // MARK: - Receive loop

    private func startReceiveLoop(task: URLSessionWebSocketTask) {
        receiveLoop = Task { [weak self] in
            await self?.receiveLoopBody(task: task)
        }
    }

    private func receiveLoopBody(task: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let frame = try await task.receive()
                let data: Data
                switch frame {
                case .data(let d): data = d
                case .string(let s): data = Data(s.utf8)
                @unknown default: continue
                }
                handleFrame(data)
            } catch {
                handleReceiveError(error)
                return
            }
        }
    }

    private func handleFrame(_ data: Data) {
        let decoded: ClayServerMessage
        do {
            decoded = try decoder.decode(ClayServerMessage.self, from: data)
        } catch {
            // Forward-compat: unknown / malformed frames are dropped here.
            // Dispatcher (M2) will surface a structured log when it has
            // enough context to truncate offending bytes.
            return
        }

        // First `info` flips us to `.live`. We tolerate the race where
        // the frame arrives on the actor before didOpenWithProtocol —
        // any non-live, non-terminal state is promoted directly.
        if case .info = decoded {
            switch status {
            case .connecting, .connected, .reconnecting:
                status = .live
            case .idle, .live, .failed:
                break
            }
        }
        messageContinuation.yield(decoded)
    }

    private func handleReceiveError(_ error: Error) {
        cancelTaskAndTimeout()
        if case .failed = status { return }
        scheduleReconnect(after: .transport(String(describing: error)))
    }

    // MARK: - Reconnect

    private func scheduleReconnect(after failure: ClayConnectionFailure) {
        guard failure.allowsReconnect else {
            terminate(with: failure)
            return
        }
        reconnectAttempt += 1
        let delay = reconnectDelayMs
        status = .reconnecting(attempt: reconnectAttempt, nextDelayMs: delay)
        reconnectDelayMs = min(
            Int((Double(reconnectDelayMs) * Self.reconnectMultiplier).rounded()),
            Self.reconnectCapMs
        )

        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delay))
            guard !Task.isCancelled else { return }
            await self?.runAttempt(isReconnect: true)
        }
    }

    private func terminate(with failure: ClayConnectionFailure) {
        cancelInFlight(includingReconnect: true)
        status = .failed(failure)
        finishStreams()
    }

    // MARK: - Teardown helpers

    private func cancelTaskAndTimeout() {
        connectTimeout?.cancel(); connectTimeout = nil
        receiveLoop?.cancel(); receiveLoop = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func cancelInFlight(includingReconnect: Bool) {
        cancelTaskAndTimeout()
        if includingReconnect {
            reconnectTask?.cancel()
            reconnectTask = nil
        }
    }

    private func finishStreams() {
        messageContinuation.finish()
        statusContinuation.finish()
    }

    // MARK: - HTTP pre-flight

    private func postAuth(pin: String) async throws {
        var req = URLRequest(url: configuration.authURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["pin": pin])

        let (_, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw ClayConnectionFailure.transport("non-HTTP response from /auth")
        }
        guard (200...299).contains(http.statusCode) else {
            throw ClayConnectionFailure.authRejected
        }
    }

    private func probeInfo() async throws {
        var req = URLRequest(url: configuration.infoURL)
        req.httpMethod = "GET"

        let (_, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw ClayConnectionFailure.transport("non-HTTP response from /info")
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw ClayConnectionFailure.authExpired
        }
        if !(200...299).contains(http.statusCode) {
            throw ClayConnectionFailure.transport("/info \(http.statusCode)")
        }
    }
}

// MARK: - Failure conformance to Error

extension ClayConnectionFailure: Error {}

// MARK: - URLSession delegate bridge

/// Reference-typed bridge so URLSession's strong reference to the
/// delegate doesn't pin the actor in memory. Closures capture the
/// actor weakly.
final class ClayWSDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    var onOpen: (@Sendable () -> Void)?
    var onClose: (@Sendable (URLSessionWebSocketTask.CloseCode, Data?) -> Void)?

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        onOpen?()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        onClose?(closeCode, reason)
    }
}
