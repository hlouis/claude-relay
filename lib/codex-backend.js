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
var crypto = require("crypto");
var { createCodexClient } = require("./codex-jsonrpc");

var CLIENT_NAME = "clay";
var CLIENT_VERSION = "iter1"; // bumped along with feature changes; not tied to package.json

// Iter 4: ringbuffer + log-tail constants for the View Logs panel and the
// codex_unavailable error card.
var STDERR_RING_LIMIT = 8192;        // last ~8 KB of child stderr we keep around
var LOG_TAIL_BYTES = 16 * 1024;      // last ~16 KB read off the freshest ~/.codex/log file

// Read the tail of the most recent file in ~/.codex/log/, if any. Used by
// the View Logs panel; failures are swallowed and reported as empty so the
// UI never blows up on a missing/permission-denied log directory.
function readCodexLogTail(limitBytes) {
  var dir = path.join(os.homedir(), ".codex", "log");
  var out = { logFile: null, logTail: "" };
  var entries;
  try { entries = fs.readdirSync(dir); }
  catch (e) { return out; }
  if (!entries || entries.length === 0) return out;
  var newest = null;
  var newestMtime = 0;
  for (var i = 0; i < entries.length; i++) {
    var p = path.join(dir, entries[i]);
    var st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newest = p; }
  }
  if (!newest) return out;
  var max = limitBytes || LOG_TAIL_BYTES;
  try {
    var st2 = fs.statSync(newest);
    var fd = fs.openSync(newest, "r");
    try {
      var start = Math.max(0, st2.size - max);
      var buf = Buffer.alloc(st2.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      out.logFile = newest;
      out.logTail = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    out.logFile = newest;
    out.logTail = "";
  }
  return out;
}

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

  // Iter 3 step 3: instance-level settings consumed at thread/start time.
  // Mid-thread changes don't apply to the current thread (Codex doesn't
  // expose a way to mutate sandbox/approvalPolicy/model on a live thread)
  // so the contract is "takes effect on next session". Setters mutate
  // these fields synchronously; the next ensureThread() call reads them.
  var desiredSandbox = "workspace-write";
  var desiredApprovalPolicy = "on-request";
  var desiredReasoningEffort = null; // null = let Codex pick
  var desiredModel = null;           // null = let Codex pick

  // Iter 4 follow-up: seed desired* from daemon.json so user's previous
  // selections survive a daemon restart. Only known keys are honored;
  // unknown ones are silently ignored (forward-compat for future settings).
  var initialCodexConfig = (opts && opts.codexConfig) || {};
  if (initialCodexConfig.sandbox &&
      ["read-only", "workspace-write", "danger-full-access"].indexOf(initialCodexConfig.sandbox) !== -1) {
    desiredSandbox = initialCodexConfig.sandbox;
  }
  if (initialCodexConfig.approvalPolicy &&
      ["untrusted", "on-failure", "on-request", "never"].indexOf(initialCodexConfig.approvalPolicy) !== -1) {
    desiredApprovalPolicy = initialCodexConfig.approvalPolicy;
  }
  if (typeof initialCodexConfig.model === "string" && initialCodexConfig.model) {
    desiredModel = initialCodexConfig.model;
  }
  if (initialCodexConfig.effort &&
      ["low", "medium", "high"].indexOf(initialCodexConfig.effort) !== -1) {
    desiredReasoningEffort = initialCodexConfig.effort;
  }
  // Mirror model/effort onto the session manager so the connect handler's
  // existing `model_info` + `config_state` echoes carry the persisted
  // values. Without this, sm.currentModel stays "" until the user touches
  // the chip — the first WS frame would show frontend hard-coded defaults
  // (e.g. effort=medium) even though daemon.json says "high".
  if (desiredModel) sm.currentModel = desiredModel;
  if (desiredReasoningEffort) sm.currentEffort = desiredReasoningEffort;

  // Persistence callback: invoked whenever a setter mutates desired*.
  // Daemon owns daemon.json so the callback's job is just to forward the
  // current snapshot. No-op when the parent (e.g. tests) didn't wire one.
  var onCodexConfigChange = (opts && typeof opts.onCodexConfigChange === "function")
    ? opts.onCodexConfigChange
    : function () {};

  function persistCurrentCodexConfig() {
    try {
      onCodexConfigChange({
        sandbox: desiredSandbox,
        approvalPolicy: desiredApprovalPolicy,
        model: desiredModel,
        effort: desiredReasoningEffort,
      });
    } catch (e) {
      console.error("[codex-backend] persistCurrentCodexConfig failed:", e.message || e);
    }
  }

  // Iter 4: unified "client cannot proceed" state. When non-null, the next
  // turn surfaces a codex_unavailable card instead of attempting to spawn /
  // talk to a dead child. Retry clears it.
  // Shape: { kind, message, stderrTail, at }
  var unavailable = null;
  // When true, we're tearing the client down deliberately because we've
  // already emitted a more specific codex_unavailable card (auth_lost or
  // version_incompatible). The onExit handler must NOT replace it with a
  // generic "crashed" card in this window. Reset on the next start.
  var gracefulTeardown = false;
  // Backend-owned stderr ringbuffer. The jsonrpc client also keeps a copy
  // but is destroyed when the child exits; we stash a snapshot here so the
  // unavailable card can always surface diagnostic context.
  var stderrTail = "";

  // --- Shared state helpers ---

  function sendAndRecord(session, obj) { sm.sendAndRecord(session, obj); }

  // Iter 4: emit (and remember) a codex_unavailable card. We record it via
  // sendAndRecord for the active session so reload/replay reproduces the
  // failure state; if there's no session yet we just broadcast on the
  // project channel so the topbar can react.
  // Iter 4 follow-up: detect version-incompatible Codex CLIs. Two signals:
  //
  //   1. The `initialize` JSON-RPC request is rejected — typically with
  //      -32601 ("Method not found") on a CLI that predates v2 schema, or
  //      with "unknown method" / "method not found" wording on builds that
  //      reshape the surface.
  //   2. `initialize` succeeds but the response is missing required v1
  //      fields. The schema declares `userAgent`, `codexHome`,
  //      `platformFamily`, `platformOs` as non-optional (see
  //      openai/codex app-server-protocol/src/protocol/v1.rs
  //      InitializeResponse). A response that fails to populate them
  //      indicates the server's v1 contract drifted.
  //
  // Both signals route to the codex_unavailable kind=version_incompatible
  // card; the user's recovery action is `codex update` (or reinstall) and
  // then Retry. We deliberately do NOT compare CLI version numbers — codex
  // doesn't expose its semver via initialize, and hard-coded thresholds
  // would rot. Instead we trust the protocol contract: if it speaks the
  // schema we agreed on, it's compatible.
  function looksLikeVersionIncompatError(err) {
    if (!err) return false;
    if (err.code === -32601) return true;
    var msg = (err.message || "").toLowerCase();
    if (msg.indexOf("unknown method") !== -1) return true;
    if (msg.indexOf("method not found") !== -1) return true;
    return false;
  }

  function looksLikeIncompatInitializeResponse(info) {
    if (!info || typeof info !== "object") return true;
    if (typeof info.userAgent !== "string" || !info.userAgent) return true;
    if (typeof info.platformOs !== "string" || !info.platformOs) return true;
    if (typeof info.platformFamily !== "string" || !info.platformFamily) return true;
    // codexHome is also required by the schema, but its content is OS-
    // dependent so we only assert presence.
    if (typeof info.codexHome !== "string" || !info.codexHome) return true;
    return false;
  }

  function triggerVersionIncompatible(detail) {
    var msg = detail || "Codex CLI appears to be too old for this Clay version. Run `codex update` (or reinstall) and click Retry.";
    emitUnavailable("version_incompatible", msg);
    if (client && !client.isExited()) {
      gracefulTeardown = true;
      try { client.close(); } catch (_) {}
    }
  }

  // Iter 4 follow-up: 401 / token-expired detection. Codex surfaces auth
  // failures two ways:
  //   1. ServerRequest `account/chatgptAuthTokens/refresh` (ChatGPT OAuth
  //      path). The well-defined trigger — see openai/codex
  //      app-server-protocol/src/protocol/v2/account.rs
  //      `ChatgptAuthTokensRefreshReason::Unauthorized` ("Codex attempted
  //      a backend request and received 401 Unauthorized").
  //   2. Notification `error` with TurnError carrying 401 indicators.
  //      Used when the OAuth refresh path doesn't apply (API-key / Bedrock
  //      modes) or as a follow-up after we reject the refresh request.
  //
  // We pattern-match conservatively: only well-known substrings/codes get
  // routed to auth_lost. Anything else stays a generic error.
  function looksLike401(errCode, errMessage) {
    var code = (errCode || "").toString();
    var msg = (errMessage || "").toString();
    var codeLc = code.toLowerCase();
    if (codeLc === "unauthorized" || codeLc === "token_expired" ||
        codeLc === "invalid_auth" || codeLc === "authentication_failed" ||
        codeLc === "auth_required" || codeLc === "401") {
      return true;
    }
    var msgLc = msg.toLowerCase();
    // Token expired phrasing comes straight from chatgpt.com/backend-api:
    //   "Provided authentication token is expired. Please try signing in again."
    if (msgLc.indexOf("provided authentication token is expired") !== -1) return true;
    if (msgLc.indexOf("token_expired") !== -1) return true;
    // Be careful with bare "401": only trust it when paired with
    // unauthorized/auth signal so we don't catch unrelated HTTP status
    // codes mentioned in tool outputs.
    if (/\b401\b/.test(msg) && /unauthor|auth/i.test(msg)) return true;
    if (/\bunauthorized\b/i.test(msg) && !/\b40[2-9]\b/.test(msg)) return true;
    return false;
  }

  // Trigger the auth_lost flow: emit the card, then close the client so
  // the next Retry re-reads auth.json from disk (the user runs `codex
  // login` between). Safe to call multiple times — the second call sees
  // an already-dead client and short-circuits.
  function triggerAuthLost(detailMessage) {
    var msg = detailMessage || "Codex backend reported 401 Unauthorized. Run `codex login` in a terminal, then click Retry.";
    emitUnavailable("auth_lost", msg);
    if (currentSession && currentSession.isProcessing) {
      var s = currentSession;
      s.isProcessing = false;
      onProcessingChanged();
      sendAndRecord(s, { type: "done", code: 1 });
      sm.broadcastSessionList();
      currentSession = null;
    }
    if (client && !client.isExited()) {
      gracefulTeardown = true;
      try { client.close(); } catch (_) {}
    }
  }

  function emitUnavailable(kind, message, opts) {
    opts = opts || {};
    var tail = (typeof opts.stderrTail === "string" ? opts.stderrTail : stderrTail) || "";
    unavailable = {
      kind: kind,
      message: message || "Codex client is unavailable.",
      stderrTail: tail,
      at: Date.now(),
    };
    var payload = {
      type: "codex_unavailable",
      kind: unavailable.kind,
      message: unavailable.message,
      stderrTail: unavailable.stderrTail,
      at: unavailable.at,
    };
    if (currentSession) {
      sendAndRecord(currentSession, payload);
    } else {
      send(payload);
    }
  }

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

    // Iter 4: detect a missing binary up front so we can surface a precise
    // "binary_missing" card instead of letting spawn ENOENT bubble through
    // as a generic startup error. findCodexBinary returns the literal
    // string "codex" as a last-resort fallback when nothing exists on disk.
    var bin = findCodexBinary();
    var binIsFallback = bin === "codex";
    if (binIsFallback) {
      try { require("child_process").execFileSync("which", ["codex"], { stdio: "ignore" }); }
      catch (_) {
        var msg = "The `codex` binary is not on PATH. Install it (e.g. `npm i -g @openai/codex`) and click Retry.";
        emitUnavailable("binary_missing", msg, { stderrTail: "" });
        var err = new Error(msg);
        err.codexUnavailableKind = "binary_missing";
        return Promise.reject(err);
      }
    }

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
        // Snapshot stderr from the dying client before we drop the ref, so
        // the unavailable card and any later View Logs request can show it.
        try {
          if (client && typeof client.getStderrTail === "function") {
            var tail = client.getStderrTail();
            if (tail) stderrTail = tail;
          }
        } catch (_) {}
        client = null;
        clientReadyPromise = null;

        // Spawn ENOENT (binary disappeared between findCodexBinary() and
        // exec) reaches us as a child error with code === "ENOENT".
        var kind = "crashed";
        var summary = "Codex app-server exited unexpectedly";
        if (exitErr && (exitErr.code === "ENOENT" || /ENOENT/.test(exitErr.message || ""))) {
          kind = "binary_missing";
          summary = "The `codex` binary could not be executed (ENOENT). Was it uninstalled?";
        } else if (code != null) {
          summary += " (code=" + code + (signal ? ", signal=" + signal : "") + ")";
        } else if (signal) {
          summary += " (signal=" + signal + ")";
        }

        // Iter 4 follow-up: if we're tearing the client down deliberately
        // because we already emitted auth_lost, suppress the crashed
        // emission so the user sees the helpful auth card instead of a
        // generic exit message. The flag clears on the next start.
        if (gracefulTeardown && kind === "crashed") {
          gracefulTeardown = false;
        } else {
          emitUnavailable(kind, summary, { stderrTail: stderrTail });
        }

        if (currentSession && currentSession.isProcessing) {
          var s = currentSession;
          s.isProcessing = false;
          onProcessingChanged();
          // Terminate the in-flight turn so the spinner stops; the card
          // already explains what went wrong.
          sendAndRecord(s, { type: "done", code: 1 });
          sm.broadcastSessionList();
          currentSession = null;
        }
      },
      onStderr: function (chunk) {
        if (typeof chunk === "string") {
          stderrTail += chunk;
          if (stderrTail.length > STDERR_RING_LIMIT) {
            stderrTail = stderrTail.slice(stderrTail.length - STDERR_RING_LIMIT);
          }
          process.stderr.write("[codex:" + slug + "] " + chunk);
        }
      },
    });

    clientReadyPromise = client.request("initialize", {
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      capabilities: { experimentalApi: true },
    }).then(function (info) {
      // Iter 4 follow-up: validate response shape against v1 schema. If
      // any required field is missing the CLI is older than what Clay
      // can drive — surface version_incompatible and tear down so Retry
      // doesn't retry against the same broken process.
      if (looksLikeIncompatInitializeResponse(info)) {
        var detail = "Codex CLI returned an `initialize` response missing required fields (got: " +
          JSON.stringify(Object.keys(info || {})) + "). Run `codex update` and click Retry.";
        triggerVersionIncompatible(detail);
        var verErr = new Error(detail);
        verErr.codexUnavailableKind = "version_incompatible";
        // Bubble through the catch below so client/promise refs reset.
        throw verErr;
      }
      initInfo = info;
      clientReady = true;
      // Successful start clears any prior unavailable banner.
      unavailable = null;
      return info;
    }).catch(function (e) {
      // Iter 4 follow-up: rejection patterns that indicate the CLI doesn't
      // speak our schema. Same recovery as the missing-fields path.
      if (!e.codexUnavailableKind && looksLikeVersionIncompatError(e)) {
        var detail = "Codex CLI rejected `initialize` (" +
          (e.code != null ? "code=" + e.code + ", " : "") +
          "message: " + (e.message || "unknown") +
          "). The CLI may be too old. Run `codex update` and click Retry.";
        triggerVersionIncompatible(detail);
        e = new Error(detail);
        e.codexUnavailableKind = "version_incompatible";
      }
      // initialize failed — destroy client so the next attempt retries cleanly.
      try { client && client.close(); } catch (_) {}
      client = null;
      clientReady = false;
      clientReadyPromise = null;
      throw e;
    });
    return clientReadyPromise;
  }

  // Iter 4: explicit retry — clears the unavailable state and re-runs
  // startClientIfNeeded. Triggered by the Retry button on the unavailable
  // card. Result is broadcast as either model_info (success) or another
  // codex_unavailable (still failing).
  function retry() {
    unavailable = null;
    return startClientIfNeeded().then(function () {
      send({ type: "model_info", model: sm.currentModel || "", models: [], backend: "codex" });
    }).catch(function (e) {
      // emitUnavailable already fired for binary_missing; for other
      // failures (auth, initialize) translate explicitly.
      if (e && e.codexUnavailableKind) return;
      if (e && e.codexAuthCode) {
        send({ type: "codex_auth_required", code: e.codexAuthCode, message: e.message });
        return;
      }
      emitUnavailable("crashed", "Codex retry failed: " + (e && e.message ? e.message : e));
    });
  }

  // Iter 4: surface the most recent diagnostics on demand for the View
  // Logs panel. Combines our in-process stderr ringbuffer with the tail of
  // the freshest ~/.codex/log file.
  function getLogs() {
    var live = "";
    try {
      if (client && typeof client.getStderrTail === "function") live = client.getStderrTail() || "";
    } catch (_) {}
    var combinedStderr = live || stderrTail || "";
    var fileLog = readCodexLogTail(LOG_TAIL_BYTES);
    return {
      stderrTail: combinedStderr,
      logFile: fileLog.logFile,
      logTail: fileLog.logTail,
    };
  }

  function ensureThread(session) {
    if (threadId && session.cliSessionId === threadId) return Promise.resolve(threadId);
    // If the session already has a cliSessionId persisted from a prior daemon
    // run, prefer resuming it. Iter 1 keeps this simple: always start a fresh
    // thread; persistence/resume is iter 4 territory.
    var startParams = {
      cwd: cwd,
      // Iter 3 step 3: sandbox/approvalPolicy/model/reasoning all come from
      // settable instance state. Defaults preserve iter-2 behavior
      // (workspace-write + on-request) until the user opens the settings
      // drawer.
      sandbox: desiredSandbox,
      approvalPolicy: desiredApprovalPolicy,
      // CRITICAL: v2 defaults `approvalsReviewer` to `"auto_review"`, in
      // which case Codex's guardian decides allow/deny by itself and the
      // client never receives `item/commandExecution/requestApproval`. We
      // explicitly force `"user"` so escalations route to Clay's WS
      // permission flow. Discovered the hard way during iter-2 live
      // verification — see CODEX_PLAN.md.
      approvalsReviewer: "user",
    };
    if (desiredModel) startParams.model = desiredModel;
    if (desiredReasoningEffort) startParams.modelReasoningEffort = desiredReasoningEffort;
    return client.request("thread/start", startParams).then(function (resp) {
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
      // Iter 4 follow-up: detect 401 / token-expired and route to the
      // auth_lost card instead of a generic error. ErrorNotification
      // shape is `{ error: { code?, message? }, will_retry, thread_id,
      // turn_id }` per app-server-protocol/src/protocol/v2/notification.rs.
      var errObj = params.error || {};
      if (looksLike401(errObj.code, errObj.message)) {
        triggerAuthLost(errObj.message || "Codex authentication failed.");
        currentTurnId = null;
        return;
      }
      session.isProcessing = false;
      onProcessingChanged();
      var errText = errObj.message || errObj.code || "Codex error";
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

  // --- Approval routing (iter 2) ---
  //
  // Codex sends approval requests as JSON-RPC requests over stdio. We
  // translate them into Clay's existing pendingPermissions Promise + WS
  // `permission_request` broadcast contract so the same Modal works for
  // both backends. The user's choice (`allow` / `allow_always` / `deny`)
  // gets translated back into the Codex decision enum.
  //
  // Decision mapping:
  //   allow         → "accept"
  //   allow_always  → "acceptForSession"
  //   deny          → "decline"  (turn continues; agent can retry/explain)
  //
  // We intentionally do NOT emit "cancel" today — Clay's UI does not yet
  // expose a "deny + interrupt" affordance distinct from "deny". If users
  // want to interrupt, they can use the existing stop button.
  //
  // execpolicy/network/grantRoot amendments are not surfaced yet (Iter 5).

  function buildPermissionPayload(method, params) {
    if (method === "item/commandExecution/requestApproval") {
      var input = {
        command: params.command || "",
        cwd: params.cwd || cwd,
      };
      if (params.networkApprovalContext) {
        input.network = params.networkApprovalContext;
      }
      if (params.commandActions) input.commandActions = params.commandActions;
      return { toolName: "Bash", toolInput: input, allowKey: "codex:exec" };
    }
    if (method === "item/fileChange/requestApproval") {
      var fcInput = {
        itemId: params.itemId,
        threadId: params.threadId,
      };
      if (params.grantRoot) fcInput.grantRoot = params.grantRoot;
      return { toolName: "Edit", toolInput: fcInput, allowKey: "codex:fileChange" };
    }
    return null;
  }

  function respondApproval(rpcId, decision) {
    if (!client) return;
    try { client.respond(rpcId, { decision: decision }); }
    catch (e) { console.error("[codex-backend] respond failed:", e.message || e); }
  }

  function handleServerRequest(msg) {
    if (!client) return;
    var method = msg.method;
    var params = msg.params || {};

    // Iter 4 follow-up: ChatGPT auth-token refresh request. Codex sends
    // this when its backend HTTP call returned 401. Clay does not (yet)
    // implement the OAuth refresh flow inside the daemon — we reject the
    // request like codex's own non-interactive `exec` mode does
    // (-32000), surface the auth_lost card so the user re-runs
    // `codex login`, and tear down the client so the next Retry reads a
    // fresh auth.json. See openai/codex exec/src/lib.rs reject pattern.
    if (method === "account/chatgptAuthTokens/refresh") {
      client.respondError(msg.id, -32000, "Codex auth token refresh is not supported in Clay yet; user must re-run `codex login`.");
      var reason = (params.reason || "unauthorized").toString();
      var detail = "Codex backend returned 401 (reason: " + reason + "). " +
        "Run `codex login` in a terminal, then click Retry.";
      triggerAuthLost(detail);
      return;
    }

    var built = buildPermissionPayload(method, params);
    if (!built) {
      client.respondError(msg.id, -32601, "Unsupported Codex server request: " + method);
      return;
    }

    var session = currentSession;
    if (!session) {
      // Without an active session we have nowhere to surface the prompt.
      // Decline so the turn can complete instead of hanging.
      respondApproval(msg.id, "decline");
      return;
    }

    // Session-scoped allow cache: if the user previously chose "Always Allow"
    // for this category in the current session, auto-accept without prompting.
    if (session.allowedTools && session.allowedTools[built.allowKey]) {
      respondApproval(msg.id, "acceptForSession");
      sendAndRecord(session, {
        type: "permission_resolved",
        requestId: "codex-auto-" + msg.id,
        decision: "allow_always",
        source: "codex",
      });
      return;
    }

    var requestId = (typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : ("codex-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    var reason = params.reason || "";

    new Promise(function (resolve) {
      session.pendingPermissions[requestId] = {
        resolve: resolve,
        requestId: requestId,
        toolName: built.toolName,
        toolInput: built.toolInput,
        toolUseId: params.itemId || requestId,
        decisionReason: reason,
        // Tag so project.js's permission_response handler does not need to
        // know the difference, but our `.then` below can detect "always".
        _codexAllowKey: built.allowKey,
      };

      var permMsg = {
        type: "permission_request",
        requestId: requestId,
        toolName: built.toolName,
        toolInput: built.toolInput,
        toolUseId: params.itemId || requestId,
        decisionReason: reason,
        source: "codex",
      };
      sendAndRecord(session, permMsg);

      if (pushModule) {
        try {
          pushModule.sendPush({
            type: "permission_request",
            slug: slug,
            requestId: requestId,
            title: permissionPushTitle(built.toolName, built.toolInput),
            body: permissionPushBody(built.toolName, built.toolInput),
          });
        } catch (e) { /* push is best-effort */ }
      }
    }).then(function (result) {
      if (!client) return;
      // project.js sets allowedTools[toolName]=true synchronously before
      // resolving on `allow_always`. Since our toolName is "Bash"/"Edit",
      // Claude's allowedTools key may already exist for those names — but
      // Codex projects never run the Claude SDK path, so this stays clean.
      // We additionally key by allowKey to avoid any cross-talk.
      if (result && result.behavior === "allow") {
        var wasAlways = !!(session.allowedTools && session.allowedTools[built.toolName]);
        if (wasAlways) {
          if (!session.allowedTools) session.allowedTools = {};
          session.allowedTools[built.allowKey] = true;
          respondApproval(msg.id, "acceptForSession");
        } else {
          respondApproval(msg.id, "accept");
        }
      } else {
        respondApproval(msg.id, "decline");
      }
    }).catch(function (e) {
      console.error("[codex-backend] approval flow error:", e.message || e);
      respondApproval(msg.id, "decline");
    });
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
      } else if (e.codexUnavailableKind) {
        // emitUnavailable already broadcast a codex_unavailable card.
        // Just terminate this turn so the spinner clears.
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
      // Iter 4 follow-up: surface the persisted desiredModel here (loaded
      // from daemon.json) so the topbar shows the user's last selection
      // instead of an empty placeholder.
      send({ type: "model_info", model: desiredModel || "", models: [], backend: "codex" });
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
    desiredModel = model || null;
    sm.currentModel = model;
    send({ type: "model_info", model: model, models: sm.availableModels || [], backend: "codex" });
    sendConfigState();
    persistCurrentCodexConfig();
    return Promise.resolve();
  }

  function setEffort(_session, effort) {
    // Codex's reasoning effort lives in the same enum space as Claude's
    // (`low`/`medium`/`high`); we just thread it into thread/start as
    // `modelReasoningEffort`.
    desiredReasoningEffort = effort || null;
    sm.currentEffort = effort;
    sendConfigState();
    persistCurrentCodexConfig();
    return Promise.resolve();
  }

  function setPermissionMode(_session, mode) {
    sm.currentPermissionMode = mode;
    sendConfigState();
    return Promise.resolve();
  }

  // Iter 3 step 3: Codex-only setters. Project.js routes
  // `set_codex_sandbox` / `set_codex_approval_policy` straight here. The
  // value applies on the next thread/start — for a live thread, the user
  // sees a config_state echo + a hint in the UI hint text that next
  // session will use the new value.
  function setSandbox(_session, value) {
    var allowed = ["read-only", "workspace-write", "danger-full-access"];
    if (allowed.indexOf(value) === -1) return Promise.resolve();
    desiredSandbox = value;
    send({ type: "codex_config", sandbox: desiredSandbox, approvalPolicy: desiredApprovalPolicy });
    persistCurrentCodexConfig();
    return Promise.resolve();
  }
  function setApprovalPolicy(_session, value) {
    var allowed = ["untrusted", "on-failure", "on-request", "never"];
    if (allowed.indexOf(value) === -1) return Promise.resolve();
    desiredApprovalPolicy = value;
    send({ type: "codex_config", sandbox: desiredSandbox, approvalPolicy: desiredApprovalPolicy });
    persistCurrentCodexConfig();
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
    setSandbox: setSandbox,
    setApprovalPolicy: setApprovalPolicy,
    stopTask: stopTask,
    warmup: warmup,
    retry: retry,
    getLogs: getLogs,
    // Iter 4 follow-up: snapshot of the active desired settings, used by
    // project.js to echo codex_config to a freshly connected WS client so
    // the input-bar chip + settings drawer reflect what's actually
    // persisted instead of the frontend's hard-coded defaults.
    getCodexConfig: function () {
      return {
        sandbox: desiredSandbox,
        approvalPolicy: desiredApprovalPolicy,
        model: desiredModel || "",
        effort: desiredReasoningEffort || "",
      };
    },
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
    _handleServerRequest: handleServerRequest,
    _setClientForTest: function (c) { client = c; },
    _setCurrentSessionForTest: function (s) { currentSession = s; },
    _getDesiredSettingsForTest: function () {
      return {
        sandbox: desiredSandbox,
        approvalPolicy: desiredApprovalPolicy,
        reasoningEffort: desiredReasoningEffort,
        model: desiredModel,
      };
    },
    // Iter 4 test hooks: lets us drive the unavailable lifecycle without
    // spawning a real subprocess.
    _emitUnavailableForTest: function (kind, msg, opts) { emitUnavailable(kind, msg, opts); },
    _getUnavailableForTest: function () { return unavailable; },
    _setStderrTailForTest: function (s) { stderrTail = s; },
    _looksLike401ForTest: function (code, msg) { return looksLike401(code, msg); },
    _handleNotificationForTest: function (msg) { handleNotification(msg); },
    _looksLikeVersionIncompatErrorForTest: function (err) { return looksLikeVersionIncompatError(err); },
    _looksLikeIncompatInitializeResponseForTest: function (info) { return looksLikeIncompatInitializeResponse(info); },
    _triggerVersionIncompatibleForTest: function (detail) { triggerVersionIncompatible(detail); },
  };
}

// Setting keys this backend honors. Iter 3 step 2 declares the full Codex
// surface; the actual UI dispatch lands in step 3, and live model switching
// + sandbox/approvalPolicy plumbing in steps 4–5. Until then, the runtime
// silently no-ops on keys other than `model` / `effort` (mirroring what
// codex-backend.js already does today).
//
// Intentionally NOT included: `permissionMode`, `betas`, `thinking` —
// those are Claude-only concepts (Anthropic SDK terminology) and have no
// equivalent in the Codex JSON-RPC contract.
var SUPPORTED_SETTINGS = ["model", "effort", "sandbox", "approvalPolicy", "apiKeyOverride"];

module.exports = {
  createCodexBackend: createCodexBackend,
  checkCodexAuth: checkCodexAuth,
  findCodexBinary: findCodexBinary,
  readCodexLogTail: readCodexLogTail,
  SUPPORTED_SETTINGS: SUPPORTED_SETTINGS,
};
