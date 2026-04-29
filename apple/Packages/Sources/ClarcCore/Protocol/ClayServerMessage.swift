import Foundation

// Server → Client messages (Tier 1).
// Discriminator: the top-level "type" string.

public enum ClayServerMessage: Codable, Sendable, Equatable {

    // MARK: - Bootstrap & config

    public struct Info: Codable, Sendable, Equatable {
        public let cwd: String
        public let slug: String
        public let project: String
        public let version: String
        public let debug: Bool
        public let dangerouslySkipPermissions: Bool?
        /// Boolean feature flag — `true` when the daemon is running in
        /// multi-OS-user mode. The daemon emits `osUsers || false` so
        /// the wire format is always a boolean (or absent), never an
        /// array. See `daemon/lib/project.js:1035`.
        public let osUsers: Bool?
        public let lanHost: String?
        public let projectCount: Int?
        public let projects: [ClayProjectListEntry]?
        public let projectOwnerId: String?
    }

    public struct ModelInfo: Codable, Sendable, Equatable {
        public let model: String
        public let models: [String]
    }

    public struct ConfigState: Codable, Sendable, Equatable {
        public let model: String
        public let mode: ClayPermissionMode
        public let effort: ClayEffort
        public let betas: [String]
        public let thinking: ClayThinking
        public let thinkingBudget: Int
    }

    // MARK: - Session list & lifecycle

    public struct SessionList: Codable, Sendable, Equatable {
        public let sessions: [ClaySessionListEntry]
    }

    public struct SessionSwitched: Codable, Sendable, Equatable {
        public let id: Int
        public let cliSessionId: String?
        public let loop: ClaySessionLoopRef?
    }

    public struct SessionId: Codable, Sendable, Equatable {
        public let cliSessionId: String
    }

    public struct HistoryMeta: Codable, Sendable, Equatable {
        public let total: Int
        public let from: Int
        public let resumed: Bool?
    }

    public struct HistoryDone: Codable, Sendable, Equatable {
        public let lastUsage: ClayUsage?
        public let lastModelUsage: ClayModelUsage?
        public let lastCost: Double?
        public let lastStreamInputTokens: Int?
    }

    public struct MessageUuid: Codable, Sendable, Equatable {
        public let uuid: String
        public let messageType: ClayMessageRole
        public let seq: Int?
    }

    public struct UserMessage: Codable, Sendable, Equatable {
        public let text: String
        public let imageCount: Int?
        public let pastes: [String]?
        public let clientMsgId: String?
        public let planContent: String?
        public let seq: Int?
    }

    // MARK: - Streaming output

    public struct Status: Codable, Sendable, Equatable {
        public let status: ClayProcessingStatus
    }

    public struct Delta: Codable, Sendable, Equatable {
        public let text: String
        public let seq: Int?
    }

    public struct ThinkingStart: Codable, Sendable, Equatable {
        public let seq: Int?
    }

    public struct ThinkingDelta: Codable, Sendable, Equatable {
        public let text: String
        public let seq: Int?
    }

    public struct ThinkingStop: Codable, Sendable, Equatable {
        public let duration: Double
        public let seq: Int?
    }

    public struct ToolStart: Codable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let seq: Int?
    }

    public struct ToolExecuting: Codable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let input: ClayToolInput
        public let seq: Int?
    }

    public struct ToolResult: Codable, Sendable, Equatable {
        public let id: String
        public let content: String
        public let isError: Bool
        public let images: [ClayToolResultImage]?
        public let seq: Int?

        private enum CodingKeys: String, CodingKey {
            case id, content, images, seq
            case isError = "is_error"
        }
    }

    public struct Result: Codable, Sendable, Equatable {
        public let cost: Double?
        public let duration: Double?
        public let usage: ClayUsage?
        public let modelUsage: ClayModelUsage?
        public let sessionId: String?
        public let lastStreamInputTokens: Int?
        public let seq: Int?
    }

    public struct Done: Codable, Sendable, Equatable {
        public let code: Int
        public let seq: Int?
    }

    // MARK: - Permission flow

    public struct PermissionRequest: Codable, Sendable, Equatable {
        public let requestId: String
        public let toolName: String
        public let toolInput: ClayToolInput
        public let toolUseId: String
        public let decisionReason: String
        public let seq: Int?
    }

    public struct PermissionRequestPending: Codable, Sendable, Equatable {
        public let requestId: String
        public let toolName: String
        public let toolInput: ClayToolInput
        public let toolUseId: String
        public let decisionReason: String
    }

    public struct PermissionResolved: Codable, Sendable, Equatable {
        public let requestId: String
        public let decision: ClayPermissionDecision
        public let seq: Int?
    }

    public struct PermissionCancel: Codable, Sendable, Equatable {
        public let requestId: String
        public let seq: Int?
    }

    // MARK: - System / errors

    public struct ErrorMessage: Codable, Sendable, Equatable {
        public let message: String?
        public let text: String?
    }

    public struct Toast: Codable, Sendable, Equatable {
        public let level: ClayToastLevel
        public let message: String
    }

    public struct RateLimit: Codable, Sendable, Equatable {
        public let status: ClayRateLimitStatus
        public let resetsAt: Int?
        public let rateLimitType: String?
        public let utilization: Double?
        public let isUsingOverage: Bool
        public let seq: Int?
    }

    public struct AuthRequired: Codable, Sendable, Equatable {
        public let text: String
        public let linuxUser: String?
        public let canAutoLogin: Bool
        public let seq: Int?
    }

    public struct ContextOverflow: Codable, Sendable, Equatable {
        public let text: String
        public let seq: Int?
    }

    // MARK: - Cases

    case info(Info)
    case modelInfo(ModelInfo)
    case configState(ConfigState)
    case sessionList(SessionList)
    case sessionSwitched(SessionSwitched)
    case sessionId(SessionId)
    case historyMeta(HistoryMeta)
    case historyDone(HistoryDone)
    case messageUuid(MessageUuid)
    case userMessage(UserMessage)
    case status(Status)
    case delta(Delta)
    case thinkingStart(ThinkingStart)
    case thinkingDelta(ThinkingDelta)
    case thinkingStop(ThinkingStop)
    case toolStart(ToolStart)
    case toolExecuting(ToolExecuting)
    case toolResult(ToolResult)
    case result(Result)
    case done(Done)
    case permissionRequest(PermissionRequest)
    case permissionRequestPending(PermissionRequestPending)
    case permissionResolved(PermissionResolved)
    case permissionCancel(PermissionCancel)
    case error(ErrorMessage)
    case toast(Toast)
    case rateLimit(RateLimit)
    case authRequired(AuthRequired)
    case contextOverflow(ContextOverflow)

    // MARK: - Discriminator mapping

    public var typeString: String {
        switch self {
        case .info: "info"
        case .modelInfo: "model_info"
        case .configState: "config_state"
        case .sessionList: "session_list"
        case .sessionSwitched: "session_switched"
        case .sessionId: "session_id"
        case .historyMeta: "history_meta"
        case .historyDone: "history_done"
        case .messageUuid: "message_uuid"
        case .userMessage: "user_message"
        case .status: "status"
        case .delta: "delta"
        case .thinkingStart: "thinking_start"
        case .thinkingDelta: "thinking_delta"
        case .thinkingStop: "thinking_stop"
        case .toolStart: "tool_start"
        case .toolExecuting: "tool_executing"
        case .toolResult: "tool_result"
        case .result: "result"
        case .done: "done"
        case .permissionRequest: "permission_request"
        case .permissionRequestPending: "permission_request_pending"
        case .permissionResolved: "permission_resolved"
        case .permissionCancel: "permission_cancel"
        case .error: "error"
        case .toast: "toast"
        case .rateLimit: "rate_limit"
        case .authRequired: "auth_required"
        case .contextOverflow: "context_overflow"
        }
    }

    private enum DiscriminatorKey: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminatorKey.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "info":                       self = .info(try Info(from: decoder))
        case "model_info":                 self = .modelInfo(try ModelInfo(from: decoder))
        case "config_state":               self = .configState(try ConfigState(from: decoder))
        case "session_list":               self = .sessionList(try SessionList(from: decoder))
        case "session_switched":           self = .sessionSwitched(try SessionSwitched(from: decoder))
        case "session_id":                 self = .sessionId(try SessionId(from: decoder))
        case "history_meta":               self = .historyMeta(try HistoryMeta(from: decoder))
        case "history_done":               self = .historyDone(try HistoryDone(from: decoder))
        case "message_uuid":               self = .messageUuid(try MessageUuid(from: decoder))
        case "user_message":               self = .userMessage(try UserMessage(from: decoder))
        case "status":                     self = .status(try Status(from: decoder))
        case "delta":                      self = .delta(try Delta(from: decoder))
        case "thinking_start":             self = .thinkingStart(try ThinkingStart(from: decoder))
        case "thinking_delta":             self = .thinkingDelta(try ThinkingDelta(from: decoder))
        case "thinking_stop":              self = .thinkingStop(try ThinkingStop(from: decoder))
        case "tool_start":                 self = .toolStart(try ToolStart(from: decoder))
        case "tool_executing":             self = .toolExecuting(try ToolExecuting(from: decoder))
        case "tool_result":                self = .toolResult(try ToolResult(from: decoder))
        case "result":                     self = .result(try Result(from: decoder))
        case "done":                       self = .done(try Done(from: decoder))
        case "permission_request":         self = .permissionRequest(try PermissionRequest(from: decoder))
        case "permission_request_pending": self = .permissionRequestPending(try PermissionRequestPending(from: decoder))
        case "permission_resolved":        self = .permissionResolved(try PermissionResolved(from: decoder))
        case "permission_cancel":          self = .permissionCancel(try PermissionCancel(from: decoder))
        case "error":                      self = .error(try ErrorMessage(from: decoder))
        case "toast":                      self = .toast(try Toast(from: decoder))
        case "rate_limit":                 self = .rateLimit(try RateLimit(from: decoder))
        case "auth_required":              self = .authRequired(try AuthRequired(from: decoder))
        case "context_overflow":           self = .contextOverflow(try ContextOverflow(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown ClayServerMessage type: \(type)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DiscriminatorKey.self)
        try container.encode(typeString, forKey: .type)
        switch self {
        case .info(let p): try p.encode(to: encoder)
        case .modelInfo(let p): try p.encode(to: encoder)
        case .configState(let p): try p.encode(to: encoder)
        case .sessionList(let p): try p.encode(to: encoder)
        case .sessionSwitched(let p): try p.encode(to: encoder)
        case .sessionId(let p): try p.encode(to: encoder)
        case .historyMeta(let p): try p.encode(to: encoder)
        case .historyDone(let p): try p.encode(to: encoder)
        case .messageUuid(let p): try p.encode(to: encoder)
        case .userMessage(let p): try p.encode(to: encoder)
        case .status(let p): try p.encode(to: encoder)
        case .delta(let p): try p.encode(to: encoder)
        case .thinkingStart(let p): try p.encode(to: encoder)
        case .thinkingDelta(let p): try p.encode(to: encoder)
        case .thinkingStop(let p): try p.encode(to: encoder)
        case .toolStart(let p): try p.encode(to: encoder)
        case .toolExecuting(let p): try p.encode(to: encoder)
        case .toolResult(let p): try p.encode(to: encoder)
        case .result(let p): try p.encode(to: encoder)
        case .done(let p): try p.encode(to: encoder)
        case .permissionRequest(let p): try p.encode(to: encoder)
        case .permissionRequestPending(let p): try p.encode(to: encoder)
        case .permissionResolved(let p): try p.encode(to: encoder)
        case .permissionCancel(let p): try p.encode(to: encoder)
        case .error(let p): try p.encode(to: encoder)
        case .toast(let p): try p.encode(to: encoder)
        case .rateLimit(let p): try p.encode(to: encoder)
        case .authRequired(let p): try p.encode(to: encoder)
        case .contextOverflow(let p): try p.encode(to: encoder)
        }
    }
}
