import Foundation

// Connection lifecycle as exposed to the rest of the app.
//
// Two distinct "up" states matter:
//  - `.connected` — WebSocket transport is open (URLSession delegate's
//    didOpenWithProtocol fired) but the daemon hasn't yet sent the
//    `info` frame. UI should still show a loading indicator here.
//  - `.live` — `info` frame received and decoded; the project is ready.
//    Send-buttons enable, sidebar populates, etc.
//
// `client_count` may arrive between `.connected` and `.live`; that's
// expected and not an error. See PLAN.md M1 for the rationale.

public enum ClayConnectionStatus: Sendable, Equatable {
    case idle
    case connecting
    case connected
    case live
    case reconnecting(attempt: Int, nextDelayMs: Int)
    case failed(ClayConnectionFailure)

    public var isTerminalFailure: Bool {
        if case .failed = self { return true }
        return false
    }
}

// Why a connection ended. Drives both UI messaging and reconnect
// policy: `.authExpired` and `.authRejected` must NOT trigger another
// retry — they require user input. Everything else is fair game for
// reconnect.

public enum ClayConnectionFailure: Sendable, Equatable {
    case authExpired              // GET /info → 401 during auth re-probe
    case authRejected             // POST /auth → non-200
    case connectTimeout           // 3 s elapsed without didOpenWithProtocol
    case protocolMismatch(String) // info.protocolVersion ≠ "1" (post-M8)
    case transport(String)        // URLSession-level error (description only,
                                  // to keep the enum Sendable & Equatable)
    case closedByServer(code: Int, reason: String)
    case cancelled                // disconnect() called by app

    public var isAuth: Bool {
        switch self {
        case .authExpired, .authRejected: return true
        default: return false
        }
    }

    public var allowsReconnect: Bool {
        switch self {
        case .authExpired, .authRejected, .protocolMismatch, .cancelled:
            return false
        case .connectTimeout, .transport, .closedByServer:
            return true
        }
    }
}
