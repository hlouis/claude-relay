import Foundation
import Security

// Production conformer of `ClayKeychainStore`, backed by
// `Security.framework`'s SecItem APIs.
//
// Items are stored as generic-password entries scoped to a single
// service identifier (`com.idealapp.Clarc.clay`) with the account
// being the full WebSocket URL the user pasted in the connect
// screen. Accessibility is `WhenUnlockedThisDeviceOnly` — tokens
// don't migrate via iCloud Keychain or device-to-device transfers.
//
// Don't unit-test against this directly; tests use
// `ClayInMemoryKeychainStore` instead. Run a manual smoke when
// touching anything in this file.

public final class ClaySystemKeychainStore: ClayKeychainStore, @unchecked Sendable {

    public enum KeychainError: Error, Equatable, Sendable {
        case unhandled(OSStatus)
        case unexpectedDataShape
    }

    public let service: String

    public init(service: String = "com.idealapp.Clarc.clay") {
        self.service = service
    }

    // MARK: - ClayKeychainStore

    public func read(account: String) throws -> String? {
        var query: [CFString: Any] = baseQuery(account: account)
        query[kSecMatchLimit] = kSecMatchLimitOne
        query[kSecReturnData] = true

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data,
                  let value = String(data: data, encoding: .utf8) else {
                throw KeychainError.unexpectedDataShape
            }
            return value
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unhandled(status)
        }
    }

    public func write(account: String, value: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.unexpectedDataShape
        }

        // Try update first (most common path — re-saving after a
        // PIN rotation or just bumping the lastUsed timestamp).
        let updateStatus = SecItemUpdate(
            baseQuery(account: account) as CFDictionary,
            [kSecValueData: data] as CFDictionary
        )
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            break // fall through to add
        default:
            throw KeychainError.unhandled(updateStatus)
        }

        var addQuery: [CFString: Any] = baseQuery(account: account)
        addQuery[kSecValueData] = data
        addQuery[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError.unhandled(addStatus)
        }
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        switch status {
        case errSecSuccess, errSecItemNotFound:
            return
        default:
            throw KeychainError.unhandled(status)
        }
    }

    // MARK: - Internals

    private func baseQuery(account: String) -> [CFString: Any] {
        [
            kSecClass:       kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
    }
}
