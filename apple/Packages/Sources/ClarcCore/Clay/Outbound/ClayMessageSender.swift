import Foundation

// Narrow protocol for sending a user message. Mirrors the
// ClayPermissionResponder (M5) and ClaySessionCommands (M6)
// pattern: exists so the input bar (M8.5) can be unit-tested
// with a recording mock without standing up a live
// `ClayConnection`. ClayConnection is the production conformer.
//
// Don't extend with non-message methods — for any other outbound
// traffic, take a `ClayConnection` directly.

public protocol ClayMessageSender: AnyObject, Sendable {
    func sendMessage(
        text: String?,
        images: [ClayImageAttachment]?,
        pastes: [String]?,
        clientMsgId: String?
    ) async throws
}

extension ClayConnection: ClayMessageSender {}
