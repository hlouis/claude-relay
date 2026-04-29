# Clay WebSocket Protocol

This directory is the **single source of truth** for the WebSocket contract
between the Clay daemon (`daemon/`) and its native Apple clients (`apple/`).

## Layout

```
protocol/
├── README.md              ← this file
├── types.ts               ← canonical type definitions (Tier 1)
├── fixtures/              ← canonical JSON examples, one per message type
│   ├── c2s/               ← client → server
│   └── s2c/               ← server → client
└── (future) version-history.md
```

## What's in scope (Tier 1)

The native client MVP. About 30 message types covering:

- **Session lifecycle** — `new_session`, `switch_session`, `delete_session`,
  `rename_session`, `session_list`, `session_switched`, `message_uuid`,
  `session_id`
- **Streaming output** — `delta`, `thinking_*`, `tool_start`, `tool_executing`,
  `tool_result`, `result`, `done`, `status`
- **History replay** — `history_meta`, `history_prepend` (TBD), `history_done`,
  `user_message`, `load_more_history`
- **Permission flow** — `permission_request`, `permission_request_pending`,
  `permission_response`, `permission_resolved`, `permission_cancel`
- **Bootstrap & config** — `info`, `model_info`, `config_state`, `set_model`,
  `set_permission_mode`, `set_effort`
- **System** — `error`, `toast`, `rate_limit`, `auth_required`,
  `context_overflow`, `tab_visible`, `stop`
- **User input** — `message` (the C→S message that submits user text)

## What's deliberately excluded (Tier 2/3)

These remain daemon ↔ browser internals and are NOT part of the contract:

- Terminal (`term_*`)
- File system (`fs_*`, `browse_dir`)
- Direct messages between users (`dm_*`)
- Loop / Ralph (`loop_*`, `ralph_*`)
- Scheduler (`schedule_*`, `loop_registry_*`, `hub_schedules_list`)
- Hub controls (`set_pin`, `set_keep_awake`, `shutdown_server`,
  `restart_server`)
- Presence / cursor / text-select
- Project management (`add_project`, `remove_project`, etc.)
- Notes (`note_*`)

If a native client ever needs one of these, promote it to Tier 1 by adding a
type to `types.ts` and a fixture below.

## Versioning

`types.ts` is **v1**. Breaking changes (renames, removed fields, type
changes) require a major bump and a coordinated migration. Additive changes
(new optional fields, new message types) are minor and don't need a bump,
but every receiver MUST tolerate unknown messages and unknown fields.

`info` carries a `version` string today (the daemon's package version, not
the protocol version). A `protocolVersion` field will be added when v2
diverges; until then, both sides assume v1.

## Envelope (reserved, optional)

Every Tier 1 message type permits these optional fields:

- `id` — sender-assigned correlation id (string)
- `inReplyTo` — the `id` of the request this message is replying to
- `seq` — server-assigned sequence number, used for resumption

The current daemon does not emit `id`/`inReplyTo`. They're reserved so v1
receivers don't choke when v2 senders add them. `seq` is already used by the
daemon on every recorded message; clients pass `lastSeq` back via
`switch_session` to request incremental replay.

## Sync mechanism

We do NOT codegen. Both sides hand-write types, and **fixture round-trip
tests catch drift**:

1. `protocol/fixtures/` holds one canonical JSON example per message type.
2. `daemon/test/protocol.test.js` parses every fixture and re-emits it — any
   parser asymmetry fails the test.
3. The Apple client will add an equivalent `XCTest` once the Swift mirror
   exists. Until then, fixtures are the spec on the Swift side.

Adding a new message type is a four-step contract change:

1. Add the interface to `types.ts`.
2. Add a fixture under `protocol/fixtures/c2s/` or `s2c/`.
3. Update the daemon emitter / handler.
4. Update the Apple client's `Codable` enum.

Any drift caught by the round-trip test means one of these steps was skipped.

## Routing context (out of scope here, but useful)

The daemon mounts WebSockets at `/p/{slug}/ws`. The Apple client connects
once per project. Multiple clients per project are a normal case — the
daemon broadcasts session state to all of them, so client-side state should
reconcile against `session_list` on every receipt rather than tracking
incremental diffs.

The `seq` field on recorded messages enables incremental replay after a
brief disconnect: send `switch_session { id, lastSeq: N }` and the daemon
will only re-emit messages with `seq > N`.
