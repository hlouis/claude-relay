# Clay mode (Phase 1) — smoke flow

Phase 1 of `claude-relay` ships a macOS native client (Clarc) that
talks to the local Clay daemon over WebSocket using only Tier 1
protocol messages. This document is the manual smoke flow used to
validate the end-to-end path; it is the §9 demo from `PLAN.md`.

## Prerequisites

- macOS 15+, Xcode 26 with Swift 6.2.
- Daemon checked out at `daemon/` and dependencies installed
  (`just daemon-install`).
- No code-signing identity required — `xcodebuild` flags below skip
  it; running from Xcode uses the default development team.
- Metal Toolchain present
  (`xcodebuild -downloadComponent MetalToolchain` if missing).

## Build the app

```sh
xcodebuild \
  -project apple/Clarc.xcodeproj \
  -scheme Clarc \
  -configuration Debug \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build
```

Expected: `** BUILD SUCCEEDED **`. The compiled `.app` lands in
`~/Library/Developer/Xcode/DerivedData/Clarc-*/Build/Products/Debug/Clarc.app`.

For interactive runs, prefer opening `apple/Clarc.xcodeproj` in
Xcode and pressing ⌘R.

## Run the daemon

```sh
just daemon-dev
```

Expected output includes a project URL and an optional PIN. Example:

```
[clay] open  http://localhost:2635/p/demo-1234abcd
[clay] PIN   8421
```

The full WebSocket URL Clarc expects is the same path with the `ws`
scheme:

```
wss://localhost:2635/p/demo-1234abcd/ws
```

(Use `ws://` instead of `wss://` if the daemon was started with
`--no-https`.)

## Smoke flow

1. **Launch Clarc.** The connect screen appears as a sheet.
2. **Paste the WebSocket URL** into the URL field. Paste the PIN
   into the PIN field if the daemon printed one; leave blank
   otherwise.
3. **Click Connect.** The sheet dismisses and the three-pane main
   window comes up:
   - Left rail: a single "Project" stub.
   - Middle: session list (initially one auto-created session).
   - Right: empty chat with the input bar at the bottom.
4. **Send "hello".** The user bubble appears immediately; the
   assistant streams a response. The streaming pulse indicator
   is visible at the bottom of the message list while
   `processingStatus == .processing`.
5. **Trigger a tool call.** Send `list the files in /tmp` (or any
   request that nudges the agent into Bash). When the agent calls
   `Bash`:
   - A permission modal appears with **Deny / Allow Always /
     Allow** buttons.
   - Click **Allow**. The modal dismisses; the tool block
     appears in the chat with the input snippet (`cmd: ls /tmp`)
     and, after a moment, the result (file listing).
6. **Switch sessions.** Click the **+** in the session list
   header. A new session is created and selected. Send another
   message there. Switching back to the first session shows its
   prior history intact.
7. **Reconnect mid-stream.** While the agent is mid-reply, kill
   the daemon (`Ctrl-C` in the terminal running `just daemon-dev`)
   and restart it. The chat view shows a brief reconnecting
   indicator; once the daemon is back, the message list resumes
   without duplicate items (M4's R5 regression test exercises
   this path automatically).

## Acceptance

The smoke is "passed" when:

- All seven steps complete without errors in the Xcode console.
- The daemon log shows the matching `permission_request` →
  `permission_response` → `permission_resolved` round-trip.
- A screen recording (`apple/media/clay-mode-smoke.mov`) captures
  steps 1–6.

## Architecture wiring (one-liner)

```
ClarcApp
  └── ClayShell (one of these per window)
        ├── ClayConnectionsStore (UserDefaults + Keychain)
        ├── ClayConnection (WebSocket actor)
        ├── ClayMessageDispatcher (pump)
        └── ClayProjectState (@Observable, MainActor)
              ├── sessions, sessionStates, activeSessionId
              ├── pendingPermissions
              └── connection (status mirror)
```

Views observe `ClayProjectState` directly. Outbound traffic goes
through narrow protocols on `ClayConnection`
(`ClayMessageSender`, `ClaySessionCommands`,
`ClayPermissionResponder`) so each surface stays unit-testable.

## Out of scope (deferred to Phase 2)

- Multi-project picker (Tier 2).
- Slash commands, attachments, paste handling.
- Edit-and-resend, long-text fold, older-message fold.
- Inline plan content stitching for `allow_clear_context` (the
  daemon's `planFilePath` fallback is used in Phase 1).
- "User scrolled up — pause auto-scroll" UX in the message list.
- mDNS discovery, multi-daemon, token refresh.
- Daemon-side `protocolVersion` field (M8, deferred — see PLAN
  D4).
