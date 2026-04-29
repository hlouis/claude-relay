import Foundation

// Shared types for the Clay daemon ↔ client WebSocket protocol (Tier 1).
// Mirrors `protocol/types.ts` at the repo root. Drift is caught by
// ClayProtocolRoundTripTests against `protocol/fixtures/`.

// MARK: - Enumerations

public enum ClayPermissionMode: String, Codable, Sendable, CaseIterable {
    case `default`
    case plan
    case acceptEdits
    case bypassPermissions
}

public enum ClayEffort: String, Codable, Sendable, CaseIterable {
    case minimal, low, medium, high
}

public enum ClayThinking: String, Codable, Sendable, CaseIterable {
    case off, adaptive, budget
}

public enum ClaySessionVisibility: String, Codable, Sendable, CaseIterable {
    case shared
    case `private`
}

public enum ClayProcessingStatus: String, Codable, Sendable, CaseIterable {
    case idle, processing
}

public enum ClayPermissionDecision: String, Codable, Sendable, CaseIterable {
    case allow
    case allowAlways = "allow_always"
    case deny
    case allowAcceptEdits = "allow_accept_edits"
    case allowClearContext = "allow_clear_context"
}

public enum ClayRateLimitStatus: String, Codable, Sendable, CaseIterable {
    case allowedWarning = "allowed_warning"
    case rejected
}

public enum ClayMessageRole: String, Codable, Sendable {
    case user, assistant
}

public enum ClayToastLevel: String, Codable, Sendable {
    case info, warn, error
}

// MARK: - Common payload types

public struct ClayImageAttachment: Codable, Sendable, Equatable {
    public let mediaType: String
    public let data: String

    public init(mediaType: String, data: String) {
        self.mediaType = mediaType
        self.data = data
    }
}

public struct ClayToolResultImage: Codable, Sendable, Equatable {
    public let mediaType: String
    public let data: String

    public init(mediaType: String, data: String) {
        self.mediaType = mediaType
        self.data = data
    }
}

// Tool input is free-form JSON whose shape depends on the SDK tool.
// Modelled as JSONValue to preserve any payload we don't know about.
public typealias ClayToolInput = [String: JSONValue]

// Token usage maps; values are integer counts. If the SDK ever emits
// fractional usage values, switch to JSONValue.
public typealias ClayUsage = [String: Int]
public typealias ClayModelUsage = [String: ClayUsage]

public struct ClaySessionLoopRef: Codable, Sendable, Equatable {
    public let loopId: String?
    public let name: String?
    public let source: String?

    public init(loopId: String? = nil, name: String? = nil, source: String? = nil) {
        self.loopId = loopId
        self.name = name
        self.source = source
    }
}

public struct ClaySessionListEntry: Codable, Sendable, Equatable {
    public let id: Int
    public let cliSessionId: String?
    public let title: String
    public let active: Bool
    public let isProcessing: Bool
    public let lastActivity: Int
    public let loop: ClaySessionLoopRef?
    public let ownerId: String?
    public let sessionVisibility: ClaySessionVisibility
    public let unread: Int

    public init(
        id: Int,
        cliSessionId: String?,
        title: String,
        active: Bool,
        isProcessing: Bool,
        lastActivity: Int,
        loop: ClaySessionLoopRef?,
        ownerId: String?,
        sessionVisibility: ClaySessionVisibility,
        unread: Int
    ) {
        self.id = id
        self.cliSessionId = cliSessionId
        self.title = title
        self.active = active
        self.isProcessing = isProcessing
        self.lastActivity = lastActivity
        self.loop = loop
        self.ownerId = ownerId
        self.sessionVisibility = sessionVisibility
        self.unread = unread
    }
}

public struct ClayProjectListEntry: Codable, Sendable, Equatable {
    public let slug: String
    public let cwd: String?
    public let title: String?
    public let icon: String?

    public init(slug: String, cwd: String? = nil, title: String? = nil, icon: String? = nil) {
        self.slug = slug
        self.cwd = cwd
        self.title = title
        self.icon = icon
    }
}

