// Iter 4 — project backend mutability contract.
//
// The user's design rule:
//   "project.backend can be modified, but the change only affects NEW
//    sessions. Existing sessions keep their original backend (frozen
//    at birth, iter 1). Forks inherit the source session's backend
//    (iter 1+2). The mutation propagates via the getProjectBackend()
//    getter — sessions.js reads it once at session creation."
//
// These tests verify that contract at the data-layer seam, without
// standing up a full project / daemon. We drive a session manager with
// a mutable getProjectBackend closure and assert:
//
//   1. Mutating the project default DOES change the backend stamped on
//      sessions created AFTER the mutation.
//   2. Mutating the project default DOES NOT mutate the backend of
//      sessions created BEFORE the mutation — neither in memory nor
//      on disk (the JSONL meta line stays byte-identical for those
//      sessions across the flip).
//   3. Forks created after the project default flips still inherit
//      the source session's backend, NOT the new project default.
//      (Belt-and-braces: iter 2's codex-backend test already covers
//      this; here we re-check the in-memory invariant.)

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

var SUITE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clay-projbk-suite-"));
process.env.CLAY_HOME = SUITE_HOME;

var { createSessionManager } = require("../lib/sessions");

function noop() {}

function makeProjectCwd(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-projbk-cwd-" + label + "-"));
}

// Build an SM whose project default is held in a mutable box. Tests
// flip box.value to simulate the iter-4 closure mutation that the WS
// handler set_project_backend performs in project.js.
function makeMutableSm(cwd, initialBackend) {
  var box = { value: initialBackend };
  var sm = createSessionManager({
    cwd: cwd,
    send: noop, sendTo: noop, onSetSessionDone: noop,
    onSessionDone: noop,
    getProjectBackend: function () { return box.value; },
  });
  return { sm: sm, box: box };
}

test("flipping project default backend changes the next session's backend", function () {
  var ctx = makeMutableSm(makeProjectCwd("flip-next"), "claude");
  var first = ctx.sm.getActiveSession();
  assert.strictEqual(first.backend, "claude", "initial session reflects starting default");

  // Simulate the WS handler's closure mutation.
  ctx.box.value = "codex";

  var afterFlip = ctx.sm.createSession();
  assert.strictEqual(afterFlip.backend, "codex",
    "session created AFTER the flip must pick up the new default");
});

test("flipping project default does NOT mutate existing sessions (memory or disk)", function () {
  var ctx = makeMutableSm(makeProjectCwd("flip-preserves"), "claude");
  var existing = ctx.sm.getActiveSession();
  existing.cliSessionId = "existing-claude-thread";
  ctx.sm.saveSessionFile(existing);

  // Snapshot the on-disk meta line so we can byte-compare after the flip.
  var sfPath = path.join(ctx.sm.sessionsDir, "existing-claude-thread.jsonl");
  var beforeFlipDisk = fs.readFileSync(sfPath, "utf8");

  // Flip the project default.
  ctx.box.value = "codex";

  // In-memory invariant: existing session.backend MUST still be "claude".
  // saveSessionFile is also a write path — saving again must not retarget
  // the meta backend field.
  ctx.sm.saveSessionFile(existing);
  var afterFlipDisk = fs.readFileSync(sfPath, "utf8");

  assert.strictEqual(existing.backend, "claude",
    "existing session.backend is frozen — flipping project default must NOT mutate it");
  // The two writes happened a few μs apart, so lastActivity differs (it's
  // bumped on every save). What matters for iter 4 is the BACKEND in the
  // meta — not the timestamp. Parse and compare structurally.
  var beforeMeta = JSON.parse(beforeFlipDisk.split("\n")[0]);
  var afterMeta = JSON.parse(afterFlipDisk.split("\n")[0]);
  assert.strictEqual(afterMeta.backend, beforeMeta.backend,
    "meta.backend must survive saveSessionFile after a project default flip");
  assert.strictEqual(afterMeta.backend, "claude");
});

test("first existing session keeps its backend; second-after-flip session gets new backend (mixed-backend project state)", function () {
  // End-to-end: this is the post-iter-4 user-visible scenario — a project
  // that started as Claude, gained one Claude session, then flipped to
  // Codex. The Claude session must keep its backend; new sessions must
  // be Codex. The session manager must surface BOTH correctly so the
  // sidebar can render the iter-4 backend badge.
  var ctx = makeMutableSm(makeProjectCwd("mixed"), "claude");
  var oldClaude = ctx.sm.getActiveSession();
  oldClaude.cliSessionId = "old-claude";
  ctx.sm.saveSessionFile(oldClaude);

  ctx.box.value = "codex";

  var newCodex = ctx.sm.createSession();
  newCodex.cliSessionId = "new-codex";
  ctx.sm.saveSessionFile(newCodex);

  // Both sessions persisted with their own backend identities.
  var oldMeta = JSON.parse(
    fs.readFileSync(path.join(ctx.sm.sessionsDir, "old-claude.jsonl"), "utf8").split("\n")[0]
  );
  var newMeta = JSON.parse(
    fs.readFileSync(path.join(ctx.sm.sessionsDir, "new-codex.jsonl"), "utf8").split("\n")[0]
  );
  assert.strictEqual(oldMeta.backend, "claude");
  assert.strictEqual(newMeta.backend, "codex");
});

test("explicit sessionOpts.backend (fork inheritance) overrides current project default", function () {
  // Iter 1+2 fork rule: the codex-backend's forkActiveThread passes
  // backend: sourceSession.backend explicitly to sm.createSession. That
  // must win over the live getProjectBackend() value — even after a
  // project default flip.
  var ctx = makeMutableSm(makeProjectCwd("fork-after-flip"), "codex");
  // Source session is codex (matches initial default).
  var src = ctx.sm.getActiveSession();
  assert.strictEqual(src.backend, "codex");

  // Project flips to claude AFTER the codex source session was born.
  ctx.box.value = "claude";

  // Simulate fork: explicit backend = source's backend, ignoring project default.
  var forked = ctx.sm.createSession({ backend: src.backend });
  assert.strictEqual(forked.backend, "codex",
    "fork must inherit source backend, not the post-flip project default");
});
