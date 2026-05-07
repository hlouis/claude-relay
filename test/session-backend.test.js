// Iter (session-level backend) — data-layer tests for sessions.js.
//
// Goal: verify the immutability invariant of session.backend:
//   1. Stamped at creation from project default (or explicit override).
//   2. Persisted in the JSONL meta line.
//   3. Survives reload byte-for-byte; never re-derived from project default
//      once written.
//   4. Legacy sessions (no meta.backend) are migrated using project's
//      CURRENT default at load time, and the migration is written to disk
//      idempotently — a second restart must not re-trigger it.
//   5. Migration preserves file mtime so sidebar ordering is stable.
//
// We isolate filesystem state via CLAY_HOME so this test never touches the
// real ~/.clay. The require for ./sessions happens AFTER we set CLAY_HOME
// because lib/config.js reads the env once at module load.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

// Set isolated CLAY_HOME before requiring the sessions module so config.js
// picks it up. We use a single per-suite home and per-test cwd subdirs so
// each test's sessions live in their own encoded-cwd folder.
var SUITE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "clay-sessbackend-suite-"));
process.env.CLAY_HOME = SUITE_HOME;

var { createSessionManager } = require("../lib/sessions");

function noop() {}

function makeSm(cwd, projectBackend) {
  return createSessionManager({
    cwd: cwd,
    send: noop,
    sendTo: noop,
    sendEach: function () {},
    onSessionDone: noop,
    getProjectBackend: function () { return projectBackend; },
  });
}

// Each test gets a fresh fake project cwd. The encoded sessions dir lives
// under SUITE_HOME/sessions/{encoded-cwd}/. We point cwd at a unique tmp dir
// per test so encoded-cwd is unique and tests can't bleed into each other.
function makeProjectCwd(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-sessbackend-cwd-" + label + "-"));
}

test("createSession stamps backend from project default", function () {
  var sm = makeSm(makeProjectCwd("default"), "codex");
  // The constructor auto-creates an initial session when none exist on disk.
  var s = sm.getActiveSession();
  assert.ok(s, "initial session should exist");
  assert.strictEqual(s.backend, "codex");
});

test("createSession honors explicit sessionOpts.backend over project default", function () {
  var sm = makeSm(makeProjectCwd("explicit"), "codex");
  var s = sm.createSession({ backend: "claude" });
  assert.strictEqual(s.backend, "claude");
});

test("createSession defaults to claude when getProjectBackend is omitted", function () {
  var sm = createSessionManager({
    cwd: makeProjectCwd("noopt"),
    send: noop, sendTo: noop, sendEach: function () {}, onSessionDone: noop,
    // No getProjectBackend — exercise the fallback path.
  });
  var s = sm.getActiveSession();
  assert.strictEqual(s.backend, "claude");
});

test("saveSessionFile persists backend in meta line", function () {
  var sm = makeSm(makeProjectCwd("persist"), "codex");
  var s = sm.createSession();
  s.cliSessionId = "thread-abc";
  sm.saveSessionFile(s);

  var sfPath = path.join(sm.sessionsDir, "thread-abc.jsonl");
  var content = fs.readFileSync(sfPath, "utf8");
  var meta = JSON.parse(content.split("\n")[0]);
  assert.strictEqual(meta.type, "meta");
  assert.strictEqual(meta.backend, "codex");
});

test("loadSessions reads explicit backend from meta and does NOT override with project default", function () {
  // Write a JSONL with backend=claude, then reload with project default=codex.
  // Session.backend must remain claude — disk wins, project default is just
  // a fallback for missing fields.
  var cwd = makeProjectCwd("readback");
  var sm1 = makeSm(cwd, "claude");
  var s = sm1.createSession();
  s.cliSessionId = "frozen-claude";
  sm1.saveSessionFile(s);

  // Reload with a DIFFERENT project default. Session.backend must not budge.
  var sm2 = makeSm(cwd, "codex");
  var loaded = null;
  sm2.sessions.forEach(function (x) {
    if (x.cliSessionId === "frozen-claude") loaded = x;
  });
  assert.ok(loaded, "session should be loaded back");
  assert.strictEqual(loaded.backend, "claude", "explicit backend on disk wins over project default");
});

test("loadSessions backfills backend on legacy sessions using project's current default", function () {
  // Hand-craft a legacy JSONL (no `backend` field in meta) and verify that
  // loading rewrites it with project's current default.
  var cwd = makeProjectCwd("migrate");
  var sm1 = makeSm(cwd, "claude"); // create the sessions dir
  var sessionsDir = sm1.sessionsDir;

  var legacyMeta = {
    type: "meta",
    localId: 1,
    cliSessionId: "legacy-001",
    title: "old session",
    createdAt: 1700000000000,
    // Intentionally no `backend` field — pre-iter session.
  };
  var legacyHistoryLine = JSON.stringify({ type: "user_message", text: "hello" });
  var legacyFile = path.join(sessionsDir, "legacy-001.jsonl");
  fs.writeFileSync(legacyFile, JSON.stringify(legacyMeta) + "\n" + legacyHistoryLine + "\n");
  // Pin mtime to a known value so we can assert preservation.
  var pinnedMtime = new Date(1700000123456);
  fs.utimesSync(legacyFile, pinnedMtime, pinnedMtime);

  // Spin up a fresh manager pointing at the same cwd; project default is
  // "codex" this time. Migration must stamp codex onto the legacy session.
  var sm2 = makeSm(cwd, "codex");
  var loaded = null;
  sm2.sessions.forEach(function (x) {
    if (x.cliSessionId === "legacy-001") loaded = x;
  });
  assert.ok(loaded, "legacy session should be loaded");
  assert.strictEqual(loaded.backend, "codex", "in-memory session should pick up project default during migration");

  // On-disk meta should now include backend.
  var rewritten = fs.readFileSync(legacyFile, "utf8");
  var rewrittenLines = rewritten.split("\n");
  var rewrittenMeta = JSON.parse(rewrittenLines[0]);
  assert.strictEqual(rewrittenMeta.backend, "codex", "disk meta must be backfilled");
  // History line must survive untouched.
  assert.strictEqual(rewrittenLines[1], legacyHistoryLine, "history must not be rewritten");

  // mtime should be preserved (give a 100ms slack for FS resolution).
  var statAfter = fs.statSync(legacyFile);
  assert.ok(
    Math.abs(statAfter.mtimeMs - pinnedMtime.getTime()) < 100,
    "mtime should be preserved across migration; got " + statAfter.mtimeMs + " vs " + pinnedMtime.getTime()
  );
});

test("loadSessions migration is idempotent — second load is a no-op", function () {
  // Pre-condition: previous test creates a legacy file. Here we craft our
  // own to be self-contained.
  var cwd = makeProjectCwd("idempotent");
  var sm1 = makeSm(cwd, "claude");
  var sessionsDir = sm1.sessionsDir;

  var legacyMeta = {
    type: "meta",
    localId: 1,
    cliSessionId: "legacy-002",
    title: "x",
    createdAt: 1700000000000,
  };
  var legacyFile = path.join(sessionsDir, "legacy-002.jsonl");
  fs.writeFileSync(legacyFile, JSON.stringify(legacyMeta) + "\n");

  // First load: migrates.
  var sm2 = makeSm(cwd, "codex");
  var migratedContent = fs.readFileSync(legacyFile, "utf8");
  assert.ok(migratedContent.indexOf('"backend":"codex"') !== -1, "first load should write backend");

  // Second load: project default flipped to claude. If migration ran again,
  // it would rewrite to claude. It must NOT — meta.backend already exists.
  var sm3 = makeSm(cwd, "claude");
  var afterSecondLoad = fs.readFileSync(legacyFile, "utf8");
  assert.strictEqual(
    afterSecondLoad,
    migratedContent,
    "second load with different project default must leave file byte-identical"
  );

  // sm3 dummy use to silence lint
  assert.ok(sm3);
});

test("resumeSession stamps backend from project default when not explicitly provided", function () {
  var sm = makeSm(makeProjectCwd("resume"), "claude");
  var resumed = sm.resumeSession("resumed-cli-id", { history: [] });
  assert.strictEqual(resumed.backend, "claude");
  // Persisted meta must include it too.
  var sfPath = path.join(sm.sessionsDir, "resumed-cli-id.jsonl");
  var meta = JSON.parse(fs.readFileSync(sfPath, "utf8").split("\n")[0]);
  assert.strictEqual(meta.backend, "claude");
});

test("resumeSession honors explicit opts.backend", function () {
  var sm = makeSm(makeProjectCwd("resume-explicit"), "claude");
  var resumed = sm.resumeSession("resumed-codex-id", { history: [], backend: "codex" });
  assert.strictEqual(resumed.backend, "codex");
});

test("session.backend is unaffected by createSession's targetWs / switching plumbing", function () {
  // Sanity: switching session must not mutate backend on the way through.
  var sm = makeSm(makeProjectCwd("switch"), "codex");
  var s1 = sm.createSession({ backend: "claude" });
  var s2 = sm.createSession({ backend: "codex" });
  sm.switchSession(s1.localId);
  sm.switchSession(s2.localId);
  sm.switchSession(s1.localId);
  assert.strictEqual(s1.backend, "claude");
  assert.strictEqual(s2.backend, "codex");
});
