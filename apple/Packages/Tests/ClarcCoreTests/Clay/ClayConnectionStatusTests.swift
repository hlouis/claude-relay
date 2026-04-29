import Testing
@testable import ClarcCore

// Pure-logic tests for the connection status enum and its failure
// classification — drives reconnect policy in ClayConnection.

@Suite("ClayConnectionStatus / Failure")
struct ClayConnectionStatusTests {

    @Test("auth failures are terminal")
    func authFailuresTerminal() {
        #expect(ClayConnectionFailure.authExpired.allowsReconnect == false)
        #expect(ClayConnectionFailure.authRejected.allowsReconnect == false)
        #expect(ClayConnectionFailure.authExpired.isAuth)
        #expect(ClayConnectionFailure.authRejected.isAuth)
    }

    @Test("transport-class failures permit reconnect")
    func transportFailuresRetry() {
        #expect(ClayConnectionFailure.connectTimeout.allowsReconnect)
        #expect(ClayConnectionFailure.transport("eof").allowsReconnect)
        #expect(ClayConnectionFailure.closedByServer(code: 1006, reason: "")
            .allowsReconnect)
    }

    @Test("explicit cancel never retries")
    func cancelTerminal() {
        #expect(ClayConnectionFailure.cancelled.allowsReconnect == false)
        #expect(ClayConnectionFailure.cancelled.isAuth == false)
    }

    @Test("protocol mismatch is terminal")
    func protocolMismatchTerminal() {
        #expect(ClayConnectionFailure.protocolMismatch("v2").allowsReconnect == false)
    }

    @Test("isTerminalFailure flag")
    func isTerminalFailureFlag() {
        #expect(ClayConnectionStatus.idle.isTerminalFailure == false)
        #expect(ClayConnectionStatus.connecting.isTerminalFailure == false)
        #expect(ClayConnectionStatus.connected.isTerminalFailure == false)
        #expect(ClayConnectionStatus.live.isTerminalFailure == false)
        #expect(ClayConnectionStatus.reconnecting(attempt: 1, nextDelayMs: 1000)
            .isTerminalFailure == false)
        #expect(ClayConnectionStatus.failed(.cancelled).isTerminalFailure)
    }
}
