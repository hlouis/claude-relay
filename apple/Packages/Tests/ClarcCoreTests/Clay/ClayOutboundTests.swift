import Foundation
import Testing
@testable import ClarcCore

// PLAN M3 test gate: snapshot the JSON bytes produced by each helper
// against the corresponding `protocol/fixtures/c2s/*.json`, modulo
// optional fields the helper omits.
//
// "Snapshot" here means: encode the helper output to JSON, decode
// both sides into a normalised dictionary, and compare. Comparing
// raw bytes would be fragile (Swift's encoder doesn't guarantee key
// order or numeric formatting), but every Tier 1 c2s payload is a
// flat JSON object so a key-by-key comparison after JSONSerialization
// is both deterministic and human-meaningful.

@Suite("ClayOutbound (M3 snapshots)")
struct ClayOutboundTests {

    // MARK: - Fixture path

    static let c2sFixturesURL: URL = {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Clay/
            .deletingLastPathComponent()  // ClarcCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // <repo>/
            .appendingPathComponent("protocol/fixtures/c2s")
    }()

    // MARK: - Helper-to-fixture table
    //
    // Every Tier 1 client message has exactly one entry. Adding a
    // new case to ClayClientMessage that ships a fixture but no row
    // here will be caught by `coversEveryFixture()` below.

    private struct Snapshot {
        let fixture: String
        let message: ClayClientMessage
    }

    private static let snapshots: [Snapshot] = [
        Snapshot(
            fixture: "message",
            message: ClayOutbound.message(
                text: "Refactor the auth middleware to drop the legacy session token path.",
                clientMsgId: "c-3f9e2"
            )
        ),
        Snapshot(
            fixture: "new_session",
            message: ClayOutbound.newSession(visibility: .shared)
        ),
        Snapshot(
            fixture: "switch_session",
            message: ClayOutbound.switchSession(id: 7, lastSeq: 142)
        ),
        Snapshot(
            fixture: "delete_session",
            message: ClayOutbound.deleteSession(id: 7)
        ),
        Snapshot(
            fixture: "rename_session",
            message: ClayOutbound.renameSession(id: 7, title: "Auth middleware rewrite")
        ),
        Snapshot(
            fixture: "stop",
            message: ClayOutbound.stop
        ),
        Snapshot(
            fixture: "permission_response",
            message: ClayOutbound.permissionResponse(
                requestId: "9c1b3e7a-1f4d-4d12-8a3b-bd9c0f2e5a11",
                decision: .allow
            )
        ),
        Snapshot(
            fixture: "load_more_history",
            message: ClayOutbound.loadMoreHistory(before: 42)
        ),
        Snapshot(
            fixture: "tab_visible",
            message: ClayOutbound.tabVisible
        ),
        Snapshot(
            fixture: "set_model",
            message: ClayOutbound.setModel("claude-opus-4-7")
        ),
        Snapshot(
            fixture: "set_permission_mode",
            message: ClayOutbound.setPermissionMode(.acceptEdits)
        ),
        Snapshot(
            fixture: "set_effort",
            message: ClayOutbound.setEffort(.medium)
        ),
    ]

    // MARK: - Tests

    @Test("every helper output matches its c2s fixture",
          arguments: snapshots.map { ($0.fixture, $0.message) })
    func snapshotMatchesFixture(fixture: String, message: ClayClientMessage) throws {
        let url = Self.c2sFixturesURL.appendingPathComponent("\(fixture).json")
        let fixtureBytes = try Data(contentsOf: url)

        let producedBytes = try JSONEncoder().encode(message)

        let fixtureDict = try Self.normalise(fixtureBytes)
        let producedDict = try Self.normalise(producedBytes)

        // The helper may legitimately omit optional fields the fixture
        // includes (and vice-versa) — but for every key the helper DID
        // populate, the value must match. The PLAN's "modulo optional
        // fields the helper omits" wording captures this.
        //
        // We assert a stronger thing: the helper's output, when fed
        // through the existing decode path, must yield the same enum
        // value as the fixture. That round-trips through every
        // discriminator + optional-field rule.
        let fromHelper = try JSONDecoder().decode(
            ClayClientMessage.self, from: producedBytes)
        let fromFixture = try JSONDecoder().decode(
            ClayClientMessage.self, from: fixtureBytes)
        #expect(fromHelper == fromFixture,
                "helper for \(fixture) produced a different ClayClientMessage value")

        // Per-key check on the populated fields too, so a pure
        // shape-drift (e.g. helper introduces an extra "foo": null) is
        // caught visibly.
        for (key, value) in producedDict {
            #expect(fixtureDict[key] != nil,
                    "\(fixture).json: helper produced unexpected key \"\(key)\" with value \(value)")
            // Fixture values in the c2s set are flat scalars / strings;
            // direct equality via normalised JSON works.
            if let fixtureValue = fixtureDict[key] {
                #expect(equalJSON(fixtureValue, value),
                        "\(fixture).json: key \"\(key)\" — fixture=\(fixtureValue) helper=\(value)")
            }
        }
    }

    @Test("snapshot table covers every c2s fixture")
    func coversEveryFixture() throws {
        let onDisk = try FileManager.default
            .contentsOfDirectory(at: Self.c2sFixturesURL, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .map { $0.deletingPathExtension().lastPathComponent }
            .sorted()

        let inTable = Self.snapshots.map(\.fixture).sorted()

        #expect(onDisk == inTable,
                "fixtures on disk vs. snapshot table:\n  disk:  \(onDisk)\n  table: \(inTable)")
    }

    // MARK: - Helpers

    /// Decode a JSON object into a normalised `[String: Any]`.
    /// `Any` is opaque, so callers compare with `equalJSON` below.
    private static func normalise(_ data: Data) throws -> [String: Any] {
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(
                domain: "ClayOutboundTests",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "fixture is not a JSON object"]
            )
        }
        return obj
    }
}

/// Structural JSON equality for the leaf shapes that appear in c2s
/// fixtures (string, number, bool, null). No nested objects/arrays
/// occur in Tier 1 c2s payloads at top level.
private func equalJSON(_ a: Any, _ b: Any) -> Bool {
    if a is NSNull && b is NSNull { return true }
    if let x = a as? String, let y = b as? String { return x == y }
    if let x = a as? Bool, let y = b as? Bool { return x == y }
    if let x = a as? NSNumber, let y = b as? NSNumber { return x == y }
    return false
}
