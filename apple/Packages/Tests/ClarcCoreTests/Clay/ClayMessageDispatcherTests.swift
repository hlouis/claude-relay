import Foundation
import Testing
@testable import ClarcCore

// Behavioural tests for the M2 dispatcher pump.

@Suite("ClayMessageDispatcher")
struct ClayMessageDispatcherTests {

    // MARK: - Path to s2c fixtures (same recipe as the round-trip suite)

    static let fixturesURL: URL = {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Clay/
            .deletingLastPathComponent()  // ClarcCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // <repo>/
            .appendingPathComponent("protocol/fixtures/s2c")
    }()

    static let s2cFixtures: [URL] = {
        (try? FileManager.default.contentsOfDirectory(
            at: fixturesURL, includingPropertiesForKeys: nil))
            .map { $0.filter { $0.pathExtension == "json" }
                     .sorted { $0.lastPathComponent < $1.lastPathComponent } }
        ?? []
    }()

    // MARK: - Recording receiver

    actor RecordingReceiver: ClayMessageReceiver {
        private(set) var messages: [ClayServerMessage] = []
        func receive(_ message: ClayServerMessage) {
            messages.append(message)
        }
    }

    // MARK: - Tests

    @Test("replays every s2c fixture through the dispatcher")
    func replaysAllS2CFixtures() async throws {
        #expect(!Self.s2cFixtures.isEmpty, "no s2c fixtures discovered")

        // Decode every fixture up front; this is what ClayConnection
        // would yield into its messages stream.
        let decoded: [ClayServerMessage] = try Self.s2cFixtures.map { url in
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(ClayServerMessage.self, from: data)
        }

        let (stream, cont) = AsyncThrowingStream<ClayServerMessage, Error>
            .makeStream()
        let receiver = RecordingReceiver()
        let dispatcher = ClayMessageDispatcher(source: stream, receiver: receiver)

        await dispatcher.start()
        for msg in decoded { cont.yield(msg) }
        cont.finish()
        try await dispatcher.wait()

        let received = await receiver.messages
        #expect(received.count == decoded.count)
        for (a, b) in zip(received, decoded) {
            #expect(a == b)
        }
    }

    @Test("stop() cancels the pump promptly")
    func stopCancelsPump() async throws {
        let (stream, cont) = AsyncThrowingStream<ClayServerMessage, Error>
            .makeStream()
        let receiver = RecordingReceiver()
        let dispatcher = ClayMessageDispatcher(source: stream, receiver: receiver)

        await dispatcher.start()
        await dispatcher.stop()

        // After stop, even if more messages arrive on the stream the
        // pump should not deliver them. Yield a couple, then close.
        cont.yield(.done(ClayServerMessage.Done(code: 0, seq: nil)))
        cont.finish()

        // Give any stale work a beat to (incorrectly) execute.
        try await Task.sleep(for: .milliseconds(50))

        let drained = await receiver.messages
        #expect(drained.isEmpty)
        let running = await dispatcher.isRunning
        #expect(running == false)
    }

    @Test("source error propagates out of wait()")
    func sourceErrorPropagates() async throws {
        struct Boom: Error, Equatable {}

        let (stream, cont) = AsyncThrowingStream<ClayServerMessage, Error>
            .makeStream()
        let receiver = RecordingReceiver()
        let dispatcher = ClayMessageDispatcher(source: stream, receiver: receiver)

        await dispatcher.start()
        cont.finish(throwing: Boom())

        await #expect(throws: Boom.self) {
            try await dispatcher.wait()
        }
    }

    @Test("normal stream end exits cleanly")
    func cleanStreamEnd() async throws {
        let (stream, cont) = AsyncThrowingStream<ClayServerMessage, Error>
            .makeStream()
        let receiver = RecordingReceiver()
        let dispatcher = ClayMessageDispatcher(source: stream, receiver: receiver)

        await dispatcher.start()
        cont.finish()
        try await dispatcher.wait()
        // No crash, no rethrow.
        let drained = await receiver.messages
        #expect(drained.isEmpty)
    }
}
