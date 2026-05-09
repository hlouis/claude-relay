var test = require("node:test");
var assert = require("node:assert");

var { attachSessions } = require("../lib/project-sessions");

function historyFingerprint(item) {
  if (!item) return "";
  if (item.clientMessageId) return item.type + "|client:" + item.clientMessageId;
  if (item.uuid) return item.type + "|uuid:" + item.uuid;
  var text = "";
  if (typeof item.text === "string") text = item.text.substring(0, 120);
  return [
    item.type || "",
    item._ts || "",
    text,
    item.requestId || "",
    item.id || "",
  ].join("|");
}

function createHarness(history) {
  var sent = [];
  var ws = { readyState: 1 };
  var session = {
    localId: 1,
    history: history,
    lastContextUsage: { used: 42 },
  };
  var ctx = {
    cwd: "/tmp/project",
    slug: "proj",
    isMate: false,
    osUsers: [],
    currentVersion: "test",
    sm: {
      HISTORY_PAGE_SIZE: 3,
      findTurnBoundary: function (items, targetIndex) {
        for (var i = targetIndex; i >= 0; i--) {
          if (items[i] && items[i].type === "user_message") return i;
        }
        return 0;
      },
      historyFingerprint: historyFingerprint,
      replayHistory: function (sess, fromIndex, targetWs, transform) {
        var total = sess.history.length;
        var from = typeof fromIndex === "number" ? fromIndex : 0;
        sent.push({ type: "history_meta", total: total, from: from });
        for (var i = from; i < total; i++) {
          if (sess.history[i] && sess.history[i].type === "digest_checkpoint") continue;
          sent.push(transform ? transform(sess.history[i]) : sess.history[i]);
        }
        sent.push({ type: "history_done", contextUsage: sess.lastContextUsage || null });
      },
    },
    sdk: {},
    tm: {},
    clients: new Set(),
    send: function (obj) { sent.push(obj); },
    sendTo: function (targetWs, obj) { sent.push(obj); },
    sendToAdmins: function () {},
    sendToSession: function () {},
    sendToSessionOthers: function () {},
    opts: {},
    usersModule: { isMultiUser: function () { return false; } },
    userPresence: {},
    pushModule: null,
    getSessionForWs: function () { return session; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () { return true; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (item) {
      var copy = Object.assign({}, item);
      copy.hydrated = true;
      return copy;
    },
    onProcessingChanged: function () {},
    broadcastPresence: function () {},
    adapter: {},
    getProjectList: function () { return []; },
    getProjectCount: function () { return 0; },
    getScheduleCount: function () { return 0; },
    moveScheduleToProject: function () {},
    moveAllSchedulesToProject: function () {},
    getHubSchedules: function () { return []; },
    fetchVersion: function () {},
    isNewer: function () { return false; },
    onCreateWorktree: function () {},
    IGNORED_DIRS: [],
    scheduleMessage: function () {},
    cancelScheduledMessage: function () {},
    getProjectOwnerId: function () { return null; },
    setProjectOwnerId: function () {},
    getUpdateChannel: function () { return null; },
    setUpdateChannel: function () {},
    getLatestVersion: function () { return null; },
    setLatestVersion: function () {},
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
  };
  return {
    ws: ws,
    sent: sent,
    session: session,
    mod: attachSessions(ctx),
  };
}

test("server load_more_history initial replays history through existing replay path", function () {
  var h = createHarness([
    { type: "user_message", text: "one", _ts: 1 },
    { type: "done", code: 0, _ts: 2 },
  ]);

  assert.strictEqual(h.mod.handleSessionsMessage(h.ws, { type: "load_more_history", initial: true }), true);
  assert.deepStrictEqual(h.sent.map(function (m) { return m.type; }), [
    "history_meta",
    "user_message",
    "done",
    "history_done",
  ]);
  assert.strictEqual(h.sent[1].hydrated, true);
});

test("server load_more_history after returns only appended delta", function () {
  var history = [
    { type: "user_message", text: "one", _ts: 1 },
    { type: "done", code: 0, _ts: 2 },
    { type: "user_message", text: "two", _ts: 3 },
    { type: "done", code: 0, _ts: 4 },
  ];
  var h = createHarness(history);

  h.mod.handleSessionsMessage(h.ws, {
    type: "load_more_history",
    after: 2,
    tailFingerprint: historyFingerprint(history[1]),
  });

  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].type, "history_append");
  assert.deepStrictEqual(h.sent[0].items.map(function (m) { return m.text || m.type; }), ["two", "done"]);
  assert.deepStrictEqual(h.sent[0].meta, { from: 2, to: 4, total: 4 });
});

test("server load_more_history after returns replace when fingerprint mismatches", function () {
  var history = [
    { type: "user_message", text: "one", _ts: 1 },
    { type: "done", code: 0, _ts: 2 },
    { type: "user_message", text: "two", _ts: 3 },
    { type: "done", code: 0, _ts: 4, cost: 7 },
  ];
  var h = createHarness(history);

  h.mod.handleSessionsMessage(h.ws, {
    type: "load_more_history",
    after: 2,
    tailFingerprint: "stale",
  });

  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].type, "history_replace");
  assert.strictEqual(h.sent[0].meta.total, 4);
  assert.strictEqual(h.sent[0].doneMeta.contextUsage.used, 42);
});

test("server load_more_history after returns replace when cached range is beyond server total", function () {
  var h = createHarness([
    { type: "user_message", text: "one", _ts: 1 },
  ]);

  h.mod.handleSessionsMessage(h.ws, { type: "load_more_history", after: 5 });

  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].type, "history_replace");
  assert.strictEqual(h.sent[0].meta.total, 1);
});

test("server load_more_history after skips digest checkpoints in append payload", function () {
  var history = [
    { type: "user_message", text: "one", _ts: 1 },
    { type: "digest_checkpoint", _ts: 2 },
    { type: "done", code: 0, _ts: 3 },
  ];
  var h = createHarness(history);

  h.mod.handleSessionsMessage(h.ws, {
    type: "load_more_history",
    after: 1,
    tailFingerprint: historyFingerprint(history[0]),
  });

  assert.strictEqual(h.sent[0].type, "history_append");
  assert.deepStrictEqual(h.sent[0].items.map(function (m) { return m.type; }), ["done"]);
  assert.deepStrictEqual(h.sent[0].meta, { from: 1, to: 3, total: 3 });
});

test("server load_more_history before keeps existing prepend pagination", function () {
  var history = [
    { type: "user_message", text: "one", _ts: 1 },
    { type: "done", code: 0, _ts: 2 },
    { type: "user_message", text: "two", _ts: 3 },
    { type: "done", code: 0, _ts: 4 },
  ];
  var h = createHarness(history);

  h.mod.handleSessionsMessage(h.ws, { type: "load_more_history", before: 2 });

  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].type, "history_prepend");
  assert.deepStrictEqual(h.sent[0].items.map(function (m) { return m.text || m.type; }), ["one", "done"]);
  assert.deepStrictEqual(h.sent[0].meta, { from: 0, to: 2, hasMore: false });
});
