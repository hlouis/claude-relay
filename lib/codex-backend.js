// Codex backend — implements the AgentBackend surface on top of
// `codex app-server` over JSON-RPC stdio.
//
// Iteration 1 scope: end-to-end text conversation. We translate Codex
// notifications into the same Clay message types the UI already consumes
// (session_id / delta / result / done / error / model_info), so the
// frontend needs no Codex-aware code paths for plain Q&A.
//
// What is intentionally NOT here in iter 1:
//   - approval flows (sandbox=read-only avoids them; iter 2)
//   - command execution / file change rendering (iter 2)
//   - rewind / fork / skills / model switching (iter 3+)
//   - subprocess auto-restart on crash (iter 4)
//
// Authentication: we rely on `~/.codex/auth.json` produced by `codex login`.
// On startup we pre-flight that file and surface a recognisable error if it
// is missing or malformed; the frontend turns that into the "not logged in"
// guidance card.

var fs = require("fs");
var path = require("path");
var os = require("os");
var { createCodexClient } = require("./codex-jsonrpc");

var CLIENT_NAME = "clay";
var CLIENT_VERSION = "iter1"; // bumped along with feature changes; not tied to package.json

// Resolve the codex binary lazily so `which codex` failures show up as a
// friendly error at startQuery time, not at module-load time.
function findCodexBinary() {
  var candidate = process.env.CODEX_BIN;
  if (candidate && fs.existsSync(candidate)) return candidate;
  // Common install locations checked before relying on PATH lookup by spawn.
  var common = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    path.join(os.homedir(), ".cargo", "bin", "codex"),
  ];
  for (var i = 0; i < common.length; i++) {
    if (fs.existsSync(common[i])) return common[i];
  }
  return "codex"; // let spawn() resolve via PATH; failure surfaces as exit code
}

// Pre-flight check: verify the auth file exists and looks valid.
// Returns { ok: true } or { ok: false, code: "missing"|"invalid", message }.
function checkCodexAuth() {
  var p = path.join(os.homedir(), ".codex", "auth.json");
  var stat;
  try { stat = fs.statSync(p); } catch (e) {
    return { ok: false, code: "missing", message: "~/.codex/auth.json not found. Run `codex login` in a terminal." };
  }
  if (!stat.isFile()) {
    return { ok: false, code: "invalid", message: "~/.codex/auth.json is not a regular file." };
  }
  var raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch (e) {
    return { ok: false, code: "invalid", message: "Cannot read ~/.codex/auth.json: " + (e.message || e) };
  }
  var parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    return { ok: false, code: "invalid", message: "~/.codex/auth.json is not valid JSON." };
  }
  // The key Codex uses internally varies between releases. Accept any of
  // the common spellings; bail only if none of them carry a non-empty value.
  var modeFields = ["auth_mode", "authMode", "OPENAI_API_KEY", "openai_api_key"];
  var hasAuth = false;
  for (var i = 0; i < modeFields.length; i++) {
    var v = parsed[modeFields[i]];
    if (typeof v === "string" && v.length > 0) { hasAuth = true; break; }
  }
  // Token-based auth is stored under "tokens": { ... } — also accept that.
  if (!hasAuth && parsed.tokens && typeof parsed.tokens === "object") hasAuth = true;
  if (!hasAuth) {
    return { ok: false, code: "invalid", message: "~/.codex/auth.json has no recognised auth fields. Run `codex login`." };
  }
  return { ok: true };
}

function createCodexBackend(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug || "";
  var sm = opts.sessionManager;
  var send = opts.send;
  var pushModule = opts.pushModule;
  var onProcessingChanged = opts.onProcessingChanged || function () {};

  // One JSON-RPC client per project; (re)created lazily on the first turn.
  // Crash handling is iter 4 — for now we just mark the client dead and let
  // the next request return a clear error.
  var client = null;
  var clientReady = false;
  var clientReadyPromise = null;
  var threadId = null;          // becomes session.cliSessionId
  var currentTurnId = null;
  var currentSession = null;     // the Clay session that owns the active turn
  var initInfo = null;           // result of `initialize`
  var threadInfo = null;         // result of `thread/start`

  // --- Shared state helpers ---

  function sendAndRecord(session, obj) { sm.sendAndRecord(session, obj); }

  function sendConfigState() {
    send({
      type: "config_state",
      model: (threadInfo && threadInfo.model) || sm.currentModel || "",
      mode: sm.currentPermissionMode || "default",
      effort: sm.currentEffort || "medium",
      betas: [],
      thinking: "adaptive",
      thinkingBudget: 10000,
    });
  }

  // --- Client lifecycle ---

  function startClientIfNeeded() {
    if (client && !client.isExited()) return clientReadyPromise;

    var auth = checkCodexAuth();
    if (!auth.ok) {
      var err = new Error("codex_auth: " + auth.message);
      err.codexAuthCode = auth.code;
      return Promise.reject(err);
    }

    var bin = findCodexBinary();
    var env = Object.assign({}, process.env);
    if (opts.openaiApiKey) env.OPENAI_API_KEY = opts.openaiApiKey;

    client = createCodexClient({
      command: bin,
      args: ["app-server"],
      env: env,
      cwd: cwd,
      onNotification: handleNotification,
      onServerRequest: handleServerRequest,
      onExit: function (code, signal, exitErr) {
        clientReady = false;
        client = null;
        clientReadyPromise = null;
        if (currentSession && currentSession.isProcessing) {
          var s = currentSession;
          s.isProcessing = false;
          onProcessingChanged();
          sendAndRecord(s, {
            type: "error",
            text: "Codex app-server exited unexpectedly" + (code != null ? " (code=" + code + ")" : ""),
          });
          sendAndRecord(s, { type: "done", code: 1 });
          sm.broadcastSessionList();
          currentSession = null;
        }
      },
      onStderr: function (chunk) {
        if (typeof chunk === "string") process.stderr.write("[codex:" + slug + "] " + chunk);
      },
    });

    clientReadyPromise = client.request("initialize", {
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      capabilities: { experimentalApi: true },
    }).then(function (info) {
      initInfo = info;
      clientReady = true;
      return info;
    }).catch(function (e) {
      // initialize failed — destroy client so the next attempt retries cleanly.
      try { client && client.close(); } catch (_) {}
      client = null;
      clientReady = false;
      clientReadyPromise = null;
      throw e;
    });
    return clientReadyPromise;
  }

  function ensureThread(session) {
    if (threadId && session.cliSessionId === threadId) return Promise.resolve(threadId);
    // If the session already has a cliSessionId persisted from a prior daemon
    // run, prefer resuming it. Iter 1 keeps this simple: always start a fresh
    // thread; persistence/resume is iter 4 territory.
    return client.request("thread/start", {
      cwd: cwd,
      sandbox: "read-only",          // MVP: read-only avoids approval flow
      approvalPolicy: "never",
    }).then(function (resp) {
      threadInfo = resp;
      threadId = resp.thread && resp.thread.id;
      session.cliSessionId = threadId;
      sm.saveSessionFile(session);
      sendAndRecord(session, { type: "session_id", cliSessionId: threadId });
      // Surface model on the topbar.
      if (resp.model) {
        sm.currentModel = resp.model;
        send({ type: "model_info", model: resp.model, models: [], backend: "codex" });
        sendConfigState();
      }
      return threadId;
    });
  }

  // --- Notification handlers ---

  function handleNotification(msg) {
    var method = msg.method;
    var params = msg.params || {};
    var session = currentSession;

    if (method === "thread/started") return; // already captured via thread/start response

    if (method === "turn/started") {
      currentTurnId = params.turn && params.turn.id;
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (!session) return;
      if (typeof params.delta === "string" && params.delta.length > 0) {
        if (session.responsePreview.length < 200) session.responsePreview += params.delta;
        session.streamedText = true;
        sendAndRecord(session, { type: "delta", text: params.delta });
      }
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      if (!session) return;
      var item = params.item || {};
      // For MVP we only render text. agentMessage already streamed via deltas;
      // if the completion text differs (e.g. provider returned non-streamed),
      // emit the residual.
      if (method === "item/completed" && item.type === "agentMessage" && !session.streamedText) {
        var t = item.text || "";
        if (t) {
          if (session.responsePreview.length < 200) session.responsePreview += t;
          sendAndRecord(session, { type: "delta", text: t });
        }
      }
      // Reasoning / commandExecution / fileChange / mcpToolCall / etc. are
      // intentionally not rendered in iter 1. Iter 2 wires them up alongside
      // the approval flow.
      return;
    }

    if (method === "turn/completed") {
      if (!session) return;
      session.isProcessing = false;
      onProcessingChanged();
      var usage = (params.turn && params.turn.tokenUsage) || null;
      sendAndRecord(session, {
        type: "result",
        cost: null,
        duration: null,
        usage: usage,
        modelUsage: null,
        sessionId: threadId,
        lastStreamInputTokens: null,
      });
      sendAndRecord(session, { type: "done", code: 0 });
      if (pushModule) {
        var preview = (session.responsePreview || "").replace(/\s+/g, " ").trim();
        if (preview.length > 140) preview = preview.substring(0, 140) + "...";
        pushModule.sendPush({
          type: "done",
          slug: slug,
          title: session.title || "Codex",
          body: preview || "Response ready",
          tag: "codex-done",
        });
      }
      session.responsePreview = "";
      session.streamedText = false;
      currentTurnId = null;
      sm.broadcastSessionList();
      var doneSession = session;
      currentSession = null;
      if (doneSession.onQueryComplete) {
        try { doneSession.onQueryComplete(doneSession); } catch (e) {
          console.error("[codex-backend] onQueryComplete error:", e.message || e);
        }
      }
      return;
    }

    if (method === "error") {
      if (!session) return;
      session.isProcessing = false;
      onProcessingChanged();
      var errText = (params.error && (params.error.message || params.error.code)) || "Codex error";
      sendAndRecord(session, { type: "error", text: "Codex: " + errText });
      sendAndRecord(session, { type: "done", code: 1 });
      sm.broadcastSessionList();
      currentTurnId = null;
      currentSession = null;
      return;
    }

    // Other notifications (tokenUsage, rateLimits, mcpServer/startupStatus,
    // remoteControl, account/*) are ignored for iter 1.
  }

  function handleServerRequest(msg) {
    // With sandbox=read-only + approvalPolicy=never we should not see
    // approvals. Anything that does arrive gets denied so the turn can finish.
    // Iter 2 will route these through Clay's existing pendingPermissions flow.
    if (!client) return;
    client.respondError(msg.id, -32601, "Approvals not yet supported in this Codex iteration");
  }

  // --- AgentBackend surface ---

  async function startQuery(session, text, images, _linuxUser) {
    // _linuxUser is reserved for OS-level user isolation (Claude path); not
    // wired for Codex in iter 1.
    session.responsePreview = "";
    session.streamedText = false;
    session.blocks = {};
    session.sentToolResults = {};

    try {
      await startClientIfNeeded();
    } catch (e) {
      session.isProcessing = false;
      onProcessingChanged();
      if (e.codexAuthCode) {
        sendAndRecord(session, {
          type: "auth_required",
          text: e.message,
          source: "codex",
          authCode: e.codexAuthCode,
        });
      } else {
        sendAndRecord(session, { type: "error", text: "Codex: " + (e.message || e) });
      }
      sendAndRecord(session, { type: "done", code: 1 });
      sm.broadcastSessionList();
      return;
    }

    try {
      await ensureThread(session);
    } catch (e) {
      session.isProcessing = false;
      onProcessingChanged();
      sendAndRecord(session, { type: "error", text: "Codex: " + (e.message || e) });
      sendAndRecord(session, { type: "done", code: 1 });
      sm.broadcastSessionList();
      return;
    }

    currentSession = session;

    // Iter 1: text only. Images are dropped with a friendly note.
    if (images && images.length > 0) {
      sendAndRecord(session, {
        type: "info",
        text: "Codex: image inputs are not yet supported in this iteration; sending text only.",
      });
    }

    var input = [{ type: "text", text: text || "" }];
    try {
      var resp = await client.request("turn/start", { threadId: threadId, input: input });
      currentTurnId = resp.turn && resp.turn.id;
    } catch (e) {
      currentSession = null;
      session.isProcessing = false;
      onProcessingChanged();
      sendAndRecord(session, { type: "error", text: "Codex turn/start failed: " + (e.message || e) });
      sendAndRecord(session, { type: "done", code: 1 });
      sm.broadcastSessionList();
    }
  }

  function pushMessage(session, text, images) {
    // Codex doesn't expose mid-turn injection in v2; queue the next turn
    // after the current one completes. For MVP we simply start a new turn,
    // assuming the UI gates pushMessage to "between turns" already.
    return startQuery(session, text, images, null);
  }

  async function stopTask(_taskId) {
    var session = sm.getActiveSession();
    if (!session) return;
    session.taskStopRequested = true;
    if (!client || !threadId || !currentTurnId) return;
    try {
      await client.request("turn/interrupt", { threadId: threadId, turnId: currentTurnId });
    } catch (e) {
      console.error("[codex-backend] turn/interrupt failed:", e.message || e);
    }
  }

  async function warmup(_linuxUser) {
    // Boot the client and run initialize so the topbar shows a model badge
    // before the user sends their first message. Failures are surfaced as
    // model_info with the special "codex_unauthenticated" sentinel that the
    // frontend turns into the guidance card.
    try {
      await startClientIfNeeded();
      // initialize doesn't return the active model — only thread/start does.
      // Render a placeholder until the first turn lands a real model.
      send({ type: "model_info", model: "", models: [], backend: "codex" });
    } catch (e) {
      if (e.codexAuthCode) {
        send({
          type: "codex_auth_required",
          code: e.codexAuthCode,
          message: e.message,
        });
      } else {
        send({ type: "error", text: "Codex warmup failed: " + (e.message || e) });
      }
    }
  }

  // --- Stubs: methods the AgentBackend surface declares but Codex iter 1
  // does not implement. Each one is a no-op (or reasonable default) chosen
  // so project.js never sees `undefined is not a function`.

  function setModel(_session, model) {
    sm.currentModel = model;
    send({ type: "model_info", model: model, models: sm.availableModels || [], backend: "codex" });
    sendConfigState();
    return Promise.resolve();
  }

  function setEffort(_session, effort) {
    sm.currentEffort = effort;
    sendConfigState();
    return Promise.resolve();
  }

  function setPermissionMode(_session, mode) {
    sm.currentPermissionMode = mode;
    sendConfigState();
    return Promise.resolve();
  }

  function handleCanUseTool(_session, _toolName, input, _opts) {
    // No path in iter 1 should reach this — the SDK doesn't drive Codex.
    // Returning allow keeps callers safe should something accidentally
    // invoke it (e.g. shared sub-agent code paths).
    return Promise.resolve({ behavior: "allow", updatedInput: input });
  }

  function handleElicitation(_session, _request, _opts) {
    return Promise.resolve({ action: "reject" });
  }

  function processQueryStream(_session) {
    // Codex pushes notifications; there is no async iterator to drain.
    return Promise.resolve();
  }

  function processSDKMessage(_session, _parsed) { /* not applicable */ }

  function getOrCreateRewindQuery(_session) {
    var err = new Error("Rewind is not supported for Codex projects yet.");
    err.code = "CODEX_REWIND_UNSUPPORTED";
    return Promise.reject(err);
  }

  function isClaudeProcess(_pid) { return false; }

  function permissionPushTitle(toolName, _input) {
    return "Codex wants to use " + toolName;
  }
  function permissionPushBody(_toolName, input) {
    if (!input) return "";
    var t = input.command || input.file_path || input.url || input.query || "";
    if (t.length > 120) t = t.substring(0, 120) + "...";
    return t;
  }

  // Exists only because project.js's Ralph Loop crafting path calls into it.
  // The shape mirrors sdk-bridge's createMessageQueue but is intentionally
  // unused by codex turns. If anyone actually drains it, they get an empty
  // stream — better than a hard crash.
  function createMessageQueue() {
    var ended = false;
    return {
      push: function () {},
      end: function () { ended = true; },
      [Symbol.asyncIterator]: function () {
        return { next: function () { return Promise.resolve({ value: undefined, done: true }); } };
      },
      _isCodexNoop: true,
      _ended: function () { return ended; },
    };
  }

  return {
    startQuery: startQuery,
    pushMessage: pushMessage,
    setModel: setModel,
    setEffort: setEffort,
    setPermissionMode: setPermissionMode,
    stopTask: stopTask,
    warmup: warmup,
    handleCanUseTool: handleCanUseTool,
    handleElicitation: handleElicitation,
    processQueryStream: processQueryStream,
    processSDKMessage: processSDKMessage,
    getOrCreateRewindQuery: getOrCreateRewindQuery,
    isClaudeProcess: isClaudeProcess,
    permissionPushTitle: permissionPushTitle,
    permissionPushBody: permissionPushBody,
    createMessageQueue: createMessageQueue,
    // Internal probes used by tests:
    _checkCodexAuth: checkCodexAuth,
    _findCodexBinary: findCodexBinary,
  };
}

module.exports = {
  createCodexBackend: createCodexBackend,
  checkCodexAuth: checkCodexAuth,
  findCodexBinary: findCodexBinary,
};
