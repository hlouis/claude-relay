// Clay daemon ↔ Apple client WebSocket protocol — Tier 1.
//
// SINGLE SOURCE OF TRUTH. The daemon (Node.js) consumes this file as
// documentation only — it has no build step. Native Apple clients hand-write
// Codable mirrors of these types. Drift is caught by the round-trip test
// against fixtures/.
//
// Versioning: this file describes protocol v1. Breaking changes require a
// `protocolVersion` bump in `info` and a parallel migration plan.
//
// Out-of-scope (Tier 2/3 — deliberately omitted): terminal, file system, DM,
// loop/ralph, scheduler, hub controls, presence/cursor, project management.
// Those remain daemon ↔ browser internals.

// =============================================================================
// Envelope (reserved, OPTIONAL)
// =============================================================================
// The current daemon does not emit `id` or `inReplyTo`. Native clients MAY
// include them on outbound messages; the daemon will currently ignore them.
// Reserved here so v1 receivers tolerate v2 senders.

export interface Envelope {
  id?: string;
  inReplyTo?: string;
  seq?: number;
}

// =============================================================================
// Shared types
// =============================================================================

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
export type Effort = "minimal" | "low" | "medium" | "high";
export type Thinking = "off" | "adaptive" | "budget";
export type SessionVisibility = "shared" | "private";
export type ProcessingStatus = "idle" | "processing";

export type PermissionDecision =
  | "allow"
  | "allow_always"
  | "deny"
  | "allow_accept_edits"
  | "allow_clear_context";

export type RateLimitStatus = "allowed_warning" | "rejected";
export type MessageRole = "user" | "assistant";

export interface ImageAttachment {
  mediaType: string;
  data: string;
}

export interface ToolResultImage {
  mediaType: string;
  data: string;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: number | undefined;
}

export type ModelUsage = Record<string, Usage>;

export interface SessionListEntry {
  id: number;
  cliSessionId: string | null;
  title: string;
  active: boolean;
  isProcessing: boolean;
  lastActivity: number;
  loop: SessionLoopRef | null;
  ownerId: string | null;
  sessionVisibility: SessionVisibility;
  unread: number;
}

export interface SessionLoopRef {
  loopId?: string;
  name?: string;
  source?: string;
  [key: string]: unknown;
}

export interface ProjectListEntry {
  slug: string;
  cwd?: string;
  title?: string;
  icon?: string | null;
  [key: string]: unknown;
}

// Tool input is a free-form JSON object whose shape depends on the SDK tool
// definition. Native clients should NOT model it strictly; surface it as a
// generic dictionary or render against tool-specific known cases.
export type ToolInput = Record<string, unknown>;

// =============================================================================
// Client → Server
// =============================================================================

export interface C_Message extends Envelope {
  type: "message";
  text?: string;
  images?: ImageAttachment[];
  pastes?: string[];
  clientMsgId?: string;
}

export interface C_NewSession extends Envelope {
  type: "new_session";
  sessionVisibility?: SessionVisibility;
}

export interface C_SwitchSession extends Envelope {
  type: "switch_session";
  id: number;
  lastSeq?: number;
}

export interface C_DeleteSession extends Envelope {
  type: "delete_session";
  id: number;
}

export interface C_RenameSession extends Envelope {
  type: "rename_session";
  id: number;
  title: string;
}

export interface C_Stop extends Envelope {
  type: "stop";
}

export interface C_PermissionResponse extends Envelope {
  type: "permission_response";
  requestId: string;
  decision: PermissionDecision;
  updatedInput?: ToolInput;
  planContent?: string;
}

export interface C_LoadMoreHistory extends Envelope {
  type: "load_more_history";
  before?: number;
}

export interface C_TabVisible extends Envelope {
  type: "tab_visible";
}

export interface C_SetModel extends Envelope {
  type: "set_model";
  model: string;
}

export interface C_SetPermissionMode extends Envelope {
  type: "set_permission_mode";
  mode: PermissionMode;
}

export interface C_SetEffort extends Envelope {
  type: "set_effort";
  effort: Effort;
}

export type ClientToServer =
  | C_Message
  | C_NewSession
  | C_SwitchSession
  | C_DeleteSession
  | C_RenameSession
  | C_Stop
  | C_PermissionResponse
  | C_LoadMoreHistory
  | C_TabVisible
  | C_SetModel
  | C_SetPermissionMode
  | C_SetEffort;

// =============================================================================
// Server → Client
// =============================================================================

// --- Connection bootstrap ---

export interface S_Info extends Envelope {
  type: "info";
  cwd: string;
  slug: string;
  project: string;
  version: string;
  debug: boolean;
  dangerouslySkipPermissions?: boolean;
  // Boolean feature flag — true when the daemon is running in
  // multi-OS-user mode. Mirrors `daemon/lib/project.js:1035`, which
  // emits the same boolean it received from config.
  osUsers?: boolean;
  lanHost?: string | null;
  projectCount?: number;
  projects?: ProjectListEntry[];
  projectOwnerId?: string | null;
}

export interface S_ModelInfo extends Envelope {
  type: "model_info";
  model: string;
  models: string[];
}

export interface S_ConfigState extends Envelope {
  type: "config_state";
  model: string;
  mode: PermissionMode | "default";
  effort: Effort;
  betas: string[];
  thinking: Thinking;
  thinkingBudget: number;
}

// --- Session list & lifecycle ---

export interface S_SessionList extends Envelope {
  type: "session_list";
  sessions: SessionListEntry[];
}

export interface S_SessionSwitched extends Envelope {
  type: "session_switched";
  id: number;
  cliSessionId: string | null;
  loop: SessionLoopRef | null;
}

export interface S_SessionId extends Envelope {
  type: "session_id";
  cliSessionId: string;
}

export interface S_HistoryMeta extends Envelope {
  type: "history_meta";
  total: number;
  from: number;
  resumed?: boolean;
}

export interface S_HistoryDone extends Envelope {
  type: "history_done";
  lastUsage?: Usage | null;
  lastModelUsage?: ModelUsage | null;
  lastCost?: number | null;
  lastStreamInputTokens?: number | null;
}

export interface S_MessageUuid extends Envelope {
  type: "message_uuid";
  uuid: string;
  messageType: MessageRole;
}

// Recorded into session history. Native clients render this as the user's
// turn. Note: the *client* sends C_Message to submit input; the daemon
// echoes it back as S_UserMessage (with `seq`) so all connected clients see it.
export interface S_UserMessage extends Envelope {
  type: "user_message";
  text: string;
  imageCount?: number;
  pastes?: string[];
  clientMsgId?: string;
  planContent?: string | null;
}

// --- Streaming assistant output ---

export interface S_Status extends Envelope {
  type: "status";
  status: ProcessingStatus;
}

export interface S_Delta extends Envelope {
  type: "delta";
  text: string;
}

export interface S_ThinkingStart extends Envelope { type: "thinking_start"; }
export interface S_ThinkingDelta extends Envelope { type: "thinking_delta"; text: string; }
export interface S_ThinkingStop extends Envelope { type: "thinking_stop"; duration: number; }

export interface S_ToolStart extends Envelope {
  type: "tool_start";
  id: string;
  name: string;
}

export interface S_ToolExecuting extends Envelope {
  type: "tool_executing";
  id: string;
  name: string;
  input: ToolInput;
}

export interface S_ToolResult extends Envelope {
  type: "tool_result";
  id: string;
  content: string;
  is_error: boolean;
  images?: ToolResultImage[];
}

export interface S_Result extends Envelope {
  type: "result";
  cost: number | null;
  duration: number | null;
  usage: Usage | null;
  modelUsage: ModelUsage | null;
  sessionId: string | null;
  lastStreamInputTokens: number | null;
}

export interface S_Done extends Envelope {
  type: "done";
  code: number;
}

// --- Permission flow ---

export interface S_PermissionRequest extends Envelope {
  type: "permission_request";
  requestId: string;
  toolName: string;
  toolInput: ToolInput;
  toolUseId: string;
  decisionReason: string;
}

// Replayed on session switch so reconnecting clients can re-render any
// pending requests that haven't been answered yet.
export interface S_PermissionRequestPending extends Envelope {
  type: "permission_request_pending";
  requestId: string;
  toolName: string;
  toolInput: ToolInput;
  toolUseId: string;
  decisionReason: string;
}

export interface S_PermissionResolved extends Envelope {
  type: "permission_resolved";
  requestId: string;
  decision: PermissionDecision;
}

export interface S_PermissionCancel extends Envelope {
  type: "permission_cancel";
  requestId: string;
}

// --- System / errors ---

export interface S_Error extends Envelope {
  type: "error";
  message?: string;
  text?: string;
}

export interface S_Toast extends Envelope {
  type: "toast";
  level: "info" | "warn" | "error";
  message: string;
}

export interface S_RateLimit extends Envelope {
  type: "rate_limit";
  status: RateLimitStatus;
  resetsAt: number | null;
  rateLimitType: string | null;
  utilization: number | null;
  isUsingOverage: boolean;
}

export interface S_AuthRequired extends Envelope {
  type: "auth_required";
  text: string;
  linuxUser: string | null;
  canAutoLogin: boolean;
}

export interface S_ContextOverflow extends Envelope {
  type: "context_overflow";
  text: string;
}

export type ServerToClient =
  | S_Info
  | S_ModelInfo
  | S_ConfigState
  | S_SessionList
  | S_SessionSwitched
  | S_SessionId
  | S_HistoryMeta
  | S_HistoryDone
  | S_MessageUuid
  | S_UserMessage
  | S_Status
  | S_Delta
  | S_ThinkingStart
  | S_ThinkingDelta
  | S_ThinkingStop
  | S_ToolStart
  | S_ToolExecuting
  | S_ToolResult
  | S_Result
  | S_Done
  | S_PermissionRequest
  | S_PermissionRequestPending
  | S_PermissionResolved
  | S_PermissionCancel
  | S_Error
  | S_Toast
  | S_RateLimit
  | S_AuthRequired
  | S_ContextOverflow;

export type ClayMessage = ClientToServer | ServerToClient;
