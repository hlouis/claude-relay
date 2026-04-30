import Testing
import Foundation
@testable import ClarcCore

// Unit tests for the M7 connect-screen persistence layer. The view
// layer is not part of the SPM package; these tests cover the
// store's UserDefaults + Keychain coordination via an in-memory
// keychain mock and a per-test transient UserDefaults suite.

private func makeFixture(suite: String = "test-\(UUID().uuidString)") -> (ClayConnectionsStore, ClayInMemoryKeychainStore, UserDefaults) {
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let keychain = ClayInMemoryKeychainStore()
    let store = ClayConnectionsStore(
        defaults: defaults,
        keychain: keychain,
        recentsKey: "test.recents"
    )
    return (store, keychain, defaults)
}

@Suite("ClayConnectionsStore")
struct ClayConnectionsStoreTests {

    @Test("save then recents returns the entry; pin round-trips through the keychain")
    func basicRoundTrip() throws {
        let (store, keychain, _) = makeFixture()
        let url = "wss://localhost:2635/p/demo/ws"
        try store.save(url: url, pin: "1234")

        let recents = store.recents()
        #expect(recents.count == 1)
        #expect(recents[0].url == url)
        #expect(try store.pin(for: url) == "1234")
        #expect(try keychain.read(account: url) == "1234")
    }

    @Test("re-saving the same URL bumps lastUsed without duplicating the entry")
    func resaveBumpsTimestamp() throws {
        let (store, _, _) = makeFixture()
        let url = "wss://h:1/p/s/ws"
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        try store.save(url: url, pin: "old", now: t0)

        let t1 = t0.addingTimeInterval(60)
        try store.save(url: url, pin: "new", now: t1)

        let recents = store.recents()
        #expect(recents.count == 1)
        #expect(recents[0].lastUsed == t1)
        #expect(try store.pin(for: url) == "new")
    }

    @Test("recents() returns most-recent-first")
    func sortOrder() throws {
        let (store, _, _) = makeFixture()
        let base = Date(timeIntervalSince1970: 1_000_000)
        try store.save(url: "wss://a:1/p/s/ws", pin: nil, now: base)
        try store.save(url: "wss://b:1/p/s/ws", pin: nil, now: base.addingTimeInterval(60))
        try store.save(url: "wss://c:1/p/s/ws", pin: nil, now: base.addingTimeInterval(30))

        let recents = store.recents().map(\.url)
        #expect(recents == ["wss://b:1/p/s/ws", "wss://c:1/p/s/ws", "wss://a:1/p/s/ws"])
    }

    @Test("nil or empty pin clears any prior keychain entry")
    func emptyPinDeletesKeychain() throws {
        let (store, keychain, _) = makeFixture()
        let url = "wss://h:1/p/s/ws"
        try store.save(url: url, pin: "secret")
        #expect(try keychain.read(account: url) == "secret")

        // Re-save with nil — daemon now has no PIN.
        try store.save(url: url, pin: nil)
        #expect(try keychain.read(account: url) == nil)
        #expect(try store.pin(for: url) == nil)

        // Re-save with empty string — same effect.
        try store.save(url: url, pin: "another")
        try store.save(url: url, pin: "")
        #expect(try keychain.read(account: url) == nil)
    }

    @Test("delete removes both the recents entry and the keychain item")
    func deleteClearsBoth() throws {
        let (store, keychain, _) = makeFixture()
        let url = "wss://h:1/p/s/ws"
        try store.save(url: url, pin: "x")

        try store.delete(url: url)
        #expect(store.recents().isEmpty)
        #expect(try keychain.read(account: url) == nil)
    }

    @Test("ClayConnectionConfig.parse accepts valid stored URLs and rejects malformed ones")
    func reusesM1Parser() {
        // Sanity: the connect screen will hand the raw URL to M1's
        // existing parser. Don't drift away from this contract.
        #expect((try? ClayConnectionConfig(fullWebSocketURL: "wss://localhost:2635/p/demo/ws")) != nil)
        #expect((try? ClayConnectionConfig(fullWebSocketURL: "http://nope.com/p/x/ws")) == nil)
        #expect((try? ClayConnectionConfig(fullWebSocketURL: "wss://localhost:2635/")) == nil)
    }
}
