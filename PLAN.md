# Phase 1 — Tier 1 Protocol End-to-End

> **Status:** approved (2026-04-29). All §3 decisions resolved.
> **Owner:** TBD. **Target completion:** TBD.
> **Prereqs done:** `protocol/types.ts`, fixtures, daemon round-trip test,
> Apple Codable mirror — all green as of `9f1d83b`.

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
| R7 | `protocol/types.ts` doesn't cover every message the daemon emits — e.g. `client_count` is sent on connect but isn't in the Tier 1 schema | Medium | M2 dispatcher already drops unknown types with a log line, so behaviour is safe. Before M8, do a one-pass audit of `daemon/lib/project.js` `sendTo(...)` call sites and reconcile with `protocol/types.ts`; add missing Tier 1 messages, defer the rest to Tier 2 explicitly. |

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
