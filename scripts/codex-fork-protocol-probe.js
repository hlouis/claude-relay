// Iter 5b protocol probe — VERIFY before designing.
//
// Lessons from Iter 5a (CODEX_PLAN.md → "Iter 5a KILLED"): plan-time schema
// assumptions are worthless until exercised against a live `codex
// app-server`. This probe spawns codex directly (no Clay daemon, no UI)
// and asserts the exact behavior of `thread/fork` / `thread/resume` /
// related methods so the 5b implementation can be designed against
// observed truth, not docstring-derived guesses.
//
// What we want to learn:
//   1. Is `thread/fork` reachable? Method-not-found is a kill switch.
//   2. Does it return { thread: { id, forkedFromId } }? Are these the
//      camelCase strings we expect?
//   3. Does the SOURCE thread stay alive after fork (can take turn/start)?
//   4. Does the FORKED thread inherit conversation context (model can
//      reference prior turns)? Or is it empty?
//   5. Does `excludeTurns: true` produce an empty fork?
//   6. Does `thread/resume { threadId }` work as the "switch back to old
//      thread" primitive? Same-id round-trip?
//   7. Are unknown fork-anchor fields (`atTurnId`, `atItemId`) silently
//      ignored or rejected? (confirms no native fork-point support →
//      drives 5b UX decision)
//
// Out of scope:
//   - Authentication. Probe assumes ~/.codex/auth.json is valid; if codex
//     pings auth/refresh during a turn we just decline-and-bail.
//   - Network policy / sandbox. Probe uses read-only sandbox + never
//     approval policy so no human-in-the-loop is required.
//
// Cost note: each `turn/start` is a real API call. The probe issues at
// most ~6 turns with single-token prompts. Run sparingly.
//
// Usage:
//   node scripts/codex-fork-protocol-probe.js
//   PROBE_VERBOSE=1 node scripts/codex-fork-protocol-probe.js

var path = require("path");
var fs = require("fs");
var { createCodexClient } = require("../lib/codex-jsonrpc");

var VERBOSE = !!process.env.PROBE_VERBOSE;
var CWD = process.env.PROBE_CWD || "/tmp";
// Plenty of headroom for slow first-token; we abort the probe rather than
// hang forever on each step.
var TURN_TIMEOUT_MS = 90000;

function log() {
  console.log.apply(console, ["[probe]"].concat(Array.prototype.slice.call(arguments)));
}
function vlog() {
  if (VERBOSE) console.log.apply(console, ["[probe]"].concat(Array.prototype.slice.call(arguments)));
}

var failures = [];
function check(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); return true; }
  console.log("  ✗ " + msg);
  failures.push(msg);
  return false;
}

function locateCodexBin() {
  // Mirror codex-backend.js's findCodexBinary semantics minimally: PATH
  // lookup via shell. We don't probe the daemon's recorded path because
  // this script is intentionally Clay-less.
  var which = require("child_process").spawnSync("which", ["codex"]);
  if (which.status === 0) return which.stdout.toString().trim();
  return null;
}

// Wait for a turn to terminate by listening for `turn/completed` or
// `turn/failed` notifications. Returns final-state items if the
// notification provides them.
function awaitTurnEnd(notifications, threadId) {
  var startIdx = notifications.length;
  return new Promise(function (resolve, reject) {
    var deadline = Date.now() + TURN_TIMEOUT_MS;
    var t = setInterval(function () {
      for (var i = startIdx; i < notifications.length; i++) {
        var n = notifications[i];
        var p = n.params || {};
        if (n.method === "turn/completed" && p.threadId === threadId) {
          clearInterval(t);
          return resolve({ kind: "completed", note: n });
        }
        if (n.method === "turn/failed" && p.threadId === threadId) {
          clearInterval(t);
          return resolve({ kind: "failed", note: n });
        }
      }
      if (Date.now() > deadline) {
        clearInterval(t);
        reject(new Error("turn timeout after " + TURN_TIMEOUT_MS + "ms"));
      }
    }, 100);
  });
}

(async function main() {
  var bin = locateCodexBin();
  if (!bin) {
    console.error("codex binary not found in PATH");
    process.exit(2);
  }
  log("codex binary:", bin);

  var notifications = [];
  var serverRequests = [];
  var stderrChunks = [];

  var client = createCodexClient({
    command: bin,
    args: ["app-server"],
    cwd: CWD,
    onNotification: function (n) {
      notifications.push(n);
      vlog("« notify", n.method, JSON.stringify(n.params || {}).slice(0, 200));
    },
    onServerRequest: function (msg) {
      serverRequests.push(msg);
      vlog("« request", msg.method, JSON.stringify(msg.params || {}).slice(0, 200));
      // Default: decline approvals so probe never blocks. Probe should
      // never trigger one because we ask for read-only sandbox and the
      // prompts are all "say one word".
      try { client.respondError(msg.id, -32601, "probe declines all server requests"); } catch (_) {}
    },
    onExit: function (code, signal) {
      log("client exited code=" + code + " signal=" + signal);
    },
    onStderr: function (chunk) {
      stderrChunks.push(chunk);
      if (VERBOSE) process.stderr.write("[codex-stderr] " + chunk);
    },
  });

  try {
    log("step 1: initialize");
    var initResp = await client.request("initialize", {
      clientInfo: { name: "clay-fork-probe", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    check(typeof initResp === "object", "initialize returned an object");
    vlog("initialize response:", JSON.stringify(initResp).slice(0, 400));

    log("step 2: thread/start (source thread)");
    var startResp = await client.request("thread/start", {
      cwd: CWD,
      sandbox: "read-only",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
    });
    var sourceThreadId = startResp && startResp.thread && startResp.thread.id;
    check(typeof sourceThreadId === "string" && sourceThreadId.length > 0,
      "thread/start returned thread.id (got " + sourceThreadId + ")");
    var sourceForkedFrom = startResp.thread.forkedFromId;
    check(sourceForkedFrom == null,
      "fresh thread has forkedFromId == null (got " + JSON.stringify(sourceForkedFrom) + ")");

    log("step 3: send a tiny turn so source has history");
    await client.request("turn/start", {
      threadId: sourceThreadId,
      input: [{ type: "text", text:"Reply with the single word ALPHA. No other text." }],
    });
    var turnA = await awaitTurnEnd(notifications, sourceThreadId);
    check(turnA.kind === "completed", "source thread first turn completed (kind=" + turnA.kind + ")");

    // --- Probe A: thread/fork basic shape ---
    log("step 4: thread/fork { threadId }");
    var forkResp;
    var forkErr = null;
    try {
      forkResp = await client.request("thread/fork", { threadId: sourceThreadId });
    } catch (e) {
      forkErr = e;
    }
    check(forkErr == null, "thread/fork did NOT return JSON-RPC error (err=" + (forkErr && forkErr.message) + ")");
    if (forkErr) {
      log("  fork error detail:", JSON.stringify(forkErr).slice(0, 400));
    }
    var forkedThreadId = forkResp && forkResp.thread && forkResp.thread.id;
    check(typeof forkedThreadId === "string" && forkedThreadId.length > 0,
      "fork response.thread.id is a string (got " + forkedThreadId + ")");
    check(forkedThreadId !== sourceThreadId,
      "forked id differs from source (" + forkedThreadId + " vs " + sourceThreadId + ")");
    check(forkResp && forkResp.thread && forkResp.thread.forkedFromId === sourceThreadId,
      "fork response.thread.forkedFromId === sourceThreadId (got " + (forkResp && forkResp.thread && forkResp.thread.forkedFromId) + ")");

    if (forkResp && forkResp.thread && Array.isArray(forkResp.thread.turns)) {
      log("  forked thread.turns.length=" + forkResp.thread.turns.length);
    } else {
      log("  forked thread.turns is", typeof (forkResp && forkResp.thread && forkResp.thread.turns));
    }

    // --- Probe B: forked thread inherits context ---
    if (forkedThreadId) {
      log("step 5: turn/start on FORK — does it remember 'ALPHA'?");
      await client.request("turn/start", {
        threadId: forkedThreadId,
        input: [{ type: "text", text:"What single word did you reply previously? Answer with just that one word." }],
      });
      var turnB = await awaitTurnEnd(notifications, forkedThreadId);
      check(turnB.kind === "completed", "fork turn completed (kind=" + turnB.kind + ")");
      // Inspect notifications for assistant text — the model should echo ALPHA.
      var lastAssistantText = "";
      for (var i = notifications.length - 1; i >= 0; i--) {
        var n = notifications[i];
        if (n.method && n.method.indexOf("item/") === 0 && n.params && n.params.threadId === forkedThreadId) {
          var item = n.params.item || {};
          if (item.type === "assistant_message" || item.type === "agent_message") {
            lastAssistantText = JSON.stringify(item).slice(0, 200);
            break;
          }
        }
      }
      log("  fork's last assistant item snippet:", lastAssistantText || "(none captured — see VERBOSE)");
      // Soft check: the model's reply may include punctuation. We just print.
    }

    // --- Probe C: source thread still alive ---
    log("step 6: turn/start on SOURCE after fork — does it still work?");
    await client.request("turn/start", {
      threadId: sourceThreadId,
      input: [{ type: "text", text:"Reply with the single word BETA. No other text." }],
    });
    var turnC = await awaitTurnEnd(notifications, sourceThreadId);
    check(turnC.kind === "completed", "source thread accepts turn/start AFTER fork (kind=" + turnC.kind + ")");

    // --- Probe D: thread/fork with bogus threadId ---
    log("step 7: thread/fork { threadId: 'bogus' } — expect error");
    var bogusErr = null;
    try {
      await client.request("thread/fork", { threadId: "bogus-thread-id-does-not-exist" });
    } catch (e) {
      bogusErr = e;
    }
    check(bogusErr != null, "fork with bogus threadId returned an error");
    if (bogusErr) {
      log("  bogus fork error code=" + bogusErr.code + " message=" + bogusErr.message);
      check(bogusErr.code !== -32601,
        "error code is NOT -32601 method-not-found (got " + bogusErr.code + ") — confirms method exists");
    }

    // --- Probe E: thread/fork with excludeTurns: true ---
    log("step 8: thread/fork { threadId, excludeTurns: true }");
    var emptyForkResp = null;
    var emptyForkErr = null;
    try {
      emptyForkResp = await client.request("thread/fork", {
        threadId: sourceThreadId,
        excludeTurns: true,
      });
    } catch (e) {
      emptyForkErr = e;
    }
    check(emptyForkErr == null,
      "thread/fork with excludeTurns:true did NOT error (err=" + (emptyForkErr && emptyForkErr.message) + ")");
    if (emptyForkResp && emptyForkResp.thread) {
      var emptyTurns = emptyForkResp.thread.turns;
      log("  excludeTurns fork thread.turns:", Array.isArray(emptyTurns) ? "len=" + emptyTurns.length : typeof emptyTurns);
      if (Array.isArray(emptyTurns)) {
        check(emptyTurns.length === 0,
          "excludeTurns:true → thread.turns is empty (got len=" + emptyTurns.length + ")");
      }
    }

    // --- Probe F: thread/resume basic round-trip ---
    log("step 9: thread/resume { threadId } on source");
    var resumeResp = null;
    var resumeErr = null;
    try {
      resumeResp = await client.request("thread/resume", { threadId: sourceThreadId });
    } catch (e) {
      resumeErr = e;
    }
    check(resumeErr == null,
      "thread/resume did NOT error (err=" + (resumeErr && resumeErr.message) + ")");
    if (resumeResp && resumeResp.thread) {
      check(resumeResp.thread.id === sourceThreadId,
        "thread/resume returns the SAME id (round-trip)");
      log("  resume.thread.turns len:", Array.isArray(resumeResp.thread.turns) ? resumeResp.thread.turns.length : typeof resumeResp.thread.turns);
    }

    log("step 10: turn/start AFTER resume on the resumed thread");
    await client.request("turn/start", {
      threadId: sourceThreadId,
      input: [{ type: "text", text:"Reply with the single word GAMMA. No other text." }],
    });
    var turnD = await awaitTurnEnd(notifications, sourceThreadId);
    check(turnD.kind === "completed",
      "resumed source thread accepts turn/start (kind=" + turnD.kind + ")");

    // --- Probe G: unknown anchor fields silently ignored ---
    log("step 11: thread/fork with unknown 'atTurnId' field — expect silently accepted");
    var anchorErr = null;
    var anchorResp = null;
    try {
      anchorResp = await client.request("thread/fork", {
        threadId: sourceThreadId,
        atTurnId: "not-a-real-field",
        atItemId: "also-fake",
      });
    } catch (e) {
      anchorErr = e;
    }
    check(anchorErr == null,
      "fork with unknown anchor fields did NOT error (err=" + (anchorErr && anchorErr.message) + ") — confirms no native fork-point support");

    log("\n=== probe summary ===");
    log("notifications observed: " + notifications.length);
    log("server requests during probe: " + serverRequests.length + " (probe declines all)");
    if (failures.length) {
      log("FAILURES: " + failures.length);
      failures.forEach(function (f) { log("  - " + f); });
      client.close();
      process.exit(1);
    }
    log("all probe assertions passed");
    client.close();
    // Give graceful close a beat, then exit.
    setTimeout(function () { process.exit(0); }, 500);
  } catch (e) {
    console.error("[probe] crashed:", e && (e.stack || e.message || e));
    try { client.close(); } catch (_) {}
    process.exit(2);
  }
})();
