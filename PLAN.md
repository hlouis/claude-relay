# Phase 1 — Tier 1 Protocol End-to-End

> **Status:** approved (2026-04-29). All §3 decisions resolved.
> **Owner:** TBD. **Target completion:** TBD.
> **Prereqs done:** `protocol/types.ts`, fixtures, daemon round-trip test,
> Apple Codable mirror — all green as of `9f1d83b`.
> **Latest progress:** M1–M7 + M8.5 + M9 (code) shipped.
> 86 Swift tests + 85 daemon tests green; `xcodebuild` Debug build
> green; ClarcApp now boots straight into the Clay flow. **The
> M9 smoke recording is the only remaining acceptance step** —
> needs a human at the keyboard with a running daemon. **M8 is
> deferred** — keep the daemon at zero Phase 1 changes; revisit
> only if the M9 smoke exposes a real protocol mismatch.

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
- **D4 — Add `protocolVersion: "1"` to `info`.** ~~One-string daemon
  change; cheap insurance against silent v2 drift.~~ **Deferred
  (2026-04-30).** Phase 1 keeps the daemon at zero changes so the
  M1–M7 client mirrors are validated against the daemon-as-shipped.
  Revisit after M9 smoke: if everything talks cleanly, this becomes
  optional cosmetic insurance; if smoke surfaces a real schema
  mismatch, it folds into the fix-up commit anyway.

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
| **M6** Session lifecycle UI | ✅ DoD met | `1ac1031` `927cd5b` | 6 commands/lastSeqForResume unit tests; `xcodebuild` Debug build green with sidebar view |
| **M7** Connect screen + persistence | ✅ DoD met | `0fea4a3` `50aaa16` | 6 store unit tests with in-memory keychain mock; `xcodebuild` Debug build green with connect screen |
| **M8.5** Clay ChatView fork | ✅ DoD met | `bc98a2d` `0ccd6a0` `b7bf87c` | 2 message-sender unit tests; ChatKit patch (3 types made public, zero behavioural change); `xcodebuild` Debug build green with three new views |
| **M9** App entry point + smoke | 🟡 code shipped, smoke pending | `4376c1b` `eb6f6f4` `4be71ef` `3e82d3e` | ClayShell triplet coordinator + three-pane ClayMainWindow + ClarcApp entry rewrite + Legacy shim file + `apple/docs/clay-mode.md` smoke guide. Manual smoke + recording (`apple/media/clay-mode-smoke.mov`) is the remaining acceptance step. |
| R7 fix: `info.osUsers` schema | ✅ | `9e493ec` | Was: `OsUser[]?`. Now: `Bool?`. `OsUser` / `ClayOsUser` deleted. |
| **M8** Daemon polish | ⏸ deferred | — | See D4 / §M8: Phase 1 ships with zero daemon changes. Revisit only if M9 smoke surfaces a real protocol mismatch. |

### Test totals (post-M9 code drop)
- Apple: **86 tests / 22 suites / ~3.3 s** (`swift test --package-path apple/Packages`)
- Daemon: **85 tests** (`node --test daemon/test/*.js`)
- App target: `xcodebuild -project apple/Clarc.xcodeproj -scheme Clarc build` green
- Manual smoke against `just daemon-dev`: **pending** (acceptance step)

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
│   ├── ClayPermissionResponder.swift   ← protocol + isPlanTool extension, M5
│   ├── ClaySessionCommands.swift       ← protocol + lastSeqForResume extension, M6
│   └── ClayMessageSender.swift         ← protocol for outbound user message, M8.5
├── Services/
│   ├── ClayConnectionsStore.swift      ← UserDefaults + Keychain coordinator + in-memory mock, M7
│   └── ClaySystemKeychainStore.swift   ← Security.framework SecItem implementation, M7
└── State/
    ├── ClayChatItem.swift              ← chat-stream enum + 7 payload structs, M4
    ├── ClaySessionState.swift          ← per-session value type + coalesce mutators, M4
    └── ClayProjectState.swift          ← @MainActor @Observable receiver, big-switch apply, M4

apple/Packages/Sources/ClarcChatKit/  ← M8.5 made these public (zero behavioural change):
- MarkdownView.swift::MarkdownContentView (markdown rendering)
- BubbleStyle.swift::BubbleStyle + bubbleStyle(_:) helper
- TypingDotsView.swift::PulseRingView (streaming pulse indicator)

apple/Clarc/Clay/Views/
├── ClayPermissionModal.swift           ← SwiftUI permission modal, M5
├── ClaySessionListView.swift           ← SwiftUI session sidebar, M6
├── ClayConnectScreen.swift             ← SwiftUI connect form + recents, M7
├── ClayMessageBubble.swift             ← ChatItem switch (markdown / tool / etc.), M8.5
├── ClayMessageListView.swift           ← scroll list + auto-scroll-to-bottom, M8.5
├── ClayInputBar.swift                  ← TextField composer + send button, M8.5
└── ClayMainWindow.swift                ← three-pane shell + connect sheet + permission sheet, M9

apple/Clarc/Clay/Shell/
└── ClayShell.swift                     ← @Observable triplet coordinator, M9

apple/Clarc/Legacy/
└── LegacyShims.swift                   ← FocusedValues.startNewChat + ProjectWindowValue
                                          shims so legacy AppState/MainView/ProjectWindowView
                                          still compile until M10 deletes them, M9

apple/Clarc/App/ClarcApp.swift          ← Phase 1 entry point — Clay only, M9
apple/docs/clay-mode.md                 ← M9 smoke flow guide

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
├── ClaySessionCommandsTests.swift           ← 6 cases (lastSeqForResume / pass-through / target cursor / wire shape)
├── ClayConnectionsStoreTests.swift          ← 6 cases (round-trip / re-save / sort order / pin clear / delete / parser sanity)
├── ClayMessageSenderTests.swift             ← 2 cases (recording mock pass-through / wire shape)
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
  messages absent from `protocol/types.ts` still need an audit pass.
  Originally scheduled before M8; now that M8 is deferred the audit
  rides with whatever Phase 1 follow-up reopens M8 (or never, if
  smoke clears without daemon changes). Currently dropped by
  `ClayConnection.handleFrame`'s forward-compat decode path — safe.
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
- **M6 sidebar trusts the daemon's broadcast.** No optimistic
  state. Tap → send → daemon broadcasts `session_switched` /
  `session_list` → M4 lands them → SwiftUI re-renders. Don't be
  tempted to pre-flip `activeSessionId` on tap.
- **`switch_session` carries the TARGET session's `lastSeq`.**
  Easy to confuse with the active session's. `ClayProjectState
  .lastSeqForResume(sessionId:)` is the canonical lookup; use it
  rather than reading `sessionStates[id]?.lastSeq` inline so the
  rule stays in one tested place.
- **Daemon picks the replacement on delete.** `sessions.js:411-419`
  selects the most-recently-active sibling, or creates a new
  session if the deleted one was the last. The client just sends
  `delete_session` and waits for the resulting `session_switched`
  + `session_list`. Don't second-guess this on the client.
- **M7 split storage by sensitivity.** Recent URL list goes to
  `UserDefaults` (plain JSON, non-secret). Per-URL PIN goes to
  Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
  Don't merge the two — a future debug-export feature should be
  able to dump the URL list without leaking tokens.
- **`ClayKeychainStore` is the test seam.** The system Keychain
  conformer (`ClaySystemKeychainStore`) has zero unit tests by
  design — exercise it manually when touching it. All store-
  level logic tests run against `ClayInMemoryKeychainStore`
  shipped in the same target.
- **Connect screen is dumb about networking.** `ClayConnectScreen`
  produces a validated `ClayConnectionConfig` and calls
  `onConnect`. Instantiating `ClayConnection`, attaching a
  `ClayMessageDispatcher` (M2), and wiring `ClayProjectState`'s
  `connectionRef` is the M9 shell's job. Don't entangle the
  form with the actor lifecycle.
- **Re-save bumps timestamp without duplicating.** The store
  upserts on `url` as the primary key. Three places in
  `ClayConnectionsStore.save` make this trivial; don't refactor
  to "find or insert" without keeping the test coverage.

### M8.5 lessons (key implementation choices)

- **Make ChatKit reusables `public`, don't fork them.**
  `MarkdownContentView`, `BubbleStyle`, and `PulseRingView` had
  zero environment dependencies — three small `public` keyword
  edits beat a 781-LOC markdown re-implementation. Apply the
  same logic to anything else with no `@Environment(WindowState
  / ChatBridge)` coupling. Anything that DOES depend on
  WindowState (notably `ToolResultView`'s inspector/diff hooks
  and `AskUserQuestionView`'s answer handler) — fork instead;
  the WindowState refactor risk is real.
- **Tool block is hand-rolled, not a `ToolResultView` reuse.**
  M8.5 ships a ~120-LOC `ClayToolBlock` inside
  `ClayMessageBubble.swift`. No file-preview / diff hooks; no
  ToolCategory dispatch; no transient-tool hiding. If those are
  wanted in Phase 2, do them after M10 deletes the legacy code
  so there's no churn risk. Don't introduce a `ClayChatItem
  .ToolItem -> ToolCall` adapter just to reuse the legacy view —
  it's a slippery slope back to `WindowState` coupling.
- **Auto-scroll triggers on three signals.** `messages.count`,
  `trailingTextLength` (so delta coalesce keeps the bottom
  pinned), and `processingStatus` flips. There's no "user
  scrolled up — pause auto-scroll" yet (Phase 2 polish).
- **InputBar is gated on `processingStatus`**, not on the local
  `inFlight` flag alone. The daemon would queue an over-send,
  but the UX is clearer if the composer disables itself the
  moment the previous turn starts streaming.
- **`clientMsgId` is auto-generated on every send.** M4 echoes
  it via `user_message.clientMsgId`; the daemon uses it to
  dedupe optimistic renders. Phase 1 doesn't render
  optimistically (the input bar just clears and waits for the
  echo) but the field is wired so Phase 2 can flip it on.

### M9 lessons (key implementation choices)

- **`ClayShell` only flips mode on `.live` and `.failed`.**
  Transient `.connecting` / `.reconnecting` / `.connected` stay
  in current mode — the chat view doesn't lose its session on a
  brief blip. M4 already exposes the fine-grained status via
  `project.connection` for any badge that wants it.
- **On `.failed`, the shell tears down the triplet.** Auth
  failures don't auto-reconnect; transport failures only land
  here after M1's reconnect loop gave up. A subsequent
  `connect()` call rebuilds it cleanly. Don't try to reuse the
  failed `ClayConnection` actor — it's done.
- **Permission `.sheet(item:)` uses a synthetic Binding.** The
  setter is a no-op. Dismissal flows through M4's
  `permission_resolved` / `permission_cancel` handlers, which
  remove the entry from `pendingPermissions` — SwiftUI tears
  the sheet down when the binding's getter goes nil. Resume
  mid-pending stays idempotent.
- **Legacy code is parked, not deleted.** `apple/Clarc/Legacy/
  LegacyShims.swift` carries the two declarations
  (`FocusedValues.startNewChat`, `ProjectWindowValue`) that the
  legacy MainView / ProjectWindowView reference but the new
  ClarcApp no longer provides. M10 deletes the shim alongside
  everything else. Don't fold these into ClarcApp.swift "for
  cleanliness" — the file boundary makes M10's cleanup a
  one-line `rm`.
- **NavigationSplitView 3-column on macOS 15+ works fine** for
  D3's three-pane layout. No HSplitView / custom resize logic
  needed; column-width hints
  (`.navigationSplitViewColumnWidth(min:ideal:max:)`) are
  enough.

### What M9 acceptance still needs

The code is in tree (`4376c1b` `eb6f6f4` `4be71ef` `3e82d3e`)
and `xcodebuild` is green. The remaining acceptance tasks are
all manual:

1. Open `apple/Clarc.xcodeproj` in Xcode and run (⌘R).
2. Run `just daemon-dev` in another terminal; copy the URL/PIN
   from its log.
3. Walk through the seven steps in `apple/docs/clay-mode.md`.
4. If any step fails because of a daemon-side issue, **stop and
   re-evaluate M8 explicitly** — do not silently edit `daemon/`.
   Reopening M8 requires a deliberate decision and a PLAN
   amendment.
5. Capture a screen recording at
   `apple/media/clay-mode-smoke.mov`.
6. Update §3a status from "🟡 code shipped, smoke pending" to
   "✅ DoD met" with the recording sha.

### What M10 needs to do (the final cleanup)

After M9 smoke is signed off:

- Delete the entire CLI-subprocess mode per §M10 below. The
  parked legacy code is concentrated in:
  - `apple/Clarc/App/AppState.swift` (~2167 LOC)
  - `apple/Clarc/Services/ClaudeService.swift`,
    `PermissionServer.swift` (CLI process driver + hook server)
  - `apple/Clarc/Views/MainView.swift`,
    `ProjectWindowView.swift`, `SettingsView.swift`,
    `Sidebar/`, `Onboarding/`, `Permission/`, `Terminal/`
  - `apple/Clarc/Legacy/LegacyShims.swift` (the M9 shim)
  - The Clay flow's `import ClarcChatKit` reuses survive: M10
    only deletes `ChatBridge.swift`, `ChatView.swift`,
    `MessageBubble.swift`, `MessageListView.swift`,
    `InputBarView.swift`, `SlashCommand*.swift`,
    `ShortcutManagerView.swift`, `StatusLineView.swift`,
    `AttachmentPreviewItem.swift`, `WebPreviewButton.swift`,
    `FileDiffView.swift`. Keep `MarkdownView.swift`,
    `BubbleStyle.swift`, `TypingDotsView.swift` — Clay views
    depend on them. `ToolResultView.swift` and
    `AskUserQuestionView.swift` are deletable (Clay didn't
    fork them).
- Audit `Models/*.swift`: `ChatMessage.swift`,
  `Attachment.swift`, etc. die. `JSONValue.swift`,
  `ClaySessionState.swift`, etc. survive.
- After deletion: `xcodebuild test` green and a manual
  re-run of the §9 smoke flow.

### How to resume in a new session

1. `git log --oneline | head -15` to see the commit chain (M9
   spans four commits).
2. `swift test --package-path apple/Packages` should print 86 tests
   passing.
3. `xcodebuild -project apple/Clarc.xcodeproj -scheme Clarc \
   CODE_SIGNING_ALLOWED=NO build` should succeed.
4. `node --test daemon/test/*.js` should print 85 tests passing.
   **The daemon must stay at zero Phase 1 changes** between M7
   close (`50aaa16`) and the smoke sign-off — if you find
   yourself editing under `daemon/`, stop and re-read D4.
5. **Run the smoke flow** per `apple/docs/clay-mode.md`. Open
   `apple/Clarc.xcodeproj` in Xcode, ⌘R, in a separate terminal
   `just daemon-dev`, paste the URL into the connect screen, walk
   the seven steps. Record `apple/media/clay-mode-smoke.mov`.
6. If smoke passes: flip M9 to ✅ in §3a, then start M10.
7. If smoke fails because of a daemon issue: stop, re-evaluate
   M8 explicitly, amend PLAN before touching `daemon/`.

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

### M8 — Daemon-side polish ⚠️ DEFERRED (2026-04-30)

**Status:** deferred behind M9 smoke. Phase 1 ships with zero daemon
changes; the M1–M7 client code is validated against the
daemon-as-shipped. Revisit only if M9 smoke surfaces a real protocol
mismatch — and even then, require explicit approval before editing
`daemon/`. See D4 above for rationale.

Original deliverable retained for reference (do not implement
without explicit approval):
- Add `protocolVersion: "1"` to the `info` payload in
  `daemon/lib/project.js:1035`
- Add a daemon test that hits each Tier 1 emit site at least once and
  asserts the emitted JSON validates against
  `protocol/fixtures/<type>.json`'s structural shape
- Update `protocol/README.md` to note v1 is now wired on both sides

---

### M8.5 — Clay-specific ChatView fork
**Deliverable:** Fork the chat view layer from `ClarcChatKit` so it
binds to `ClayChatItem` (M4) instead of the legacy `ChatMessage`.
Three new files in `apple/Clarc/Clay/Views/`:

- `ClayMessageListView.swift` — ScrollView + `LazyVStack` over
  `[ClayChatItem]`. Auto-scroll-to-bottom while
  `processingStatus == .processing`. No older-message fold; no
  long-text fold (R2-style: deletable cosmetic features stay
  deleted in Phase 1).
- `ClayMessageBubble.swift` — `switch` over `ClayChatItem` cases:
  - `.user` → user-style bubble, plain text.
  - `.assistantText` → MarkdownView bubble.
  - `.thinking` → muted text block with optional duration footer.
  - `.tool` → ToolResultView via a `ClayChatItem.ToolItem →
    ToolCall` adapter (~30 LOC, throwaway with M10).
  - `.permission` → compact summary (the modal handles input;
    this is just an inline echo).
  - `.result` → cost/usage footer block.
  - `.systemError` → red error pill.
- `ClayInputBar.swift` — TextField + send button. Out of scope:
  slash, attachments, shortcuts, edit-and-resend.

Plus a `ClayMessageSender` protocol in ClarcCore (mirrors the
M5/M6/M7 narrow-protocol pattern) so the input bar can be
unit-tested with a recording mock.

**DoD:**
- The three views render correctly in `#Preview` against a
  hand-crafted `ClayProjectState` containing every Tier 1 case.
- `ClayInputBar` sends `sendMessage(text:)` via the protocol.
- xcodebuild Debug build of `Clarc` target green.
- Reuses `MarkdownView`, `ToolResultView`, `BubbleStyle`,
  `TypingDotsView`, `AskUserQuestionView` from `ClarcChatKit`
  as-is (zero source changes there). The legacy `ChatView` and
  `MessageBubble` stay untouched until M10.

**Test gate:** `swift test` green (covers the new
`ClayMessageSender` mock). View rendering verified manually via
`#Preview`.

---

### M9 — App entry point + smoke test
**Deliverable:** `ClarcApp` boots straight into `ClayMainWindow`. If no
saved connection exists, the connect screen (M7) is shown as a sheet
cover. End-to-end smoke flow documented in `apple/docs/clay-mode.md`.

`ClayMainWindow` is the three-pane shell from D3:
- Left rail: stub (single fixed entry; multi-project waits for Tier 2).
- Middle pane: `ClaySessionListView` (M6).
- Right pane: `ClayMessageListView` + `ClayInputBar` (M8.5).
- Permission `.sheet(item:)` bound to
  `activeSessionState?.pendingPermissions.values.first` (M5).

The shell owns one `ClayConnection`, one `ClayMessageDispatcher`, and
one `ClayProjectState`. Wiring:

```
ClayConnectionsStore → URL/PIN
       ↓
ClayConnectScreen → ClayConnectionConfig
       ↓
ClayConnection (actor) ──┐
       │                 ├─→ ClayMessageDispatcher
       │                 │       ↓
       │                 │   ClayProjectState (@Observable)
       │                 ↑       │
       └─ updateResume ─ connectionRef
```

**DoD:**
- `just daemon-dev` running locally → Clarc launches → user enters
  the URL printed by the daemon → connect screen dismisses →
  ClayMainWindow shows → user sends "hello" → assistant streams
  reply → permission dialog appears for any tool → user approves →
  reply completes. No console errors.
- **Zero daemon changes in any commit since M7 closed.** If smoke
  fails because of a daemon-side issue, stop and re-evaluate M8;
  do not silently edit `daemon/`.
- One screen recording of the smoke flow, committed as
  `apple/media/clay-mode-smoke.mov`.

**Test gate:** manual smoke against a real daemon. CI runs the
automated portions of M1–M8.5.

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

- [ ] Each non-deferred milestone's DoD met (M1–M7, M8.5, M9, M10).
      M8 is deferred — see D4 / §M8.
- [ ] `just daemon-test` and `swift test` both green on CI
- [ ] One macOS user (the maintainer) can complete the §9 smoke flow
- [ ] **Zero daemon changes in the Phase 1 commit range.** If M9
      smoke needed a daemon fix, M8 was reopened with explicit
      approval and the change is documented in the commit body.
- [ ] CLI subprocess mode fully removed (M10); `xcodebuild test` green
      on the post-deletion tree
- [ ] PLAN.md updated with actual completion date and any deferred
      items (currently at least M8) moved to a Phase 2 section

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
