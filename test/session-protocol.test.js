// Iter 3 — protocol contract tests.
//
// Verifies the wire shape of session_list, session_switched, and the
// session-manager-side propagation of session.backend / capabilities.
//
// What this guarantees for the frontend:
//   1. Every entry of `session_list` carries `backend` (so the sidebar can
//      badge sessions of different backends in a mixed-backend project).
//   2. Every `session_switched` frame carries `backend` AND `capabilities`
//      so the frontend can re-paint body.backend-codex + capability-gated
//      UI in one round-trip.
//   3. Capabilities lookups are tolerant of missing/throwing resolvers —
//      old servers / tests must not crash the session manager.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

// Isolate persistence — same pattern as session-backend.test.js. Set
// CLAY_HOME before requiring sessions so config.js picks it up.
var SUITE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clay-protocol-suite-"));
process.env.CLAY_HOME = SUITE_HOME;

var { createSessionManager } = require("../lib/sessions");

function makeProjectCwd(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-protocol-cwd-" + label + "-"));
}

// Build a session manager that captures every outgoing frame so tests can
// assert wire shape. We deliberately omit `sendEach` so broadcastSessionList
// falls back to the single-user `send` channel — that's the path under test
// (multi-user broadcasts go through ws.send(JSON.stringify(...)) which would
// require a fake ws fleet, out of scope for these protocol shape tests).
function makeSm(cwd, opts) {
  var sent = [];
  var sm = createSessionManager({
    cwd: cwd,
    send: function (obj) { sent.push(obj); },
    sendTo: function (_ws, obj) { sent.push(obj); },
    // sendEach intentionally omitted — see comment above.
    onSessionDone: function () {},
    getProjectBackend: function () { return (opts && opts.backend) || "claude"; },
    getCapabilitiesFor: opts && opts.getCapabilitiesFor,
  });
  return { sm: sm, sent: sent };
}

test("session_list entries carry backend (per-session frozen identity)", function () {
  var ctx = makeSm(makeProjectCwd("list-backend"), { backend: "codex" });
  // The constructor auto-creates an initial session with project default.
  // Force a broadcast so we can inspect the shape.
  ctx.sent.length = 0;
  ctx.sm.broadcastSessionList();

  var listFrame = ctx.sent.find(function (m) { return m.type === "session_list"; });
  assert.ok(listFrame, "broadcastSessionList must emit a session_list frame");
  assert.ok(Array.isArray(listFrame.sessions) && listFrame.sessions.length === 1);
  assert.strictEqual(listFrame.sessions[0].backend, "codex",
    "session_list entry must carry the session's frozen backend");
});

test("session_list reflects per-session backend in mixed projects", function () {
  // A project default of "claude" with one explicit codex session — the
  // list must show each session's actual backend, not the project default.
  var ctx = makeSm(makeProjectCwd("list-mixed"), { backend: "claude" });
  ctx.sm.createSession({ backend: "codex" });
  ctx.sent.length = 0;
  ctx.sm.broadcastSessionList();

  var listFrame = ctx.sent.find(function (m) { return m.type === "session_list"; });
  assert.ok(listFrame);
  // Find the codex session in the list
  var byBackend = {};
  for (var i = 0; i < listFrame.sessions.length; i++) {
    byBackend[listFrame.sessions[i].backend] = (byBackend[listFrame.sessions[i].backend] || 0) + 1;
  }
  assert.strictEqual(byBackend.claude, 1, "expected one claude session");
  assert.strictEqual(byBackend.codex, 1, "expected one codex session");
});

test("session_switched carries backend AND capabilities from getCapabilitiesFor", function () {
  // The capabilities resolver is called once on switch with the session's
  // backend name. Whatever it returns is forwarded verbatim.
  var capsCallArgs = [];
  var capsFor = function (name) {
    capsCallArgs.push(name);
    return name === "codex"
      ? { settings: ["model", "effort"], threadFork: true, codexSkills: true }
      : { settings: ["model", "permissionMode"], threadFork: false, codexSkills: false };
  };
  var ctx = makeSm(makeProjectCwd("switch-caps"), { backend: "claude", getCapabilitiesFor: capsFor });

  // Manager auto-created an initial claude session; force a fresh codex one.
  var codexSession = ctx.sm.createSession({ backend: "codex" });
  ctx.sent.length = 0;
  capsCallArgs.length = 0;
  ctx.sm.switchSession(codexSession.localId);

  var switched = ctx.sent.find(function (m) { return m.type === "session_switched"; });
  assert.ok(switched, "switchSession must emit session_switched");
  assert.strictEqual(switched.backend, "codex");
  assert.deepStrictEqual(capsCallArgs, ["codex"], "resolver invoked with session's backend");
  assert.deepStrictEqual(switched.capabilities, {
    settings: ["model", "effort"],
    threadFork: true,
    codexSkills: true,
  });
});

test("session_switched falls back to capabilities=null when no resolver is wired", function () {
  // Pre-iter-3 callers / tests don't pass getCapabilitiesFor. The frame
  // must still ship — the frontend handles null/missing caps by keeping
  // its previous capability snapshot.
  var ctx = makeSm(makeProjectCwd("switch-no-resolver"), { backend: "claude" });
  var s = ctx.sm.createSession();
  ctx.sent.length = 0;
  ctx.sm.switchSession(s.localId);

  var switched = ctx.sent.find(function (m) { return m.type === "session_switched"; });
  assert.ok(switched);
  assert.strictEqual(switched.backend, "claude");
  assert.strictEqual(switched.capabilities, null,
    "missing resolver yields null capabilities (frontend keeps last-known)");
});

test("session_switched survives a throwing capabilities resolver", function () {
  // A buggy resolver should not poison the switch frame — the session
  // backend still ships, capabilities degrade to null. This is what makes
  // the protocol upgrade safe to roll out: a regression in caps lookup
  // doesn't break navigation.
  var ctx = makeSm(makeProjectCwd("switch-throwing"), {
    backend: "codex",
    getCapabilitiesFor: function () { throw new Error("oops"); },
  });
  var s = ctx.sm.getActiveSession();
  ctx.sent.length = 0;
  ctx.sm.switchSession(s.localId);

  var switched = ctx.sent.find(function (m) { return m.type === "session_switched"; });
  assert.ok(switched, "switchSession must not throw");
  assert.strictEqual(switched.backend, "codex");
  assert.strictEqual(switched.capabilities, null);
});

test("session_switched still ships backend even when session has none (defensive null)", function () {
  // A session that somehow lost its backend (e.g., test stub bypassing
  // createSession) ships with backend=null. Better than throwing.
  var ctx = makeSm(makeProjectCwd("switch-null-backend"), { backend: "claude" });
  var s = ctx.sm.createSession();
  s.backend = null; // simulate degraded session
  ctx.sent.length = 0;
  ctx.sm.switchSession(s.localId);

  var switched = ctx.sent.find(function (m) { return m.type === "session_switched"; });
  assert.ok(switched);
  assert.strictEqual(switched.backend, null);
  // Resolver must NOT be called for null backend — see sessions.js gating.
  assert.strictEqual(switched.capabilities, null);
});
