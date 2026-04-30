import Foundation
import Observation
import ClarcCore

// Top-level coordinator for the Clay flow (M9). Owns exactly one
// triplet — connection, dispatcher, project state — for the active
// daemon session, and exposes a tiny mode enum the main window
// switches over.
//
// Lifecycle:
//   - .disconnected: idle, no triplet. ClayConnectScreen is shown.
//   - .connecting:   triplet exists, awaiting `info` frame. Loading
//                    state in the main window.
//   - .live:         triplet up. Three-pane chat is interactive.
//   - .failed(why):  triplet torn down, connect screen reappears
//                    with an inline error. Auth failures don't
//                    auto-reconnect; transport errors surface here
//                    only after M1's reconnect policy gives up
//                    (see ClayConnectionFailure.allowsReconnect).
//
// This class deliberately does NOT mirror every status into
// `mode`. M4's `ClayProjectState.connection` field carries the
// fine-grained transport state for any badge / spinner the chat
// view wants. The shell mode is just the gate between
// "show connect form" vs "show chat".

@MainActor
@Observable
final class ClayShell {

    enum Mode: Equatable {
        case disconnected
        case connecting
        case live
        case failed(ClayConnectionFailure)
    }

    private(set) var mode: Mode = .disconnected

    // The triplet. Nil while disconnected.
    private(set) var connection: ClayConnection?
    private(set) var dispatcher: ClayMessageDispatcher?
    private(set) var project: ClayProjectState?

    let store: ClayConnectionsStore

    private var statusObserver: Task<Void, Never>?

    init(store: ClayConnectionsStore) {
        self.store = store
    }

    // MARK: - Connect / disconnect

    func connect(config: ClayConnectionConfig) async {
        // Tear down any prior session before standing up a new one.
        await disconnect()

        let connection = ClayConnection(config: config)
        let project = ClayProjectState()
        project.connectionRef = connection
        let dispatcher = ClayMessageDispatcher(
            source: connection.messages,
            receiver: project
        )

        self.connection = connection
        self.dispatcher = dispatcher
        self.project = project
        self.mode = .connecting

        // Drain status updates into mode + the project mirror.
        let updates = connection.statusUpdates
        statusObserver = Task { [weak self] in
            for await status in updates {
                guard let self else { return }
                self.handle(status)
            }
        }

        await dispatcher.start()
        await connection.connect()
    }

    func disconnect() async {
        statusObserver?.cancel()
        statusObserver = nil

        if let dispatcher {
            await dispatcher.stop()
        }
        if let connection {
            await connection.disconnect()
        }

        connection = nil
        dispatcher = nil
        project = nil
        mode = .disconnected
    }

    // MARK: - Status handling

    private func handle(_ status: ClayConnectionStatus) {
        // Mirror onto the project state so chat-view badges can render
        // .reconnecting / .connected without having to subscribe to
        // the connection separately.
        project?.connection = status

        switch status {
        case .live:
            mode = .live
        case .failed(let failure):
            // For auth failures, drop back to the connect screen so
            // the user can re-enter credentials. Transport-class
            // failures only land here after M1's reconnect loop
            // gave up — same end-state from the shell's perspective.
            mode = .failed(failure)
            // The connection will not reconnect on its own from a
            // .failed state; clean up the actor reference so a fresh
            // connect() rebuilds the triplet.
            Task { [weak self] in
                guard let self else { return }
                self.statusObserver?.cancel()
                self.statusObserver = nil
                if let dispatcher = self.dispatcher {
                    await dispatcher.stop()
                }
                self.connection = nil
                self.dispatcher = nil
                self.project = nil
            }
        case .idle, .connecting, .connected, .reconnecting:
            // Stay in current mode. Specifically don't downgrade
            // .live → .connecting on a transient blip — M4 owns the
            // transient badge.
            break
        }
    }
}

// PermissionItem is fed to `.sheet(item:)` in ClayMainWindow.
// `id` already exists on the struct (M4); just add the conformance.
extension ClayChatItem.PermissionItem: Identifiable {}
