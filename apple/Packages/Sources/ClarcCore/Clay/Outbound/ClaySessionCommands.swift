import Foundation

// Narrow protocol over the four session-lifecycle outbound helpers
// from M3. Mirrors `ClayPermissionResponder` (M5): exists so the
// sidebar view can be unit-tested with a recording mock without
// standing up a live `ClayConnection`. ClayConnection is the
// production conformer.
//
// Don't extend this protocol with non-lifecycle methods — for any
// other outbound traffic, take a `ClayConnection` directly.

public protocol ClaySessionCommands: AnyObject, Sendable {
    func newSession(visibility: ClaySessionVisibility?) async throws
    func switchSession(id: Int, lastSeq: Int?) async throws
    func deleteSession(id: Int) async throws
    func renameSession(id: Int, title: String) async throws
}

extension ClayConnection: ClaySessionCommands {}

// MARK: - lastSeq lookup for switch_session

extension ClayProjectState {
    /// `lastSeq` for the given session, or `nil` if the session has
    /// never received a seq-bearing event. Used by sidebar selection
    /// to feed `switch_session` so the daemon resumes incremental
    /// replay from the right cursor — note this is the *target*
    /// session's cursor, not the currently-active session's.
    public func lastSeqForResume(sessionId id: Int) -> Int? {
        sessionStates[id]?.lastSeq
    }
}
