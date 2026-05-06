// Unit tests for iter-4 codex_unavailable infrastructure.
//
// We do not spawn a real `codex app-server`. Instead we drive the backend's
// emit/retry/getLogs surface via test hooks and observe:
//   * codex_unavailable payload shape (kind / message / stderrTail)
//   * routing target (sendAndRecord when a session is live, broadcast send
//     when no session exists)
//   * retry() clears the unavailable state and (in the absence of a real
//     child) re-emits crashed kind via initialize failure
//   * getLogs() merges in-process stderr ringbuffer with ~/.codex/log tail
//
// The full crash → emitUnavailable wiring is exercised by the integration
// tests (scripts/codex-e2e.js when extended); here we focus on translation
// correctness.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { createCodexBackend, readCodexLogTail } = require("../lib/codex-backend");

function makeBackend() {
  var sent = [];
  var topbar = [];
  var sm = {
    sendAndRecord: function (_session, obj) { sent.push(obj); },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    getActiveSession: function () { return null; },
    currentModel: "",
    currentEffort: "medium",
    currentPermissionMode: "default",
    availableModels: [],
  };
  var be = createCodexBackend({
    cwd: "/tmp",
    slug: "test",
    sessionManager: sm,
    send: function (obj) { topbar.push(obj); },
    pushModule: null,
    onProcessingChanged: function () {},
  });
  return { backend: be, sent: sent, topbar: topbar };
}

function makeSession() {
  return {
    cliSessionId: null,
    isProcessing: false,
    pendingPermissions: {},
    pendingAskUser: {},
    allowedTools: {},
    history: [],
    responsePreview: "",
    streamedText: false,
    blocks: {},
    sentToolResults: {},
    title: "test",
  };
}

test("emitUnavailable broadcasts on project channel when no session is active", function () {
  var ctx = makeBackend();
  ctx.backend._setStderrTailForTest("boom\n");
  ctx.backend._emitUnavailableForTest("crashed", "Codex died");
  // No active session → routes through `send`, not sendAndRecord.
  assert.strictEqual(ctx.sent.length, 0, "no per-session record without a session");
  var msg = ctx.topbar.find(function (m) { return m.type === "codex_unavailable"; });
  assert.ok(msg, "codex_unavailable broadcast emitted");
  assert.strictEqual(msg.kind, "crashed");
  assert.strictEqual(msg.message, "Codex died");
  assert.strictEqual(msg.stderrTail, "boom\n");
  assert.ok(typeof msg.at === "number" && msg.at > 0, "timestamp populated");

  var snap = ctx.backend._getUnavailableForTest();
  assert.ok(snap, "internal unavailable snapshot retained");
  assert.strictEqual(snap.kind, "crashed");
});

test("emitUnavailable records on the active session so reload replays the card", function () {
  var ctx = makeBackend();
  var session = makeSession();
  ctx.backend._setCurrentSessionForTest(session);
  ctx.backend._setStderrTailForTest("");

  ctx.backend._emitUnavailableForTest("binary_missing", "Codex binary gone", { stderrTail: "" });

  var rec = ctx.sent.find(function (m) { return m.type === "codex_unavailable"; });
  assert.ok(rec, "unavailable recorded onto the live session");
  assert.strictEqual(rec.kind, "binary_missing");
  assert.strictEqual(rec.message, "Codex binary gone");
  // No accidental project-level broadcast in this branch.
  assert.strictEqual(
    ctx.topbar.filter(function (m) { return m.type === "codex_unavailable"; }).length,
    0,
    "no duplicate broadcast when session-scoped"
  );
});

test("emitUnavailable falls back to backend's stderrTail when opts omits it", function () {
  var ctx = makeBackend();
  ctx.backend._setStderrTailForTest("ringbuffer-content");
  ctx.backend._emitUnavailableForTest("crashed", "x");
  var msg = ctx.topbar.find(function (m) { return m.type === "codex_unavailable"; });
  assert.strictEqual(msg.stderrTail, "ringbuffer-content");
});

test("retry() with missing auth.json clears the unavailable snapshot and emits codex_auth_required", async function () {
  // Redirect HOME so checkCodexAuth returns "missing" — that hits the
  // auth-error branch in retry(), which is fully synchronous (no
  // subprocess spawn). We never want this unit test to actually launch
  // `codex app-server`.
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-retry-"));
  var origHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    var ctx = makeBackend();
    ctx.backend._emitUnavailableForTest("crashed", "old");
    assert.ok(ctx.backend._getUnavailableForTest(), "snapshot present pre-retry");

    await ctx.backend.retry();

    // retry() resets `unavailable = null` synchronously before
    // startClientIfNeeded; a missing auth.json takes the codex_auth_required
    // branch which does NOT re-emit unavailable.
    var after = ctx.backend._getUnavailableForTest();
    assert.strictEqual(after, null, "stale snapshot cleared on retry");

    var authMsg = ctx.topbar.find(function (m) { return m.type === "codex_auth_required"; });
    assert.ok(authMsg, "codex_auth_required emitted from retry()");
    assert.strictEqual(authMsg.code, "missing");
  } finally {
    process.env.HOME = origHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
});

test("readCodexLogTail handles missing ~/.codex/log directory gracefully", function () {
  // Point HOME at a path with no .codex/log subdir.
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-logtail-"));
  var origHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    var out = readCodexLogTail();
    assert.deepStrictEqual(out, { logFile: null, logTail: "" });
  } finally {
    process.env.HOME = origHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
});

test("readCodexLogTail picks the newest file and returns its tail", function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-logtail-"));
  var origHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    var dir = path.join(tmp, ".codex", "log");
    fs.mkdirSync(dir, { recursive: true });
    var older = path.join(dir, "older.log");
    var newer = path.join(dir, "newer.log");
    fs.writeFileSync(older, "OLDER\n");
    // Ensure mtime ordering is unambiguous on filesystems with coarse
    // mtime resolution.
    var past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);
    fs.writeFileSync(newer, "NEWER LINE 1\nNEWER LINE 2\n");

    var out = readCodexLogTail();
    assert.ok(out.logFile && out.logFile.indexOf("newer.log") !== -1, "newest file picked");
    assert.ok(out.logTail.indexOf("NEWER LINE 2") !== -1, "tail content present");
    assert.strictEqual(out.logTail.indexOf("OLDER"), -1, "older file ignored");
  } finally {
    process.env.HOME = origHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
});

test("readCodexLogTail respects byte limit", function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-logtail-"));
  var origHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    var dir = path.join(tmp, ".codex", "log");
    fs.mkdirSync(dir, { recursive: true });
    var f = path.join(dir, "big.log");
    var big = "A".repeat(500) + "B".repeat(500);
    fs.writeFileSync(f, big);
    var out = readCodexLogTail(200);
    assert.strictEqual(out.logTail.length, 200, "tail truncated to byte limit");
    // Last 200 bytes should be all 'B's.
    assert.strictEqual(out.logTail, "B".repeat(200));
  } finally {
    process.env.HOME = origHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
});

test("getLogs() merges stderr ringbuffer with log file tail", function () {
  var ctx = makeBackend();
  ctx.backend._setStderrTailForTest("STDERR-RING");

  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-logtail-"));
  var origHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    var dir = path.join(tmp, ".codex", "log");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "x.log"), "FILE-TAIL");

    var logs = ctx.backend.getLogs();
    assert.strictEqual(logs.stderrTail, "STDERR-RING");
    assert.ok(logs.logFile && logs.logFile.indexOf("x.log") !== -1);
    assert.strictEqual(logs.logTail, "FILE-TAIL");
  } finally {
    process.env.HOME = origHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
});

test("backend exports retry and getLogs on its public surface", function () {
  var ctx = makeBackend();
  assert.strictEqual(typeof ctx.backend.retry, "function");
  assert.strictEqual(typeof ctx.backend.getLogs, "function");
});

// --- Iter 4 follow-up: 401 / auth-loss detection ---

test("looksLike401 recognises canonical auth error codes", function () {
  var be = makeBackend().backend;
  // Whitelisted codes (case-insensitive).
  assert.ok(be._looksLike401ForTest("unauthorized", ""));
  assert.ok(be._looksLike401ForTest("Unauthorized", ""));
  assert.ok(be._looksLike401ForTest("token_expired", ""));
  assert.ok(be._looksLike401ForTest("invalid_auth", ""));
  assert.ok(be._looksLike401ForTest("authentication_failed", ""));
  assert.ok(be._looksLike401ForTest("auth_required", ""));
  assert.ok(be._looksLike401ForTest("401", ""));
});

test("looksLike401 recognises ChatGPT backend error message phrasing", function () {
  var be = makeBackend().backend;
  assert.ok(be._looksLike401ForTest("", "Provided authentication token is expired. Please try signing in again."));
  assert.ok(be._looksLike401ForTest("", "token_expired in upstream response"));
  // Bare "401" requires an auth-related neighbour — guards against false
  // positives from tool outputs that mention 401 as a generic status code.
  assert.ok(be._looksLike401ForTest("", "got 401 Unauthorized from backend"));
  assert.ok(be._looksLike401ForTest("", "request returned Unauthorized response"));
});

test("looksLike401 rejects unrelated errors", function () {
  var be = makeBackend().backend;
  assert.ok(!be._looksLike401ForTest("", "stream disconnected"));
  assert.ok(!be._looksLike401ForTest("", "request timed out"));
  assert.ok(!be._looksLike401ForTest("internal_error", "something went wrong"));
  // 401 mentioned in tool output context — without an auth neighbour we
  // refuse to swallow it as auth_lost.
  assert.ok(!be._looksLike401ForTest("", "DHL API returned status 401 in shipping label config"));
  // 402/403/404 should not match the bare-401 path.
  assert.ok(!be._looksLike401ForTest("", "402 payment required"));
  assert.ok(!be._looksLike401ForTest("", "403 forbidden"));
});

test("error notification with 401 routes to auth_lost card", function () {
  var ctx = makeBackend();
  // A live session must be present for `error` notifications to be
  // processed (matches handleNotification's `if (!session) return`).
  var session = {
    cliSessionId: "t1",
    isProcessing: true,
    pendingPermissions: {},
    allowedTools: {},
    history: [],
    responsePreview: "",
    streamedText: false,
    blocks: {},
    sentToolResults: {},
    title: "test",
  };
  ctx.backend._setCurrentSessionForTest(session);
  ctx.backend._setClientForTest({
    isExited: function () { return true; },  // already exited so triggerAuthLost skips client.close
    request: function () { return Promise.resolve({}); },
    respond: function () {}, respondError: function () {}, close: function () {},
  });

  ctx.backend._handleNotificationForTest({
    method: "error",
    params: {
      error: { code: "token_expired", message: "Provided authentication token is expired." },
      will_retry: false,
      thread_id: "t1",
      turn_id: "u1",
    },
  });

  var snap = ctx.backend._getUnavailableForTest();
  assert.ok(snap, "unavailable snapshot present");
  assert.strictEqual(snap.kind, "auth_lost");
  // The card replaces the generic error path: no `error` message recorded.
  var hasGenericError = ctx.sent.some(function (m) { return m.type === "error"; });
  assert.ok(!hasGenericError, "no generic error message emitted on the auth-lost path");
  // Turn was completed via done so spinner clears.
  var hasDone = ctx.sent.some(function (m) { return m.type === "done"; });
  assert.ok(hasDone, "done dispatched to clear processing state");
});

test("error notification without 401 keeps the generic error path", function () {
  var ctx = makeBackend();
  var session = {
    cliSessionId: "t1", isProcessing: true, pendingPermissions: {},
    allowedTools: {}, history: [], responsePreview: "", streamedText: false,
    blocks: {}, sentToolResults: {}, title: "test",
  };
  ctx.backend._setCurrentSessionForTest(session);
  ctx.backend._setClientForTest({
    isExited: function () { return true; },
    request: function () { return Promise.resolve({}); },
    respond: function () {}, respondError: function () {}, close: function () {},
  });

  ctx.backend._handleNotificationForTest({
    method: "error",
    params: {
      error: { code: "internal_error", message: "Something went wrong upstream" },
      will_retry: false,
      thread_id: "t1",
      turn_id: "u1",
    },
  });

  var snap = ctx.backend._getUnavailableForTest();
  assert.strictEqual(snap, null, "no unavailable card emitted for non-auth errors");
  var errMsg = ctx.sent.find(function (m) { return m.type === "error"; });
  assert.ok(errMsg, "generic error message preserved");
  assert.ok(/Something went wrong/.test(errMsg.text), "error text passed through");
});

test("account/chatgptAuthTokens/refresh server request rejects with -32000 and emits auth_lost", function () {
  var ctx = makeBackend();
  var session = {
    cliSessionId: "t1", isProcessing: true, pendingPermissions: {},
    allowedTools: {}, history: [], responsePreview: "", streamedText: false,
    blocks: {}, sentToolResults: {}, title: "test",
  };
  ctx.backend._setCurrentSessionForTest(session);
  var errorResponses = [];
  ctx.backend._setClientForTest({
    isExited: function () { return true; }, // skip teardown
    request: function () { return Promise.resolve({}); },
    respond: function () {},
    respondError: function (id, code, message) { errorResponses.push({ id: id, code: code, message: message }); },
    close: function () {},
  });

  ctx.backend._handleServerRequest({
    id: 99,
    method: "account/chatgptAuthTokens/refresh",
    params: { reason: "unauthorized", previousAccountId: null },
  });

  // JSON-RPC error response sent back to codex matching the exec-mode pattern.
  assert.strictEqual(errorResponses.length, 1, "exactly one respondError call");
  assert.strictEqual(errorResponses[0].id, 99);
  assert.strictEqual(errorResponses[0].code, -32000);
  assert.ok(/codex login|not supported/i.test(errorResponses[0].message),
    "respondError message guides the user to re-login (got: " + errorResponses[0].message + ")");

  var snap = ctx.backend._getUnavailableForTest();
  assert.ok(snap, "auth_lost snapshot emitted");
  assert.strictEqual(snap.kind, "auth_lost");
  assert.ok(/codex login/i.test(snap.message),
    "auth_lost message guides user to re-login (got: " + snap.message + ")");
});
