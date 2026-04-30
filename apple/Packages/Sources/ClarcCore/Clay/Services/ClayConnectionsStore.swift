import Foundation

// Persistence for the connect screen (M7).
//
// Two-tier storage:
//   - UserDefaults  → list of recent WS URLs + last-used timestamp.
//                     Cheap, plain text, fine for non-secret data.
//   - Keychain      → the PIN per URL, when non-empty.
//                     Tokens are secrets; never write them to defaults.
//
// `ClayKeychainStore` is the test seam — production wires the real
// `ClaySystemKeychainStore` (separate file, depends on Security.framework);
// tests can pass an in-memory mock.

// MARK: - Recent connection record

public struct ClayRecentConnection: Codable, Sendable, Equatable, Identifiable {
    /// Full WebSocket URL string the user originally pasted, e.g.
    /// `wss://host:port/p/<slug>/ws`. Used as the Keychain account
    /// key for the matching PIN, and as the unique identity.
    public let url: String
    public var lastUsed: Date

    public var id: String { url }

    public init(url: String, lastUsed: Date = .init()) {
        self.url = url
        self.lastUsed = lastUsed
    }
}

// MARK: - Keychain abstraction

public protocol ClayKeychainStore: AnyObject, Sendable {
    func read(account: String) throws -> String?
    func write(account: String, value: String) throws
    func delete(account: String) throws
}

// MARK: - Store

/// Coordinates the recent-connection list (UserDefaults) with the
/// per-URL PIN (Keychain). Stateless above the two backing stores.
public final class ClayConnectionsStore: @unchecked Sendable {

    public enum StoreError: Error, Equatable, Sendable {
        case decodeFailed
    }

    private let defaults: UserDefaults
    private let keychain: ClayKeychainStore
    private let recentsKey: String

    public init(
        defaults: UserDefaults = .standard,
        keychain: ClayKeychainStore,
        recentsKey: String = "com.idealapp.Clarc.clay.recents"
    ) {
        self.defaults = defaults
        self.keychain = keychain
        self.recentsKey = recentsKey
    }

    // MARK: - Recents

    /// All recent connections, sorted most-recent-first.
    public func recents() -> [ClayRecentConnection] {
        guard let data = defaults.data(forKey: recentsKey) else { return [] }
        guard let list = try? JSONDecoder().decode([ClayRecentConnection].self, from: data) else {
            return []
        }
        return list.sorted { $0.lastUsed > $1.lastUsed }
    }

    /// Add or update a recent. The PIN is written to Keychain when
    /// non-nil and non-empty; passing nil/empty deletes any prior PIN
    /// for this URL (the user may have rotated to a no-auth daemon).
    public func save(url: String, pin: String?, now: Date = .init()) throws {
        var list = (try? loadRaw()) ?? []
        if let idx = list.firstIndex(where: { $0.url == url }) {
            list[idx].lastUsed = now
        } else {
            list.append(.init(url: url, lastUsed: now))
        }
        try persistRaw(list)

        if let pin, !pin.isEmpty {
            try keychain.write(account: url, value: pin)
        } else {
            try keychain.delete(account: url)
        }
    }

    /// Remove a recent and its associated PIN.
    public func delete(url: String) throws {
        var list = (try? loadRaw()) ?? []
        list.removeAll { $0.url == url }
        try persistRaw(list)
        try keychain.delete(account: url)
    }

    /// Look up the PIN for a previously-saved URL. `nil` means no PIN
    /// was stored — the daemon may not require one.
    public func pin(for url: String) throws -> String? {
        try keychain.read(account: url)
    }

    // MARK: - Internals

    private func loadRaw() throws -> [ClayRecentConnection] {
        guard let data = defaults.data(forKey: recentsKey) else { return [] }
        do {
            return try JSONDecoder().decode([ClayRecentConnection].self, from: data)
        } catch {
            throw StoreError.decodeFailed
        }
    }

    private func persistRaw(_ list: [ClayRecentConnection]) throws {
        let data = try JSONEncoder().encode(list)
        defaults.set(data, forKey: recentsKey)
    }
}

// MARK: - In-memory keychain (for tests and #Preview)

public final class ClayInMemoryKeychainStore: ClayKeychainStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: String] = [:]

    public init() {}

    public func read(account: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return storage[account]
    }

    public func write(account: String, value: String) throws {
        lock.lock(); defer { lock.unlock() }
        storage[account] = value
    }

    public func delete(account: String) throws {
        lock.lock(); defer { lock.unlock() }
        storage.removeValue(forKey: account)
    }
}
