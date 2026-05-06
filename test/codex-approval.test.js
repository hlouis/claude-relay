// Unit tests for the iter-2 approval routing in codex-backend. We do NOT
// spawn `codex app-server`; instead we wire a fake JSON-RPC client into the
// backend via the test-only setters and drive `_handleServerRequest`
// directly. This isolates the translation contract:
//
//   Codex JSON-RPC approval request → Clay permission_request broadcast
//   Clay permission_response (behavior+allowedTools mutation) → Codex decision
//
// Why the indirection: `handleServerRequest` calls `currentSession` /
// `client.respond` / `sm.sendAndRecord`. By stubbing those we observe the
// exact bytes that would cross each boundary.

var test = require("node:test");
var assert = require("node:assert");

var { createCodexBackend } = require("../lib/codex-backend");

function makeFakeClient() {
  var responses = [];
  var errors = [];
  return {
    isExited: function () { return false; },
    request: function () { return Promise.resolve({}); },
    respond: function (id, result) { responses.push({ id: id, result: result }); },
    respondError: function (id, code, message) { errors.push({ id: id, code: code, message: message }); },
    close: function () {},
    _responses: responses,
    _errors: errors,
  };
}

function makeFakeSession() {
  return {
    cliSessionId: null,
    isProcessing: true,
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

function makeBackend() {
  var sent = [];
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
  var topbar = [];
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

test("command approval request broadcasts permission_request with source=codex", async function () {
  var ctx = makeBackend();
  var fakeClient = makeFakeClient();
  ctx.backend._setClientForTest(fakeClient);
  var session = makeFakeSession();
  ctx.backend._setCurrentSessionForTest(session);

  ctx.backend._handleServerRequest({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: "item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      command: "rm -rf /",
      cwd: "/tmp",
      reason: "Wants to delete the world",
    },
  });

  // Synchronous path: pendingPermissions populated + permission_request emitted.
  var keys = Object.keys(session.pendingPermissions);
  assert.strictEqual(keys.length, 1, "exactly one pending permission");
  var pending = session.pendingPermissions[keys[0]];
  assert.strictEqual(pending.toolName, "Bash");
  assert.strictEqual(pending.toolInput.command, "rm -rf /");
  assert.strictEqual(pending._codexAllowKey, "codex:exec");

  var permMsg = ctx.sent.find(function (m) { return m.type === "permission_request"; });
  assert.ok(permMsg, "permission_request was sent");
  assert.strictEqual(permMsg.source, "codex");
  assert.strictEqual(permMsg.toolName, "Bash");
  assert.strictEqual(permMsg.decisionReason, "Wants to delete the world");
});

test("allow → respond accept", async function () {
  var ctx = makeBackend();
  var fakeClient = makeFakeClient();
  ctx.backend._setClientForTest(fakeClient);
  var session = makeFakeSession();
  ctx.backend._setCurrentSessionForTest(session);

  ctx.backend._handleServerRequest({
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { itemId: "i", threadId: "t", turnId: "u", command: "ls" },
  });
  var pending = session.pendingPermissions[Object.keys(session.pendingPermissions)[0]];
  pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });

  // resolve is async (Promise then) — wait one microtask flush.
  await new Promise(function (r) { setImmediate(r); });
  assert.strictEqual(fakeClient._responses.length, 1);
  assert.deepStrictEqual(fakeClient._responses[0], { id: 1, result: { decision: "accept" } });
});

test("allow_always (toolName flag set) → respond acceptForSession + cache allowKey", async function () {
  var ctx = makeBackend();
  var fakeClient = makeFakeClient();
  ctx.backend._setClientForTest(fakeClient);
  var session = makeFakeSession();
  ctx.backend._setCurrentSessionForTest(session);

  ctx.backend._handleServerRequest({
    id: 2,
    method: "item/commandExecution/requestApproval",
    params: { itemId: "i", threadId: "t", turnId: "u", command: "ls" },
  });
  var pending = session.pendingPermissions[Object.keys(session.pendingPermissions)[0]];
  // Simulate project.js's permission_response handler for "allow_always":
  // it sets allowedTools[toolName]=true synchronously, then resolves.
  session.allowedTools[pending.toolName] = true;
  pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });

  await new Promise(function (r) { setImmediate(r); });
  assert.strictEqual(fakeClient._responses.length, 1);
  assert.deepStrictEqual(fakeClient._responses[0], { id: 2, result: { decision: "acceptForSession" } });
  assert.strictEqual(session.allowedTools["codex:exec"], true,
    "allowKey cached so subsequent same-category prompts auto-accept");
});

test("deny → respond decline", async function () {
  var ctx = makeBackend();
  var fakeClient = makeFakeClient();
  ctx.backend._setClientForTest(fakeClient);
  var session = makeFakeSession();
  ctx.backend._setCurrentSessionForTest(session);

  ctx.backend._handleServerRequest({
    id: 3,
    method: "item/fileChange/requestApproval",
    params: { itemId: "i", threadId: "t", turnId: "u", reason: "edit" },
  });
  var pending = session.pendingPermissions[Object.keys(session.pendingPermissions)[0]];
  assert.strictEqual(pending.toolName, "Edit");
  pending.resolve({ behavior: "deny", message: "user denied" });

  await new Promise(function (r) { setImmediate(r); });
  assert.deepStrictEqual(fakeClient._responses[0], { id: 3, result: { decision: "decline" } });
});

test("session-cached allowKey auto-accepts without prompting", async function () {
  var ctx = makeBackend();
  var fakeClient = makeFakeClient();
  ctx.backend._setClientForTest(fakeClient);
  var session = makeFakeSession();
  session.allowedTools["codex:exec"] = true;
  ctx.backend._setCurrentSessionForTest(session);

  ctx.backend._handleServerRequest({
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: { itemId: "i", threadId: "t", turnId: "u", command: "ls" },
  });

  assert.strictEqual(Object.keys(session.pendingPermissions).length, 0,
    "no permission prompt was queued");
  assert.deepStrictEqual(fakeClient._responses[0], { id: 7, result: { decision: "acceptForSession" } });
});

test("approval with no active session declines safely", async function () {
  var ctx = makeBackend();
  var fakeClient = makeFakeClient();
  ctx.backend._setClientForTest(fakeClient);
  ctx.backend._setCurrentSessionForTest(null);

  ctx.backend._handleServerRequest({
    id: 9,
    method: "item/commandExecution/requestApproval",
    params: { itemId: "i", threadId: "t", turnId: "u", command: "ls" },
  });
  assert.deepStrictEqual(fakeClient._responses[0], { id: 9, result: { decision: "decline" } });
});

test("unknown server request method is rejected with -32601", async function () {
  var ctx = makeBackend();
  var fakeClient = makeFakeClient();
  ctx.backend._setClientForTest(fakeClient);
  ctx.backend._setCurrentSessionForTest(makeFakeSession());

  ctx.backend._handleServerRequest({
    id: 10,
    method: "some/unknown/method",
    params: {},
  });
  assert.strictEqual(fakeClient._errors.length, 1);
  assert.strictEqual(fakeClient._errors[0].code, -32601);
});
