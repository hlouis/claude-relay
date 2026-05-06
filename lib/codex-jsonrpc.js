// Minimal line-delimited JSON-RPC 2.0 client for `codex app-server`.
//
// One process, one client. Messages are newline-delimited JSON on stdin/stdout
// (Codex `--listen stdio://`, the default). No batching. No streaming inside a
// single message. No external dependencies.
//
// Three message kinds, dispatched by shape:
//   * Response  — has `id` matching one we sent + (`result` | `error`)
//   * Request   — has `id` and `method`; server expects a response back from us
//   * Notify    — has `method` only, no `id`
//
// The client owns request-id generation and the pending-response map. Higher
// layers (codex-backend.js) consume notifications + server requests via the
// callbacks and never see frame parsing.
//
// Lifecycle:
//   var client = createCodexClient({ command, args, env, cwd, ... });
//   await client.request("thread/start", { cwd: "..." });
//   client.close();   // graceful shutdown; SIGKILL after gracePeriodMs
//
// Failure model: if the child exits unexpectedly, every pending request is
// rejected with the same exit error. `onExit` fires once. After exit, every
// new `request()` rejects synchronously.

var { spawn } = require("child_process");

function createCodexClient(opts) {
  var command = opts.command;
  var args = opts.args || [];
  var env = opts.env || process.env;
  var cwd = opts.cwd;
  var onNotification = opts.onNotification || function () {};
  var onServerRequest = opts.onServerRequest || function () {};
  var onExit = opts.onExit || function () {};
  var onStderr = opts.onStderr || function () {};
  var gracePeriodMs = typeof opts.gracePeriodMs === "number" ? opts.gracePeriodMs : 2000;

  var nextId = 1;
  var pending = Object.create(null);   // id -> { resolve, reject }
  var stdoutBuf = "";
  var stderrTail = "";                  // last few KB for diagnostics
  var STDERR_TAIL_LIMIT = 8192;
  var exited = false;
  var exitError = null;

  var child;
  try {
    child = spawn(command, args, {
      cwd: cwd,
      env: env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    // Spawn failure is reported synchronously; mark exited so request() rejects.
    exited = true;
    exitError = e;
    setImmediate(function () { onExit(-1, null, e); });
    // Return a stub client that always rejects.
    return makeDeadClient(e);
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", function (chunk) {
    stdoutBuf += chunk;
    var lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        // Codex should never emit invalid JSON. Treat as fatal-by-log.
        onStderr("[codex-jsonrpc] dropped invalid JSON line: " + line.slice(0, 200));
        continue;
      }
      dispatch(msg);
    }
  });

  child.stderr.on("data", function (chunk) {
    stderrTail += chunk;
    if (stderrTail.length > STDERR_TAIL_LIMIT) {
      stderrTail = stderrTail.slice(stderrTail.length - STDERR_TAIL_LIMIT);
    }
    onStderr(chunk);
  });

  child.on("error", function (err) {
    if (exited) return;
    exited = true;
    exitError = err;
    rejectAllPending(err);
    onExit(-1, null, err);
  });

  child.on("exit", function (code, signal) {
    if (exited) return;
    exited = true;
    var msg = "codex app-server exited (code=" + code + ", signal=" + signal + ")";
    if (stderrTail) msg += "\nstderr tail:\n" + stderrTail;
    exitError = new Error(msg);
    exitError.code = code;
    exitError.signal = signal;
    rejectAllPending(exitError);
    onExit(code, signal, exitError);
  });

  function dispatch(msg) {
    if (msg && typeof msg.id !== "undefined" && (Object.prototype.hasOwnProperty.call(msg, "result") || Object.prototype.hasOwnProperty.call(msg, "error"))) {
      // Response to one of our requests.
      var entry = pending[msg.id];
      if (!entry) {
        onStderr("[codex-jsonrpc] response with unknown id: " + JSON.stringify(msg.id));
        return;
      }
      delete pending[msg.id];
      if (msg.error) {
        var err = new Error(msg.error.message || "JSON-RPC error");
        err.code = msg.error.code;
        err.data = msg.error.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg && typeof msg.id !== "undefined" && msg.method) {
      // Server-initiated request: caller must respond via respond()/respondError().
      try {
        onServerRequest(msg);
      } catch (e) {
        onStderr("[codex-jsonrpc] onServerRequest threw: " + (e.message || e));
      }
      return;
    }
    if (msg && msg.method) {
      // Notification.
      try {
        onNotification(msg);
      } catch (e) {
        onStderr("[codex-jsonrpc] onNotification threw: " + (e.message || e));
      }
      return;
    }
    onStderr("[codex-jsonrpc] dropped unrecognized message: " + JSON.stringify(msg).slice(0, 200));
  }

  function rejectAllPending(err) {
    var ids = Object.keys(pending);
    for (var i = 0; i < ids.length; i++) {
      var entry = pending[ids[i]];
      delete pending[ids[i]];
      try { entry.reject(err); } catch (e) {}
    }
  }

  function writeFrame(obj) {
    if (exited) return false;
    try {
      child.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch (e) {
      onStderr("[codex-jsonrpc] write failed: " + (e.message || e));
      return false;
    }
  }

  function request(method, params) {
    if (exited) {
      return Promise.reject(exitError || new Error("codex client closed"));
    }
    var id = nextId++;
    var p = new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
    });
    var ok = writeFrame({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    if (!ok) {
      delete pending[id];
      return Promise.reject(exitError || new Error("codex stdin write failed"));
    }
    return p;
  }

  function notify(method, params) {
    writeFrame({ jsonrpc: "2.0", method: method, params: params || {} });
  }

  function respond(id, result) {
    writeFrame({ jsonrpc: "2.0", id: id, result: result == null ? {} : result });
  }

  function respondError(id, code, message, data) {
    var err = { code: code, message: message };
    if (typeof data !== "undefined") err.data = data;
    writeFrame({ jsonrpc: "2.0", id: id, error: err });
  }

  function close() {
    if (exited) return;
    try { child.stdin.end(); } catch (e) {}
    var killer = setTimeout(function () {
      if (!exited) {
        try { child.kill("SIGKILL"); } catch (e) {}
      }
    }, gracePeriodMs);
    // Don't keep the event loop alive just to reap a stuck child.
    if (killer && typeof killer.unref === "function") killer.unref();
  }

  return {
    request: request,
    notify: notify,
    respond: respond,
    respondError: respondError,
    close: close,
    isExited: function () { return exited; },
    pid: function () { return child.pid; },
    getStderrTail: function () { return stderrTail; },
  };
}

function makeDeadClient(err) {
  return {
    request: function () { return Promise.reject(err); },
    notify: function () {},
    respond: function () {},
    respondError: function () {},
    close: function () {},
    isExited: function () { return true; },
    pid: function () { return null; },
    getStderrTail: function () { return ""; },
  };
}

module.exports = { createCodexClient: createCodexClient };
