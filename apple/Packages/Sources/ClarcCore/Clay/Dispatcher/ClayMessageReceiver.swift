import Foundation

// Sink for decoded server messages, owned by ClayMessageDispatcher.
//
// One method on purpose: routing happens inside the receiver via
// `switch message`, not inside the dispatcher. This keeps the
// dispatcher dumb (a pure pump) and lets `ClayProjectState` (M4)
// handle every variant in one place where Swift's exhaustiveness
// check ensures no Tier 1 case is silently dropped.
//
// Implementers should NOT block — slow handlers backpressure the
// connection's stream and delay subsequent frames. State mutations
// belong on the relevant actor (typically MainActor for UI state),
// non-trivial work should be dispatched off-actor.

public protocol ClayMessageReceiver: AnyObject, Sendable {
    func receive(_ message: ClayServerMessage) async
}
