// Iter 5b unit tests — thread fork + resume on the codex-backend.
//
// The protocol contract was nailed down in
// scripts/codex-fork-protocol-probe.js (run against a live `codex
// app-server`, all 17 assertions green). These unit tests then drive the
// translation between Clay's session manager and the codex JSON-RPC layer
// using a fake client so we don't pay model API costs per assertion.
//
// Scope:
//   - forkActiveThread translates source session → thread/fork RPC →
//     new Clay session with cloned history + new cliSessionId.
//   - ensureThread prefers thread/resume when the session already has a
//     cliSessionId, and falls back to thread/start on resume failure.
//
// Out of scope (e2e covers it): codex broadcastSessionList side effects,
// client-side WS routing, sidebar UI.

var test = require("node:test");
var assert = require("node:assert");
var { createCodexBackend } = require("../lib/codex-backend");

// --- Fake-client harness ---
//
// makeFakeClient() lets each test pre-load canned responses by method
// name, capture every outbound call, and inject errors for fallback
// testing. The shape mirrors lib/codex-jsonrpc.js's public surface
// (request / respond / respondError / close + isExited) so the backend
// cannot tell it apart from the real one.

function makeFakeClient(responders) {
  var calls = [];
  return {
    isExited: function () { return false; },
    request: function (method, params) {
      calls.push({ method: method, params: params });
      var responder = responders && responders[method];
      if (typeof responder === "function") return Promise.resolve(responder(params, calls));
      if (responder && responder.error) return Promise.reject(responder.error);
      if (responder !== undefined) return Promise.resolve(responder);
      return Promise.resolve({});
    },
    respond: function () {},
    respondError: function () {},
    close: function () {},
    _calls: calls,
  };
}

function makeSession(localId, init) {
  return Object.assign({
    localId: localId || 1,
    cliSessionId: null,
    isProcessing: false,
    pendingPermissions: {},
    pendingAskUser: {},
    allowedTools: {},
    history: [],
    blocks: {},
    sentToolResults: {},
    title: "test session",
    ownerId: null,
    sessionVisibility: "shared",
  }, init || {});
}

function makeBackend(extraOpts) {
  var sent = [];
  var topbar = [];
  var savedSessions = [];
  var broadcasts = 0;
  var createdSessions = [];
  var sessionCounter = 100;
  var sm = {
    sendAndRecord: function (_session, obj) { sent.push(obj); },
    saveSessionFile: function (s) { savedSessions.push(s); },
    broadcastSessionList: function () { broadcasts++; },
    getActiveSession: function () { return null; },
    createSession: function (opts) {
      sessionCounter++;
      var s = makeSession(sessionCounter, {
        ownerId: (opts && opts.ownerId) || null,
        sessionVisibility: (opts && opts.sessionVisibility) || "shared",
        // Capture the backend opt verbatim so tests can assert that fork
        // explicitly inherited it from the source session (immutable rule).
        backend: opts && opts.backend,
      });
      createdSessions.push(s);
      return s;
    },
    currentModel: "",
    currentEffort: "medium",
    currentPermissionMode: "default",
    availableModels: [],
  };
  var beOpts = Object.assign({
    cwd: "/tmp",
    slug: "test",
    sessionManager: sm,
    send: function (obj) { topbar.push(obj); },
    pushModule: null,
    onProcessingChanged: function () {},
  }, extraOpts || {});
  var be = createCodexBackend(beOpts);
  return {
    backend: be,
    sent: sent,
    topbar: topbar,
    savedSessions: savedSessions,
    broadcasts: broadcasts,
    createdSessions: createdSessions,
    sm: sm,
    incBroadcasts: function () { broadcasts++; },
    getBroadcasts: function () { return broadcasts; },
  };
}

// --- forkActiveThread ---

test("forkActiveThread issues thread/fork with the source threadId and adopts the new id", async function () {
  var ctx = makeBackend();
  var fake = makeFakeClient({
    "thread/fork": function (params) {
      assert.strictEqual(params.threadId, "thread-source", "fork RPC carries the source id");
      // Probe-confirmed: codex returns a Thread with forkedFromId tying
      // back to the source. Mirror that shape exactly.
      return { thread: { id: "thread-fork-1", forkedFromId: params.threadId } };
    },
  });
  ctx.backend._setClientForTest(fake);

  var src = makeSession(1, { cliSessionId: "thread-source", title: "Source" });
  src.history = [{ type: "user_message", text: "hi" }, { type: "delta", text: "hello" }];
  // Pretend ensureThread already adopted source — short-circuit makes the
  // test deterministic and avoids a second RPC for thread/start.
  ctx.backend._setCurrentSessionForTest(src);
  ctx.backend._setActiveThreadIdForTest("thread-source");

  var newSession = await ctx.backend.forkActiveThread(src);

  // The translated RPC should be exactly one fork call.
  var forkCalls = fake._calls.filter(function (c) { return c.method === "thread/fork"; });
  assert.strictEqual(forkCalls.length, 1, "exactly one thread/fork RPC");
  // No anchor fields — we deliberately avoid the silently-ignored
  // atTurnId/atItemId pattern (probe step 11) so the wire stays clean.
  assert.deepStrictEqual(forkCalls[0].params, { threadId: "thread-source" });

  // The new Clay session must own the new threadId AND a copy of source
  // history (so UI replay matches what codex has server-side).
  assert.strictEqual(newSession.cliSessionId, "thread-fork-1");
  assert.strictEqual(newSession.codexForkedFromId, "thread-source");
  assert.deepStrictEqual(newSession.history, src.history);
  // History must be a *copy* — mutating the source after fork must NOT
  // bleed into the new session, and vice versa. Catches a slice() omission.
  src.history.push({ type: "user_message", text: "after-fork" });
  assert.strictEqual(newSession.history.length, 2,
    "fork captured a snapshot of source history at fork time");
});

test("forkActiveThread passes source session's backend to createSession (immutable inheritance)", async function () {
  // Invariant: a forked session's backend MUST be the source's backend,
  // NOT the project's current default. After iter 4 (mutable project
  // backend), a project that flipped from codex to claude could otherwise
  // produce a "claude" stamp on a thread that only makes sense to codex.
  // The data-layer enforcement is what we check here — we look at the opts
  // passed to sm.createSession and verify backend === source.backend.
  var ctx = makeBackend();
  var fake = makeFakeClient({
    "thread/fork": function () {
      return { thread: { id: "thread-fork-2", forkedFromId: "thread-source" } };
    },
  });
  ctx.backend._setClientForTest(fake);

  var src = makeSession(1, { cliSessionId: "thread-source", backend: "codex" });
  ctx.backend._setCurrentSessionForTest(src);
  ctx.backend._setActiveThreadIdForTest("thread-source");

  var newSession = await ctx.backend.forkActiveThread(src);
  assert.strictEqual(newSession.backend, "codex",
    "forked session must inherit the source session's backend");
});

test("forkActiveThread refuses when the source session is missing", async function () {
  var ctx = makeBackend();
  ctx.backend._setClientForTest(makeFakeClient());
  await assert.rejects(
    function () { return ctx.backend.forkActiveThread(null); },
    /requires a source session/
  );
});

test("forkActiveThread propagates RPC errors without creating a session", async function () {
  var ctx = makeBackend();
  var rpcErr = Object.assign(new Error("invalid thread id"), { code: -32600 });
  var fake = makeFakeClient({
    "thread/fork": { error: rpcErr },
  });
  ctx.backend._setClientForTest(fake);

  var src = makeSession(1, { cliSessionId: "thread-source" });
  ctx.backend._setCurrentSessionForTest(src);
  ctx.backend._setActiveThreadIdForTest("thread-source");

  await assert.rejects(
    function () { return ctx.backend.forkActiveThread(src); },
    /invalid thread id/
  );
  // No new session was created — the caller is responsible for showing
  // the error and the sidebar must NOT spawn a phantom item.
  assert.strictEqual(ctx.createdSessions.length, 0,
    "no Clay session created on fork RPC failure");
});

test("forkActiveThread rejects when codex returns an unchanged thread.id", async function () {
  // Belt-and-suspenders: the probe asserted fork.id !== source.id, but if
  // a future codex regression breaks that contract we must not silently
  // overwrite the active session with itself.
  var ctx = makeBackend();
  var fake = makeFakeClient({
    "thread/fork": { thread: { id: "thread-source", forkedFromId: "thread-source" } },
  });
  ctx.backend._setClientForTest(fake);
  var src = makeSession(1, { cliSessionId: "thread-source" });
  ctx.backend._setCurrentSessionForTest(src);
  ctx.backend._setActiveThreadIdForTest("thread-source");

  await assert.rejects(
    function () { return ctx.backend.forkActiveThread(src); },
    /did not return a new thread id/
  );
});

// --- ensureThread → thread/resume preference ---

test("ensureThread on a session with an existing cliSessionId calls thread/resume, not thread/start", async function () {
  var ctx = makeBackend();
  var fake = makeFakeClient({
    "thread/resume": function (params) {
      assert.strictEqual(params.threadId, "thread-existing");
      return { thread: { id: "thread-existing" } };
    },
    "thread/start": function () {
      throw new Error("thread/start must NOT be called when resume succeeds");
    },
  });
  ctx.backend._setClientForTest(fake);

  var session = makeSession(1, { cliSessionId: "thread-existing" });
  // Force the active threadId to be different so the early return doesn't
  // short-circuit ensureThread.
  ctx.backend._setActiveThreadIdForTest("some-other-thread");

  var resolvedId = await ctx.backend._ensureThreadForTest(session);
  assert.strictEqual(resolvedId, "thread-existing");

  var resumeCalls = fake._calls.filter(function (c) { return c.method === "thread/resume"; });
  var startCalls = fake._calls.filter(function (c) { return c.method === "thread/start"; });
  assert.strictEqual(resumeCalls.length, 1, "exactly one thread/resume RPC");
  assert.strictEqual(startCalls.length, 0, "no thread/start fallback when resume succeeds");
});

test("ensureThread falls back to thread/start when resume rejects", async function () {
  // Daemon-restart race: codex no longer remembers the thread id we have
  // on disk. We must NOT leave the user stuck — fall back, surface a
  // notice, and let the new turn proceed against a fresh thread.
  var ctx = makeBackend();
  var resumeErr = new Error("thread not found");
  var fake = makeFakeClient({
    "thread/resume": { error: resumeErr },
    "thread/start": function () {
      return { thread: { id: "thread-fresh" } };
    },
  });
  ctx.backend._setClientForTest(fake);

  var session = makeSession(1, { cliSessionId: "thread-stale" });
  ctx.backend._setActiveThreadIdForTest(null);

  var resolvedId = await ctx.backend._ensureThreadForTest(session);
  assert.strictEqual(resolvedId, "thread-fresh");
  assert.strictEqual(session.cliSessionId, "thread-fresh",
    "session adopts the new threadId after fallback");

  // The user-facing notice must fire so the user knows context was lost.
  var infoMsg = ctx.sent.find(function (m) {
    return m.type === "info" && /Codex could not resume/.test(m.text || "");
  });
  assert.ok(infoMsg, "user-visible info message about context loss was sent");
});

test("ensureThread short-circuits when the active threadId already matches", async function () {
  var ctx = makeBackend();
  var fake = makeFakeClient({
    "thread/resume": function () { throw new Error("must not call resume on a no-op"); },
    "thread/start": function () { throw new Error("must not call start on a no-op"); },
  });
  ctx.backend._setClientForTest(fake);

  var session = makeSession(1, { cliSessionId: "thread-active" });
  ctx.backend._setActiveThreadIdForTest("thread-active");

  var resolvedId = await ctx.backend._ensureThreadForTest(session);
  assert.strictEqual(resolvedId, "thread-active");
  assert.strictEqual(fake._calls.length, 0, "no RPCs issued on no-op ensure");
});
