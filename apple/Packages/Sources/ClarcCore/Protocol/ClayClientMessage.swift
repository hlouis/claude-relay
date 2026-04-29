import Foundation

// Client → Server messages (Tier 1).
// Discriminator: the top-level "type" string.

public enum ClayClientMessage: Codable, Sendable, Equatable {

    // MARK: - Payloads

    public struct Message: Codable, Sendable, Equatable {
        public let text: String?
        public let images: [ClayImageAttachment]?
        public let pastes: [String]?
        public let clientMsgId: String?

        public init(
            text: String? = nil,
            images: [ClayImageAttachment]? = nil,
            pastes: [String]? = nil,
            clientMsgId: String? = nil
        ) {
            self.text = text
            self.images = images
            self.pastes = pastes
            self.clientMsgId = clientMsgId
        }
    }

    public struct NewSession: Codable, Sendable, Equatable {
        public let sessionVisibility: ClaySessionVisibility?

        public init(sessionVisibility: ClaySessionVisibility? = nil) {
            self.sessionVisibility = sessionVisibility
        }
    }

    public struct SwitchSession: Codable, Sendable, Equatable {
        public let id: Int
        public let lastSeq: Int?

        public init(id: Int, lastSeq: Int? = nil) {
            self.id = id
            self.lastSeq = lastSeq
        }
    }

    public struct DeleteSession: Codable, Sendable, Equatable {
        public let id: Int

        public init(id: Int) { self.id = id }
    }

    public struct RenameSession: Codable, Sendable, Equatable {
        public let id: Int
        public let title: String

        public init(id: Int, title: String) {
            self.id = id
            self.title = title
        }
    }

    public struct PermissionResponse: Codable, Sendable, Equatable {
        public let requestId: String
        public let decision: ClayPermissionDecision
        public let updatedInput: ClayToolInput?
        public let planContent: String?

        public init(
            requestId: String,
            decision: ClayPermissionDecision,
            updatedInput: ClayToolInput? = nil,
            planContent: String? = nil
        ) {
            self.requestId = requestId
            self.decision = decision
            self.updatedInput = updatedInput
            self.planContent = planContent
        }
    }

    public struct LoadMoreHistory: Codable, Sendable, Equatable {
        public let before: Int?

        public init(before: Int? = nil) { self.before = before }
    }

    public struct SetModel: Codable, Sendable, Equatable {
        public let model: String
        public init(model: String) { self.model = model }
    }

    public struct SetPermissionMode: Codable, Sendable, Equatable {
        public let mode: ClayPermissionMode
        public init(mode: ClayPermissionMode) { self.mode = mode }
    }

    public struct SetEffort: Codable, Sendable, Equatable {
        public let effort: ClayEffort
        public init(effort: ClayEffort) { self.effort = effort }
    }

    // MARK: - Cases

    case message(Message)
    case newSession(NewSession)
    case switchSession(SwitchSession)
    case deleteSession(DeleteSession)
    case renameSession(RenameSession)
    case stop
    case permissionResponse(PermissionResponse)
    case loadMoreHistory(LoadMoreHistory)
    case tabVisible
    case setModel(SetModel)
    case setPermissionMode(SetPermissionMode)
    case setEffort(SetEffort)

    // MARK: - Discriminator mapping

    public var typeString: String {
        switch self {
        case .message: "message"
        case .newSession: "new_session"
        case .switchSession: "switch_session"
        case .deleteSession: "delete_session"
        case .renameSession: "rename_session"
        case .stop: "stop"
        case .permissionResponse: "permission_response"
        case .loadMoreHistory: "load_more_history"
        case .tabVisible: "tab_visible"
        case .setModel: "set_model"
        case .setPermissionMode: "set_permission_mode"
        case .setEffort: "set_effort"
        }
    }

    private enum DiscriminatorKey: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminatorKey.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "message":
            self = .message(try Message(from: decoder))
        case "new_session":
            self = .newSession(try NewSession(from: decoder))
        case "switch_session":
            self = .switchSession(try SwitchSession(from: decoder))
        case "delete_session":
            self = .deleteSession(try DeleteSession(from: decoder))
        case "rename_session":
            self = .renameSession(try RenameSession(from: decoder))
        case "stop":
            self = .stop
        case "permission_response":
            self = .permissionResponse(try PermissionResponse(from: decoder))
        case "load_more_history":
            self = .loadMoreHistory(try LoadMoreHistory(from: decoder))
        case "tab_visible":
            self = .tabVisible
        case "set_model":
            self = .setModel(try SetModel(from: decoder))
        case "set_permission_mode":
            self = .setPermissionMode(try SetPermissionMode(from: decoder))
        case "set_effort":
            self = .setEffort(try SetEffort(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown ClayClientMessage type: \(type)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DiscriminatorKey.self)
        try container.encode(typeString, forKey: .type)
        switch self {
        case .message(let p): try p.encode(to: encoder)
        case .newSession(let p): try p.encode(to: encoder)
        case .switchSession(let p): try p.encode(to: encoder)
        case .deleteSession(let p): try p.encode(to: encoder)
        case .renameSession(let p): try p.encode(to: encoder)
        case .stop: break
        case .permissionResponse(let p): try p.encode(to: encoder)
        case .loadMoreHistory(let p): try p.encode(to: encoder)
        case .tabVisible: break
        case .setModel(let p): try p.encode(to: encoder)
        case .setPermissionMode(let p): try p.encode(to: encoder)
        case .setEffort(let p): try p.encode(to: encoder)
        }
    }
}
