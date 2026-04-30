import Foundation

// Chat-stream items as rendered in the UI.
//
// This is *not* a 1:1 mirror of `ClayServerMessage`. Several streaming
// events collapse into a single growing item:
//
//   - `delta` events accumulate into the trailing `.assistantText` item.
//   - `thinking_delta` events accumulate into the trailing `.thinking` item.
//   - `tool_executing` / `tool_result` back-fill the matching `.tool` item
//     created by the earlier `tool_start`.
//
// Coalescing rule (Linus-style: no special cases / no "open fragment"
// pointer): the *last* element of `messages` IS the open streaming slot.
// When a new event of a different kind arrives, the next streaming event
// of any kind naturally opens a fresh item because `messages.last` is no
// longer that kind. See `ClaySessionState` for the actual mutators.

public enum ClayChatItem: Equatable, Sendable, Identifiable {
    case user(UserItem)
    case assistantText(TextItem)
    case thinking(ThinkingItem)
    case tool(ToolItem)
    case permission(PermissionItem)
    case result(ResultItem)
    case systemError(SystemErrorItem)

    public var id: String {
        switch self {
        case .user(let p):          return p.id
        case .assistantText(let p): return p.id
        case .thinking(let p):      return p.id
        case .tool(let p):          return p.id
        case .permission(let p):    return p.id
        case .result(let p):        return p.id
        case .systemError(let p):   return p.id
        }
    }

    // MARK: - Payloads

    public struct UserItem: Equatable, Sendable {
        public var id: String                 // uuid from message_uuid, else generated
        public var text: String
        public var clientMsgId: String?
        public var imageCount: Int?
        public var pastes: [String]?
        public var planContent: String?

        public init(
            id: String,
            text: String,
            clientMsgId: String? = nil,
            imageCount: Int? = nil,
            pastes: [String]? = nil,
            planContent: String? = nil
        ) {
            self.id = id
            self.text = text
            self.clientMsgId = clientMsgId
            self.imageCount = imageCount
            self.pastes = pastes
            self.planContent = planContent
        }
    }

    public struct TextItem: Equatable, Sendable {
        public var id: String                 // generated when first delta arrives
        public var text: String

        public init(id: String, text: String) {
            self.id = id
            self.text = text
        }
    }

    public struct ThinkingItem: Equatable, Sendable {
        public var id: String
        public var text: String
        public var durationMs: Int?           // populated on thinking_stop

        public init(id: String, text: String, durationMs: Int? = nil) {
            self.id = id
            self.text = text
            self.durationMs = durationMs
        }
    }

    public struct ToolItem: Equatable, Sendable {
        public var id: String                 // tool_use id (from tool_start)
        public var name: String
        public var input: ClayToolInput?      // filled by tool_executing
        public var result: ToolResult?        // filled by tool_result

        public init(
            id: String,
            name: String,
            input: ClayToolInput? = nil,
            result: ToolResult? = nil
        ) {
            self.id = id
            self.name = name
            self.input = input
            self.result = result
        }

        public struct ToolResult: Equatable, Sendable {
            public var content: String
            public var isError: Bool
            public var images: [ClayToolResultImage]?

            public init(
                content: String,
                isError: Bool,
                images: [ClayToolResultImage]? = nil
            ) {
                self.content = content
                self.isError = isError
                self.images = images
            }
        }
    }

    public struct PermissionItem: Equatable, Sendable {
        public var id: String                 // requestId
        public var toolName: String
        public var toolInput: ClayToolInput
        public var toolUseId: String
        public var decisionReason: String
        public var status: Status

        public enum Status: Equatable, Sendable {
            case pending
            case resolved(ClayPermissionDecision)
            case cancelled
        }

        public init(
            id: String,
            toolName: String,
            toolInput: ClayToolInput,
            toolUseId: String,
            decisionReason: String,
            status: Status = .pending
        ) {
            self.id = id
            self.toolName = toolName
            self.toolInput = toolInput
            self.toolUseId = toolUseId
            self.decisionReason = decisionReason
            self.status = status
        }
    }

    public struct ResultItem: Equatable, Sendable {
        public var id: String
        public var cost: Double?
        public var duration: Double?
        public var usage: ClayUsage?
        public var modelUsage: ClayModelUsage?
        public var sessionId: String?

        public init(
            id: String,
            cost: Double? = nil,
            duration: Double? = nil,
            usage: ClayUsage? = nil,
            modelUsage: ClayModelUsage? = nil,
            sessionId: String? = nil
        ) {
            self.id = id
            self.cost = cost
            self.duration = duration
            self.usage = usage
            self.modelUsage = modelUsage
            self.sessionId = sessionId
        }
    }

    public struct SystemErrorItem: Equatable, Sendable {
        public var id: String
        public var text: String
        public var kind: Kind

        public enum Kind: Equatable, Sendable {
            case error                        // server-side `error` message
            case contextOverflow
        }

        public init(id: String, text: String, kind: Kind) {
            self.id = id
            self.text = text
            self.kind = kind
        }
    }
}
