import Foundation
import Testing
@testable import ClarcCore

// Round-trip every fixture under repo-root protocol/fixtures/ through the
// Swift Codable layer. Catches drift between the JSON wire format and our
// Clay*Message enums.
//
// Strategy:
//   1. Decode fixture JSON → Clay*Message enum.
//   2. Re-encode to JSON.
//   3. Re-decode the encoded JSON → Clay*Message enum.
//   4. Assert the two decoded values are Equatable-equal.
//
// This catches missing fields, wrong types, broken Codable conformances,
// and any divergence between encode and decode. It does NOT compare raw
// bytes — Swift's encoder may reorder keys or omit-vs-null differently
// from Node, both of which are fine semantically. The daemon-side test
// (daemon/test/protocol.test.js) covers wire-format determinism.

@Suite("ClayProtocol round-trip")
struct ClayProtocolRoundTripTests {

    // The repo root is five levels above this test file:
    // <repo>/apple/Packages/Tests/ClarcCoreTests/<thisfile>.swift
    static let fixturesURL: URL = {
        let thisFile = URL(fileURLWithPath: #filePath)
        return thisFile
            .deletingLastPathComponent()  // ClarcCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // <repo>/
            .appendingPathComponent("protocol/fixtures")
    }()

    static func fixtures(in subdirectory: String) -> [URL] {
        let dir = fixturesURL.appendingPathComponent(subdirectory)
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil
        ) else {
            return []
        }
        return urls
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    static let c2sFixtures: [URL] = fixtures(in: "c2s")
    static let s2cFixtures: [URL] = fixtures(in: "s2c")

    @Test("fixtures directory exists and is non-empty")
    func fixturesDirectoryAvailable() {
        #expect(!Self.c2sFixtures.isEmpty,
                "no c2s fixtures found at \(Self.fixturesURL.appendingPathComponent("c2s").path)")
        #expect(!Self.s2cFixtures.isEmpty,
                "no s2c fixtures found at \(Self.fixturesURL.appendingPathComponent("s2c").path)")
    }

    @Test("c2s fixtures decode and round-trip", arguments: c2sFixtures)
    func clientFixtureRoundTrips(_ url: URL) throws {
        let name = url.deletingPathExtension().lastPathComponent
        let original = try Data(contentsOf: url)

        let decoded = try JSONDecoder().decode(ClayClientMessage.self, from: original)
        #expect(decoded.typeString == name,
                "fixture \(name).json decoded to type \(decoded.typeString)")

        let reEncoded = try JSONEncoder().encode(decoded)
        let reDecoded = try JSONDecoder().decode(ClayClientMessage.self, from: reEncoded)
        #expect(decoded == reDecoded,
                "Swift round-trip diverged for c2s/\(name).json")
    }

    @Test("s2c fixtures decode and round-trip", arguments: s2cFixtures)
    func serverFixtureRoundTrips(_ url: URL) throws {
        let name = url.deletingPathExtension().lastPathComponent
        let original = try Data(contentsOf: url)

        let decoded = try JSONDecoder().decode(ClayServerMessage.self, from: original)
        #expect(decoded.typeString == name,
                "fixture \(name).json decoded to type \(decoded.typeString)")

        let reEncoded = try JSONEncoder().encode(decoded)
        let reDecoded = try JSONDecoder().decode(ClayServerMessage.self, from: reEncoded)
        #expect(decoded == reDecoded,
                "Swift round-trip diverged for s2c/\(name).json")
    }
}
