import Foundation

// Pump loop between `ClayConnection`'s message stream and a
// `ClayMessageReceiver`. Owns no state of its own — all routing and
// mutation lives in the receiver.
//
// Lifecycle:
//   * `init` wires up the source and receiver but does NOT start
//     pumping. Call `start()` to begin.
//   * `start()` spawns a single Task that drains the stream until it
//     finishes or `stop()` is called.
//   * `stop()` cancels the pump task. The underlying stream is not
//     touched (the connection owns its lifetime).
//   * `wait()` resolves when the pump exits cleanly or with error.
//
// Forward-compat policy: decode errors and unknown message types are
// the connection's concern — by the time messages reach the
// dispatcher they are already typed as `ClayServerMessage`. If the
// stream throws, the pump exits and `wait()` rethrows. Reconnect
// policy is the connection's job, not the dispatcher's.

public actor ClayMessageDispatcher {

    public typealias Source = AsyncThrowingStream<ClayServerMessage, Error>

    private let source: Source
    private let receiver: any ClayMessageReceiver
    private var pump: Task<Void, Error>?

    public init(source: Source, receiver: any ClayMessageReceiver) {
        self.source = source
        self.receiver = receiver
    }

    /// Start draining the source. Idempotent — second call is a no-op
    /// while a previous pump is still running.
    public func start() {
        if pump != nil { return }
        let source = self.source
        let receiver = self.receiver
        pump = Task.detached(priority: .userInitiated) {
            for try await message in source {
                if Task.isCancelled { break }
                await receiver.receive(message)
            }
        }
    }

    /// Cancel the pump task. The source is not closed.
    public func stop() {
        pump?.cancel()
        pump = nil
    }

    /// Resolve when the pump has finished, rethrowing any stream error.
    /// Returns immediately if the pump never ran or has already exited.
    public func wait() async throws {
        guard let pump else { return }
        do {
            try await pump.value
        } catch is CancellationError {
            return
        }
    }

    /// True while a pump task is in flight.
    public var isRunning: Bool { pump != nil && !(pump?.isCancelled ?? true) }
}
