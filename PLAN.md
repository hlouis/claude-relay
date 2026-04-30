# Phase 1 — Tier 1 Protocol End-to-End

> **Status:** approved (2026-04-29). All §3 decisions resolved.
> **Owner:** TBD. **Target completion:** TBD.
> **Prereqs done:** `protocol/types.ts`, fixtures, daemon round-trip test,
> Apple Codable mirror — all green as of `9f1d83b`.
> **Latest progress:** M1 / M2 / M3 / M4 / M5 shipped (see "Progress log" below).
> 72 Swift tests + 85 daemon tests green. Next: **M6** (session lifecycle UI)
> or **M7** (connect screen) — independent, can run in parallel.

## 1. Goal

Ship a working path where **macOS Clarc connects to a local Clay daemon
over WebSocket and drives a chat session using only Tier 1 messages**.
End user can: enter a daemon URL, list/switch/create sessions, send a
message, see streaming output and tool execution, approve permission
requests, and observe rate-limit / auth errors — all without spawning
Claude CLI from the app.

## 2. Out of scope

Everything below is deliberately deferred. Don't sneak any of it in.

- **iOS / iPadOS targets.** macOS only. The Codable layer is platform-
  neutral; UI layers will need rework for touch. → Phase 2.
- **Tier 2/3 messages.** No terminal, no `fs_*`, no DM, no loop/ralph,
  no scheduler, no presence/cursor, no project management mutations.
- **Multi-project / project picker UI.** This phase users paste a
  complete `wss://host:port/p/<slug>/ws` URL — the project is fixed by
  that URL. Switching between projects within the app waits for Tier 2
  protocol messages (`list_projects` / `attach_project` or equivalent).
- **Multi-daemon.** One active connection at a time.
- **mDNS / auto-discovery.** Phase 1 = explicit URL entry.
- **Auth beyond what the daemon already uses.** Whatever PIN / token
  flow `daemon/lib/server.js` exposes today — match it, don't redesign.
- **End-to-end encrypted transport.** Use the daemon's existing TLS
  (mkcert) story; document any local-CA quirks but don't extend.

## 3. Decisions (approved)

- **D1 — Replace, don't coexist.** Internal tool, no compat burden. The
  CLI subprocess mode is deleted in this phase (see §5 M10). The app
  becomes a pure WebSocket client of the Clay daemon.
- **D2 — Explicit full-URL entry.** Connect screen takes a complete
  `wss://host:port/p/<slug>/ws` URL plus token. The project slug is
  baked into the URL — no in-app project switcher this phase. Project
  list / switch UI waits for Tier 2.
- **D3 — Single window, three-pane (Slack/Discord style).** One main
  window:
  - Left rail: project entry (this phase = a single fixed entry; the
    rail exists so Tier 2 can drop in multi-project without re-laying
    out the window).
  - Middle pane: session list for the active project.
  - Right pane: chat (messages, composer, permission modal).
- **D4 — Add `protocolVersion: "1"` to `info`.** One-string daemon
  change; cheap insurance against silent v2 drift.

## 3a. Progress log (2026-04-29)

### Milestones complete

| Milestone | Status | Commits | Test coverage |
|-----------|--------|---------|---------------|
| §3 decisions + R4 prototype | ✅ | `1215ff1` | `protocol/scripts/r4-handshake.mjs` runs against live daemon |
| **M1** WebSocket connection actor | ✅ DoD met | `d7f930d` `6e40799` `4304f7c` | All 6 PLAN test cases covered (see §M1 test gate) |
| **M2** Inbound dispatcher | ✅ DoD met | `f128246` | Replay-all-29-s2c-fixtures + 3 lifecycle cases |
| **M3** Outbound encoder | ✅ DoD met | `fd3e431` | 12 helper-vs-c2s-fixture snapshots + coverage check |
| **M4** ClayProjectState (chat state mirror) | ✅ DoD met | `13aa724` `5d70aa3` `c4a7bd9` `971fc0f` | 9 SessionState unit tests + 6 ProjectState integration tests (incl. R5 regression and history↔live equivalence) |
| **M5** Permission flow UI | ✅ DoD met | `bf1f1ed` `2d080fc` | 6 responder/plan-tool unit tests; `xcodebuild` Debug build of Clarc target green with the new view |
| R7 fix: `info.osUsers` schema | ✅ | `9e493ec` | Was: `OsUser[]?`. Now: `Bool?`. `OsUser` / `ClayOsUser` deleted. |

### Test totals (post-M5)
- Apple: **72 tests / 18 suites / ~3.3 s** (`swift test --package-path apple/Packages`)
- Daemon: **85 tests** (`node --test daemon/test/*.js`)
- App target: `xcodebuild -project apple/Clarc.xcodeproj -scheme Clarc build` green

### Code locations (Apple)

```
apple/Packages/Sources/ClarcCore/Clay/
├── Connection/
│   ├── ClayConnection.swift         ← actor, M1
│   ├── ClayConnectionConfig.swift   ← URL parsing + httpOrigin + resume query, M1
│   └── ClayConnectionStatus.swift   ← status + failure enums, M1
├── Dispatcher/
│   ├── ClayMessageDispatcher.swift  ← actor pump, M2
│   └── ClayMessageReceiver.swift    ← single-method protocol, M2
├── Outbound/
│   ├── ClayOutbound.swift              ← static factories, M3
│   ├── ClayConnection+Outbound.swift   ← async-throws send helpers, M3
│   └── ClayPermissionResponder.swift   ← protocol + isPlanTool extension, M5
└── State/
    ├── ClayChatItem.swift              ← chat-stream enum + 7 payload structs, M4
    ├── ClaySessionState.swift          ← per-session value type + coalesce mutators, M4
    └── ClayProjectState.swift          ← @MainActor @Observable receiver, big-switch apply, M4

apple/Clarc/Clay/Views/
└── ClayPermissionModal.swift           ← SwiftUI permission modal, M5

apple/Packages/Tests/ClarcCoreTests/Clay/
├── ClayConnectionConfigTests.swift          ← 9 cases (URL shapes)
├── ClayConnectionStatusTests.swift          ← 5 cases (failure classification)
├── ClayConnectionTests.swift                ← 4 cases (offline behaviour)
├── ClayConnectionIntegrationTests.swift     ← 4 cases (NWListener WS mock)
├── ClayConnectionAuthAndResumeTests.swift   ← 2 cases (HTTP+WS unified mock)
├── ClayMessageDispatcherTests.swift         ← 4 cases (incl. 29-fixture replay)
├── ClayOutboundTests.swift                  ← 12 helper snapshots + coverage
├── ClaySessionStateTests.swift              ← 9 cases (coalesce / permissions / resume cursor)
├── ClayProjectStateTests.swift              ← 6 cases (synthetic stream / history equivalence / R5 replay)
├── ClayPermissionResponderTests.swift       ← 6 cases (isPlanTool / generic + plan dispatch / wire shape)
└── Support/
    ├── WebSocketMockServer.swift  ← NWListener + NWProtocolWebSocket
    └── MockDaemonServer.swift     ← Hand-rolled HTTP/1.1 + RFC 6455 WS
```

### Key implementation choices the next session must respect

- **One URLSession per `ClayConnection`** — cookies set by `POST /auth`
  must persist across reconnect. Don't recreate the session on each
  attempt; do recreate the `URLSessionWebSocketTask`.
- **Two distinct "up" states**: `.connected` (transport open) vs.
  `.live` (`info` frame decoded). The dispatcher and view layer should
  gate on `.live`. `client_count` and other early frames arrive between
  the two — that's expected.
- **`info` frame can race ahead of `didOpenWithProtocol`.** Any
  non-terminal pre-live state (`.connecting`, `.connected`,
  `.reconnecting`) must promote to `.live` on receiving `info`. The
  delegate callback must NOT downgrade `.live` back to `.connected`.
  See `ClayConnection.handleFrame` and `handleDidOpen`.
- **`ClayMessageDispatcher` is a pure pump** — no state, no routing
  switch. The receiver (M4: `ClayProjectState`) owns the `switch
  message` and Swift's exhaustiveness check.
- **`ClayOutbound` factories vs. `ClayConnection` extensions**: factories
  build `ClayClientMessage` values (testable without a connection); the
  actor extension methods just `try await send(factory(...))`. Don't
  collapse them — the testability matters.
- **Outstanding R7 work**: `client_count` and any other daemon-emitted
  messages absent from `protocol/types.ts` still need an audit pass
  before M8. Currently dropped by `ClayConnection.handleFrame`'s
  forward-compat decode path.
- **M4 chose `ClarcCore` for state types** (the default option A from
  the previous session). `Observation` is available on macOS 15+ and
  no UI dependency was introduced. Don't split into a new package
  unless iOS/iPadOS work in Phase 2 forces it.
- **`ClaySessionState` is a struct, not a class.** `ClayProjectState`
  stores it in `[Int: ClaySessionState]` and writes the whole struct
  back per mutation. This guarantees `@Observable` notifies on every
  apply and keeps "one writer" ownership unambiguous. Don't refactor
  to class without a concrete reason.
- **delta / thinking coalescing has no `isOpen` flag.** The trailing
  element of `messages` IS the open streaming slot. A `tool_*` (or any
  non-text event) between deltas naturally closes the previous text
  item because `messages.last` is no longer `.assistantText`. Adding a
  flag would re-introduce the special case Linus said to delete.
- **`recordSeq` returns `nil` when the session is in `.loading`
  history mode.** This is how history replay shares the same big
  switch as live streaming without polluting the resume cursor.
  `ClayProjectState.apply` only calls `connection.updateResume` when
  `recordSeq` returns a non-nil value.
- **`updateResume` is fired via a detached `Task`** at the end of
  `apply` (not awaited inline). Reason: `apply` runs on `MainActor`
  and `ClayConnection` is its own actor — awaiting in-line would
  serialize every UI update behind a network actor hop.
- **`message_uuid` is not bound to a chat item today.** We extract its
  `seq` for the resume cursor and otherwise drop it. If/when we need
  to round-trip uuids back to the daemon, add a side index — don't
  retro-fit `UserItem.id` to be the message_uuid.
- **M5 plan-tool detection: `toolName == "ExitPlanMode"`, full stop.**
  `EnterPlanMode` does not require permission. There is no "plan tool
  family" — just one name. `ClayChatItem.PermissionItem.isPlanTool`
  is the canonical check; don't sprinkle string compares elsewhere.
- **M5 plan permission has FOUR buttons, not five.** Web client's
  `renderPlanPermission`: Clear Context / Auto-accept Edits / Manually
  Approve / Reject (mapping to `allow_clear_context`,
  `allow_accept_edits`, `allow`, `deny`). `allow_always` does not
  appear in plan mode.
- **M5 does not stitch `planContent`.** The daemon's
  `pending.toolInput.planFilePath` fallback is sufficient for
  `allow_clear_context` to work. Phase 2 enhancement: watch
  `Write`/`Edit` tool calls whose path matches the daemon's plan
  file path (cf. `daemon/lib/public/app.js:3506`-3520) and stitch
  the resulting markdown into `planContent` on the response.
- **`ClayPermissionResponder` is intentionally narrow.** One method,
  exactly matching the M3 helper. Don't extend it — for any other
  outbound traffic, take a `ClayConnection` directly. The protocol
  exists solely so the modal can be unit-tested with a recording
  mock.
- **The modal owns no dismissal state.** It binds to a single
  `PermissionItem` from the parent. When the daemon echoes
  `permission_resolved` / `permission_cancel`, M4 drops the entry
  from `pendingPermissions`, and the parent's `.sheet(item:)` tears
  the view down. Resume mid-pending works for free: M4's idempotent
  `appendPermissionRequestPending` ensures a re-delivered request
  doesn't duplicate, and SwiftUI re-binds the same view to the same
  item without flicker.

### What M6 / M7 need to do

These are independent and can be tackled in either order or in
parallel. M6 and M7 both depend only on the M1–M5 stack that's
already in tree.

**M6 — Session lifecycle UI** (per §M6 below):
- Sidebar list bound to `ClayProjectState.sessions`. Selection
  drives `activeSessionId` and emits `switch_session` with the
  *target* session's `lastSeq` (read from `sessionStates[target]?
  .lastSeq`) for incremental replay.
- New / delete / rename go through the M3 helpers
  (`newSession`, `deleteSession`, `renameSession`); no new encoders.
- Live updates from the daemon arrive as `session_list` events that
  M4 already lands into `sessions`. The view just observes.

**M7 — Connect screen + persistence** (per §M7 below):
- Two-field form (`wss://host:port/p/<slug>/ws` + token).
  `ClayConnectionConfig.parse` (M1) already validates the URL shape;
  reuse it.
- Persistence layer: URL list in `UserDefaults`, token per URL in
  Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`). New file
  suggested: `apple/Clarc/Clay/Services/ClayConnectionsStore.swift`.
- On Connect: instantiate `ClayConnection`, hook a
  `ClayProjectState` (M4) as the receiver via `ClayMessageDispatcher`,
  and hand both up to whatever shell M9 will build.

### Hidden cost not yet milestoned

Before M9 can run smoke, **a Clay-specific ChatView must exist**.
PLAN R2 mandates forking from `ClarcChatKit` rather than reusing
the legacy ChatView (which binds to `ChatMessage`, not
`ClayChatItem`). Reusable as-is from `ClarcChatKit`: `MarkdownView`,
`ToolResultView`, `BubbleStyle`, `TypingDotsView`,
`AskUserQuestionView`. Need to write fresh:
`ClayMessageListView` (~150 LOC), `ClayMessageBubble` (~200 LOC),
`ClayInputBar` (~80 LOC) — slash commands and attachments are
explicitly out of scope per §2. Estimate: 0.5–1 day. Track this as
**M8.5** when M9 starts; until then it's documented here.

### How to resume in a new session

1. `git log --oneline | head -10` to see the commit chain.
2. `swift test --package-path apple/Packages` should print 72 tests
   passing — if it doesn't, fix that before touching M6/M7.
3. `xcodebuild -project apple/Clarc.xcodeproj -scheme Clarc \
   CODE_SIGNING_ALLOWED=NO build` should succeed. (Metal toolchain
   may need `xcodebuild -downloadComponent MetalToolchain` on a
   fresh Xcode install.)
4. Read this Progress log + §M6 / §M7 below.
5. Pick M6 or M7. M6 is more visible (sidebar populates from a real
   daemon); M7 is more self-contained (no UI binding to existing
   state, just a form). Either is fine.

## 4. Architecture overview

### What gets deleted (M10)

The CLI subprocess mode is removed wholesale. Approximate footprint:

- `Clarc/App/AppState.swift` (~2,167 lines)
- `Clarc/Services/ClaudeService.swift` (CLI process driver)
- `Clarc/Services/PermissionServer.swift` (HTTP hook target for CLI)
- All CLI-specific stdio parsers, hook bootstrap, process lifecycle
- `Models/*` entries that are CLI-only (audit during M10; keep anything
  reused by the WS path)
- `ProjectWindowView` and friends — replaced by the new three-pane
  `ClayMainWindow`

`Packages/Sources/ClarcChatKit/` views are **not** drop-in reusable:
they bind to the existing `ChatMessage` model, while the WS path
produces `ClayChatItem` (different shape — see R2). Plan to fork the
needed components into `Clay/Views/` and adapt, not share.

### What's new

```
Clarc/
├── App/
│   └── ClarcApp.swift                  ← single WindowGroup → ClayMainWindow
└── Clay/                               ← all new code lives here
    ├── Connection/
    │   ├── ClayConnection.swift        ← actor: WS lifecycle, reconnect
    │   ├── ClayConnectionConfig.swift  ← URL, token, last-seq state
    │   └── ClayConnectionStatus.swift  ← enum: idle / connecting / live / failed
    ├── State/
    │   ├── ClayAppState.swift          ← @Observable: top-level app state
    │   ├── ClayProjectState.swift      ← @Observable: per-project mirror
    │   ├── ClaySessionState.swift      ← per-session messages, status, perms
    │   ├── ClayChatItem.swift          ← chat-stream enum (see M4)
    │   └── ClayMessageDispatcher.swift ← decodes ServerMessage → state mutations
    ├── Views/
    │   ├── ClayMainWindow.swift        ← three-pane shell (NavigationSplitView)
    │   ├── ClayProjectRail.swift       ← left rail (1 entry this phase)
    │   ├── ClaySessionList.swift       ← middle pane
    │   ├── ClayChatPane.swift          ← right pane (messages + composer)
    │   ├── ClayConnectScreen.swift     ← full-URL + token entry (sheet/cover)
    │   └── ClayPermissionModal.swift   ← permission decision UI
    └── Persistence/
        └── ClayConnectionsStore.swift  ← recent connections, keychain token
```

The protocol layer (`Packages/Sources/ClarcCore/Protocol/`) is already
shipped; this phase is purely about **using** it.

### Window model

Single window. On launch:
- No saved connection → show `ClayConnectScreen` (modal cover).
- Saved connection → auto-attempt connect, show three-pane
  `ClayMainWindow`. Connection failure surfaces in-pane, not by
  bouncing back to the connect screen.

Three-pane layout uses `NavigationSplitView` (macOS native). The left
rail this phase shows exactly one project entry derived from the
connected URL's slug; the slot exists so Tier 2 can plug in a real
project list without window-level refactor.

## 5. Milestones

Each milestone has a **Deliverable**, **Definition of done (DoD)**, and
**Test gate**. Milestones marked ⟂ can run in parallel.

### M1 — WebSocket connection actor
**Deliverable:** `ClayConnection` actor that connects to a `ws://` or
`wss://` URL, optionally completes the daemon's PIN cookie handshake,
and exposes an `AsyncThrowingStream<ClayServerMessage>` plus a
`send(_: ClayClientMessage)` method. Reconnect on transient failure
with exponential backoff. Surface auth failures distinctly from
network failures.

**Wire-level facts (verified 2026-04-29 via R4 prototype against a
live daemon, see `protocol/scripts/r4-handshake.mjs`):**
- Daemon port + TLS come from `~/.clay/daemon.json` (`port`, `tls`).
  Default observed config: port 2633, `tls: false` → use `ws://`.
- PIN handshake is **optional**. When `pinHash` in `daemon.json` is
  null, the WS upgrade succeeds with no `/auth` step. When PIN is set,
  client must `POST /auth {"pin":...}` and forward the resulting
  `relay_auth` cookie on the WS upgrade.
- The first frame after upgrade is **not guaranteed to be `info`**.
  Daemon emits `client_count` ahead of `info` in single-user mode.
  Connection actor must consume frames until an `info` arrives before
  flipping to `.live`.

**Reference implementation: the daemon's bundled web client.** Mirror
its strategies exactly — they're known-good against the real daemon.
Key citations in `daemon/lib/public/app.js`:

| Behaviour | Web-client rule | M1 mirror |
|-----------|-----------------|-----------|
| URL build | `proto + "//" + host + "/p/<slug>/ws"`; on reconnect append `?resumeSession=<id>&lastSeq=<n>` (app.js:2900-2911) | Compose `URLComponents` the same way; `lastSeq` per `slug:sessionId` |
| Cookie auth | Browser auto-attaches `relay_auth` cookie (server.js:460-494) | Use shared `HTTPCookieStorage`; `POST /auth` first if PIN supplied |
| Connect timeout | If `onopen` doesn't fire within 3000ms, close + retry (app.js:2914-2922) | Same 3s timer guarding `URLSessionWebSocketTask.resume()` |
| Reconnect backoff | `delay = min(delay * 1.5, 10000)`, start 1000ms, reset on successful onopen (app.js:1011-1012, 2943, 4191-4208) | Same constants. **Do not** invent a fancier scheme. |
| Auth re-probe | Before each reconnect: `fetch("/info")`; on 401 → `location.reload()` (app.js:4196-4199) | `GET /info` HTTP probe before reconnect; 401 → terminate with `.failed(.authExpired)`. Prevents infinite retry loop after PIN rotation. |
| "Connected" vs "live" | `onopen` = transport up (status: connected); `info` frame = project ready (status: live). `client_count` arrives in between (app.js:3229, 3120) | Two distinct statuses in `ClayConnectionStatus`: `.connected` and `.live` |
| Send while offline | No buffering; show toast "Not connected — message not sent" (input.js:92-95) | `send(_:)` throws `ClayConnectionError.notConnected`. No queue. |
| `lastSeq` tracking | After every msg with `seq`: `lastSeq = msg.seq + 1` (app.js:3042-3043) | Same. Cache key `"\(slug):\(sessionId)"`. |
| Resume protocol | Server replies `history_meta { resumed: true }` for incremental, or `false` then full replay → reset `lastSeq = -1` (app.js:3047-3070) | Dispatcher (M2) implements; M1 just plumbs `lastSeq` through |
| Heartbeat | None — TCP keep-alive only | Don't add app-level ping. Trust transport. |

**DoD:**
- Connect → onopen → status `.connected`; on `info` decode → `.live`
- Both `ws://` (no auth) and `wss://` + PIN cookie paths covered
- Reconnect uses `lastSeq` + `resumeSession` query params
- Pre-reconnect `GET /info` 401 → `.failed(.authExpired)`, no retry
- Reconnect after network blip resumes within 10s
- Disconnect → all in-flight `send` calls fail; stream terminates
- No send buffer; offline `send(_:)` throws
- No retain cycles (URLSession delegate holds weak ref to the actor)

**Test gate:** unit test against a local mock WS server (use
`Network.framework` listener inside the test). 6 cases minimum:
connect / disconnect / reconnect-resume / connect-timeout (3s) /
auth-fail (401 on /info) / send-while-offline.

---

### M2 — Inbound dispatcher ⟂
**Deliverable:** `ClayMessageDispatcher` that reads from
`ClayConnection`'s stream, decodes into `ClayServerMessage`, and routes
each variant to a state mutation closure on `ClayProjectState`. Unknown
message types are logged and dropped (forward-compat).

**DoD:**
- Every Tier 1 server case has a handler stub (may be empty for now)
- Backpressure: dispatcher cannot block the WS read loop indefinitely
- Decode errors are logged with the offending bytes (truncated)

**Test gate:** replay every `protocol/fixtures/s2c/*.json` through the
dispatcher and assert the expected state mutation occurs (or, for
stubbed handlers, that it's at least called).

---

### M3 — Outbound encoder ⟂
**Deliverable:** Thin convenience layer on top of `ClayConnection.send`
exposing typed methods: `sendMessage(text:)`, `newSession()`,
`switchSession(id:lastSeq:)`, `permissionResponse(...)`, etc. — one per
`ClayClientMessage` case.

**DoD:**
- Every Tier 1 client case has a method
- Methods are `async` and propagate connection errors

**Test gate:** snapshot the JSON bytes produced by each helper against
the corresponding `protocol/fixtures/c2s/*.json` (modulo optional fields
that the helper omits).

---

### M4 — ClayProjectState (chat state mirror)
**Deliverable:** `@Observable` `ClayProjectState` owning:
- `sessions: [ClaySessionListEntry]`
- `activeSessionId: Int?`
- `connection: ClayConnectionStatus`
- per-session: `messages: [ClayChatItem]`, `processingStatus`,
  `pendingPermissions`, `lastSeq`, `lastUsage`/`lastCost`
- `info: ClayServerMessage.Info?`, `modelInfo`, `configState`

`ClayChatItem` is a Swift enum mapping over the streaming events:
`.user(text)`, `.assistantText(streamingFragments)`, `.thinking(...)`,
`.toolCall(id, name, input, result?)`, `.permission(request)`, etc.
Stream `delta` events MUST coalesce into a single growing fragment, not
N `.assistantText` items.

**DoD:**
- All M2 stubbed handlers now apply real mutations
- History replay (`history_meta` → N items → `history_done`) produces a
  ChatItem list equivalent to live streaming
- `seq`-based incremental replay supported on reconnect

**Test gate:** scripted "session replay" test using a synthetic stream
of fixtures (user_message → 4×delta → tool_start → tool_executing →
tool_result → result → done) and assert final `messages` array.

---

### M5 — Permission flow
**Deliverable:** `permission_request` and `permission_request_pending`
both surface as a modal dialog (reuse `Views/Permission/` modal style).
Decision UI offers: allow once / allow always / deny / (for plan
tools) accept-edits / clear-context. User input is encoded as
`PermissionResponse` and sent. On `permission_resolved` or
`permission_cancel`, the modal dismisses.

**DoD:**
- Modal handles all five `ClayPermissionDecision` cases
- Reconnect mid-pending: `permission_request_pending` re-renders the
  modal correctly without duplicating it
- `decisionReason` is shown to the user when non-empty

**Test gate:** UI test with a recorded fixture stream that triggers a
permission request; assert modal appears, simulate decision, assert the
correct `permission_response` bytes are sent.

---

### M6 — Session lifecycle UI
**Deliverable:** Sidebar list bound to `sessions`. New / switch /
delete / rename via existing-style sidebar interactions, all going
through M3 helpers. `switch_session` always includes `lastSeq` from
local state for incremental replay.

**DoD:**
- Switching a session preserves any unread state correctly
- Deleting the active session selects the most-recently-active sibling
  (or implicitly creates a new one — match daemon behaviour)
- Renaming round-trips through `rename_session` and updates the list

**Test gate:** integration test driving session-list mutations against
a real daemon instance launched in-test.

---

### M7 — Connect screen + persistence ⟂ (after M1)
**Deliverable:** `ClayConnectScreen` with two fields: full WS URL
(`wss://host:port/p/<slug>/ws`) and token/PIN. "Connect" launches
`ClayConnection`. On success, dismisses to the three-pane
`ClayMainWindow` and stashes the connection in `ClayConnectionsStore`
(URL in defaults, token in keychain). Recent connections list lets the
user one-click reconnect to a previously used URL.

**DoD:**
- Validation: reject empty/malformed URL; require `ws://` or `wss://`
  scheme; require `/p/<slug>/ws` path shape
- Auth failure → inline error, fields stay populated
- Token stored with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
- Removing a recent connection deletes its keychain entry too

**Test gate:** manual QA checklist (no UI test framework needed).
Keychain interaction unit-tested with an in-memory mock.

---

### M8 — Daemon-side polish
**Deliverable:**
- Add `protocolVersion: "1"` to the `info` payload in
  `daemon/lib/project.js:1035`
- Add a daemon test that hits each Tier 1 emit site at least once and
  asserts the emitted JSON validates against
  `protocol/fixtures/<type>.json`'s structural shape
- Update `protocol/README.md` to note v1 is now wired on both sides

**DoD:**
- `info` fixture and types.ts updated to include `protocolVersion`
  (still optional — old clients tolerate missing field)
- Existing daemon tests stay green
- Apple `info` decoder accepts the new field

**Test gate:** `node --test test/` and `swift test` both green.

---

### M9 — App entry point + smoke test
**Deliverable:** `ClarcApp` boots straight into `ClayMainWindow`. If no
saved connection exists, the connect screen is shown as a modal cover.
End-to-end smoke flow documented in `apple/docs/clay-mode.md`.

**DoD:**
- `just daemon-dev` running locally → Clarc connects → user sends
  "hello" → assistant streams reply → done. No console errors.
- One screen recording of the smoke flow, committed as
  `apple/media/clay-mode-smoke.mov`.

**Test gate:** manual smoke against a real daemon. CI runs the
automated portions of M1-M6.

---

### M10 — Delete CLI subprocess mode
**Deliverable:** Remove all code listed in §4 "What gets deleted".
This milestone runs **last** — only after M1–M9 have shipped a working
WS path. Until then, the CLI code stays in tree but is no longer wired
to any window.

**DoD:**
- `Clarc/App/AppState.swift`, `Clarc/Services/ClaudeService.swift`,
  `Clarc/Services/PermissionServer.swift` deleted
- All CLI-specific `Models/*` files deleted; survivors audited and
  documented in `apple/docs/clay-mode.md`
- `ProjectWindowView` and CLI-only views removed
- Project compiles, `swift test` green, app launches into
  `ClayMainWindow` cleanly
- No dead `import` or unreferenced symbol warnings

**Test gate:** full `xcodebuild test` + manual smoke flow (§9) re-run
with the deleted code gone.

## 6. Risks

| # | Risk | Likelihood | Mitigation |
|---|------|------------|------------|
| R1 | URLSession WebSocket task has known cold-reconnect quirks on flaky networks | Medium | Wrap reconnect logic in M1 with explicit timer and idempotent backoff; consider falling back to `Network.framework` if URLSession misbehaves |
| R2 | `ClayChatItem` shape diverges from the legacy `ChatMessage` model — ChatKit views can't be reused as-is | Certain | Don't try to share models or views. Fork the needed ChatKit components into `Clay/Views/` and bind them directly to `ClayChatItem`. The legacy ChatKit goes away with M10. |
| R3 | Permission UI cases don't 1:1 match existing `Views/Permission/` styles | Medium | Treat existing modal as a starting style, not a contract. Build a Clay-specific permission modal if needed; defer unification to Phase 2 |
| R4 | Daemon's auth flow (`/p/{slug}` PIN handshake) is more involved than expected — may need cookie/session header on WS upgrade | Medium | Read `daemon/lib/server.js` `handleUpgrade` carefully *before* M1 starts. Prototype the connect dance in a 50-line throwaway script first. |
| R5 | `seq`-based incremental replay has subtle edge cases when daemon emits messages between disconnect-and-reconnect | Medium | M4 must explicitly test: client at seq=N → daemon emits N+1, N+2 → client reconnects with `lastSeq=N` → expects exactly N+1, N+2. Add a regression test fixture. |
| R6 | Deleting CLI subprocess mode (M10) breaks something we forgot was using it | Medium | M10 runs last, after smoke flow proves WS path works. Audit `Models/*` and view bindings carefully; keep a revert-ready commit until manual smoke re-passes. |
| R7 | `protocol/types.ts` doesn't cover every message the daemon emits — e.g. `client_count` is sent on connect but isn't in the Tier 1 schema. (Resolved: `info.osUsers` was originally typed as `OsUser[]?` while the daemon emits boolean `false`; the schema and Apple Codable mirror have been corrected to `boolean?`.) | Medium | M2 dispatcher already drops unknown types with a log line, so unknown messages are safe. Before M8, do a one-pass audit of `daemon/lib/project.js` `sendTo(...)` call sites and reconcile with `protocol/types.ts`. Add missing Tier 1 messages, defer the rest to Tier 2 explicitly. |

## 7. Cross-cutting tasks

- **CI**: extend GitHub Actions (`.github/workflows/`) to run `swift
  test` for the apple package and `node --test test/` for daemon on
  every PR. Both already work locally; this phase wires them.
- **Logging**: agree on a single OSLog subsystem
  (`com.idealapp.Clarc.clay`) for all new code. WS frames at debug
  level; state mutations at info; errors at error.
- **Dev ergonomics**: add `just clay-dev` recipe that starts the
  daemon and prints the connect URL+token for paste-into-Clarc.
- **Telemetry / metrics**: explicitly out of scope. No analytics.

## 8. Definition of done — Phase 1

- [ ] Each milestone's DoD met (M1 through M10)
- [ ] `just daemon-test` and `swift test` both green on CI
- [ ] One macOS user (the maintainer) can complete the §9 smoke flow
- [ ] `protocol/types.ts` updated to v1.1 with `protocolVersion`;
      changelog entry in `protocol/README.md`
- [ ] CLI subprocess mode fully removed (M10); `xcodebuild test` green
      on the post-deletion tree
- [ ] PLAN.md updated with actual completion date and any deferred
      items moved to a Phase 2 section

## 9. Smoke flow (the demo we're trying to enable)

1. Start daemon: `just daemon-dev`
2. Launch Clarc (first run) → connect screen appears
3. Enter `wss://localhost:2635/p/<slug>/ws`, PIN/token if prompted
4. Connect screen dismisses; three-pane main window appears (project
   rail / session list / chat)
5. Select existing session or click "New session" in the middle pane
6. Type "list the files in this directory" and hit send
7. See `LS` tool execute, permission modal appears, click Allow
8. See tool result, then streaming assistant text, then "done"
9. Quit Clarc, reopen → auto-reconnects to last URL; if it fails, the
   connect screen reappears with the URL pre-filled

Anything in that flow that doesn't work end-to-end means Phase 1 is not
done.
