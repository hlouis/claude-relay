// End-to-end Codex smoke test driven over the same WebSocket protocol the
// browser uses. Assumes an isolated daemon is already running (see
// `npm run dev:isolated`).
//
// What we exercise:
//   1. IPC `add_project` to register /tmp/codex-playground with backend=codex.
//   2. WS connect to /p/{slug}/ws.
//   3. Wait for `info` message and assert codex flags + project backend.
//   4. Send a short prompt; wait for delta(s), then `done`.
//   5. Print captured assistant text and exit non-zero on any failure.
//
// Requires: ws (already a dep), the daemon running on $PORT (default 2637)
// inside the isolated HOME (default /tmp/clay-codex-test).

var fs = require("fs");
var path = require("path");
var net = require("net");
var WebSocket = require("ws");

var PORT = parseInt(process.env.PORT || "2637", 10);
var TESTHOME = process.env.TESTHOME || "/tmp/clay-codex-test";
var PLAYGROUND = process.env.PLAYGROUND || "/tmp/codex-playground";
var SOCKET_PATH = path.join(TESTHOME, ".clay", "daemon.sock");

var failures = [];
function check(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); return true; }
  console.log("  ✗ " + msg);
  failures.push(msg);
  return false;
}

function ipcSend(cmd) {
  // The daemon's IPC server writes a single-line JSON response and then keeps
  // the socket open (mirrors lib/ipc.js#sendIPCCommand). So we resolve on the
  // first newline rather than on `end`.
  return new Promise(function (resolve, reject) {
    var sock = net.createConnection(SOCKET_PATH);
    var buf = "";
    var done = false;
    var to = setTimeout(function () {
      if (done) return;
      done = true;
      sock.destroy();
      reject(new Error("IPC timeout: " + cmd.cmd));
    }, 5000);
    sock.on("connect", function () {
      sock.write(JSON.stringify(cmd) + "\n");
    });
    sock.on("data", function (chunk) {
      buf += chunk.toString();
      var idx = buf.indexOf("\n");
      if (idx === -1 || done) return;
      done = true;
      clearTimeout(to);
      sock.destroy();
      try { resolve(JSON.parse(buf.substring(0, idx))); }
      catch (e) { reject(new Error("IPC bad JSON: " + buf.substring(0, idx))); }
    });
    sock.on("error", function (err) {
      if (done) return;
      done = true;
      clearTimeout(to);
      reject(err);
    });
  });
}

function wsRecv(ws, predicate, timeoutMs, label) {
  return new Promise(function (resolve, reject) {
    var collected = [];
    var to = setTimeout(function () {
      ws.removeListener("message", onMsg);
      reject(new Error("timeout waiting for " + (label || "predicate") + "; saw types: " + collected.map(function (m) { return m.type; }).join(",")));
    }, timeoutMs || 60000);
    function onMsg(raw) {
      var m;
      try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      collected.push(m);
      if (predicate(m)) {
        clearTimeout(to);
        ws.removeListener("message", onMsg);
        resolve({ message: m, all: collected });
      }
    }
    ws.on("message", onMsg);
  });
}

(async function main() {
  console.log("[e2e] step 1: ensure playground dir exists");
  fs.mkdirSync(PLAYGROUND, { recursive: true });

  console.log("[e2e] step 2: register playground as codex project via IPC");
  // Remove first so a stale registration (e.g. from a prior run that
  // changed the backend field) can't poison this run — daemon.js's
  // `add_project` is a no-op when the path is already registered.
  await ipcSend({ cmd: "remove_project", path: PLAYGROUND }).catch(function () {});
  var ipcResp = await ipcSend({ cmd: "add_project", path: PLAYGROUND, backend: "codex" });
  if (!ipcResp.ok) throw new Error("add_project failed: " + JSON.stringify(ipcResp));
  var slug = ipcResp.slug;
  console.log("  → slug=" + slug + (ipcResp.existing ? " (existing)" : ""));

  console.log("[e2e] step 3: open WS to /p/" + slug + "/ws");
  var ws = new WebSocket("ws://localhost:" + PORT + "/p/" + slug + "/ws");
  await new Promise(function (resolve, reject) {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  // Iter 5b: attach the session_list capture as early as possible —
  // broadcasts fire on session creation / switch / etc. so we'd miss the
  // pre-fork state if we wait until step 6.8. We don't read the array
  // until needed; just make sure it's populated.
  var sessionLists = [];
  ws.on("message", function (raw) {
    var m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.type === "session_list" && Array.isArray(m.sessions)) sessionLists.push(m);
  });

  console.log("[e2e] step 4: wait for info + codex_config first echo (collected together)");
  // We wait for codex_config (which the connect handler sends right after
  // info on a Codex project) and then dig info out of the buffered set.
  // wsRecv removes its listener as soon as the predicate matches, so
  // racing two separate wsRecv calls would drop messages — we collect
  // both in a single drain.
  var connectDrain = await wsRecv(ws, function (m) { return m.type === "codex_config"; }, 10000, "codex_config first echo");
  var info = null;
  var firstEcho = connectDrain.message;
  for (var di = 0; di < connectDrain.all.length; di++) {
    if (connectDrain.all[di].type === "info") { info = connectDrain.all[di]; break; }
  }
  check(info !== null, "info message arrived before codex_config");
  check(info && info.backend === "codex", "info.backend === 'codex' (got " + (info && info.backend) + ")");
  check(info && info.codex && info.codex.binAvailable === true, "info.codex.binAvailable === true");
  check(info && info.codex && info.codex.authOk === true, "info.codex.authOk === true (got " + JSON.stringify(info && info.codex) + ")");
  check(
    info && info.capabilities && Array.isArray(info.capabilities.settings),
    "info.capabilities.settings is an array (got " + JSON.stringify(info && info.capabilities) + ")"
  );
  check(
    info && info.capabilities && info.capabilities.settings.indexOf("sandbox") !== -1,
    "Codex capabilities advertise 'sandbox'"
  );
  check(
    info && info.capabilities && info.capabilities.settings.indexOf("permissionMode") === -1,
    "Codex capabilities do NOT advertise Claude-only 'permissionMode'"
  );

  console.log("[e2e] step 4.5: verify codex_config first-connection echo carries defaults");
  check(firstEcho.sandbox === "workspace-write",
    "first-echo sandbox === 'workspace-write' (got " + firstEcho.sandbox + ")");
  check(firstEcho.approvalPolicy === "on-request",
    "first-echo approvalPolicy === 'on-request' (got " + firstEcho.approvalPolicy + ")");
  check(typeof firstEcho.model === "string",
    "first-echo carries model field (got " + JSON.stringify(firstEcho.model) + ")");
  check(typeof firstEcho.effort === "string",
    "first-echo carries effort field (got " + JSON.stringify(firstEcho.effort) + ")");

  console.log("[e2e] step 5: create a session and send a short prompt");
  ws.send(JSON.stringify({ type: "new_session" }));
  // Wait until the new session has been created server-side. The server
  // doesn't ack new_session directly; the next session list broadcast
  // confirms it. A small delay is sufficient and keeps the script simple.
  await new Promise(function (r) { setTimeout(r, 300); });
  ws.send(JSON.stringify({
    type: "message",
    text: "Reply with the single word HELLO and nothing else.",
  }));

  // Collect deltas until done.
  var deltas = [];
  var sawSessionId = false;
  var sawResult = false;
  var doneCode = null;
  var errorText = null;
  await new Promise(function (resolve, reject) {
    var to = setTimeout(function () { reject(new Error("timeout waiting for done")); }, 90000);
    ws.on("message", function (raw) {
      var m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.type === "session_id") sawSessionId = true;
      if (m.type === "delta" && typeof m.text === "string") deltas.push(m.text);
      if (m.type === "result") sawResult = true;
      if (m.type === "error") { errorText = m.text; }
      if (m.type === "auth_required") { errorText = "auth_required: " + m.text; }
      if (m.type === "done") {
        doneCode = m.code;
        clearTimeout(to);
        resolve();
      }
    });
  });

  console.log("[e2e] step 6: assertions on streamed response");
  if (errorText) console.log("  error seen: " + errorText);
  check(sawSessionId, "session_id received");
  check(deltas.length > 0, "at least one delta received (got " + deltas.length + ")");
  check(sawResult, "result message received");
  check(doneCode === 0, "done.code === 0 (got " + doneCode + ")");

  var fullText = deltas.join("");
  console.log("[e2e]   assistant text: " + JSON.stringify(fullText.slice(0, 200)));
  check(/HELLO/i.test(fullText), "response contains 'HELLO'");

  // Iter 3 step 3: verify the Codex-only setter path round-trips through
  // project.js → codex-backend.setSandbox/setApprovalPolicy → codex_config
  // echo. We only assert the echo carries the new values; whether they
  // actually take effect on the next thread/start is covered by unit
  // tests (see test/codex-approval.test.js).
  console.log("[e2e] step 6.5: verify codex_config echo for sandbox/approval setters");
  var echoes = [];
  ws.on("message", function (raw) {
    var m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.type === "codex_config") echoes.push(m);
  });
  ws.send(JSON.stringify({ type: "set_codex_sandbox", sandbox: "read-only" }));
  ws.send(JSON.stringify({ type: "set_codex_approval_policy", approvalPolicy: "never" }));
  await new Promise(function (r) { setTimeout(r, 500); });
  check(echoes.length >= 2, "at least 2 codex_config echoes received (got " + echoes.length + ")");
  var lastEcho = echoes[echoes.length - 1];
  check(lastEcho && lastEcho.sandbox === "read-only", "echo.sandbox === 'read-only'");
  check(lastEcho && lastEcho.approvalPolicy === "never", "echo.approvalPolicy === 'never'");

  // Iter 4 follow-up: persistence to daemon.json. After a setter fires the
  // daemon must have updated `config.projects[i].codexConfig` and written
  // it to disk so a daemon restart preserves the user's selection. We
  // assert the file shape directly instead of restarting the daemon.
  console.log("[e2e] step 6.6: verify daemon.json reflects persisted codexConfig");
  var daemonJsonPath = path.join(TESTHOME, ".clay", "daemon.json");
  // Allow saveConfig() to land — it's synchronous in daemon.js but the
  // setter path is async via WS, so a tick is enough.
  await new Promise(function (r) { setTimeout(r, 200); });
  var dj = null;
  try { dj = JSON.parse(fs.readFileSync(daemonJsonPath, "utf8")); }
  catch (e) { /* dj stays null */ }
  check(dj !== null, "daemon.json is readable at " + daemonJsonPath);
  var savedEntry = null;
  if (dj && Array.isArray(dj.projects)) {
    for (var pi = 0; pi < dj.projects.length; pi++) {
      if (dj.projects[pi].slug === slug) { savedEntry = dj.projects[pi]; break; }
    }
  }
  check(savedEntry !== null, "project entry for slug=" + slug + " present in daemon.json");
  check(savedEntry && savedEntry.codexConfig, "codexConfig key exists on the project entry");
  check(savedEntry && savedEntry.codexConfig && savedEntry.codexConfig.sandbox === "read-only",
    "daemon.json sandbox === 'read-only' (got " + (savedEntry && savedEntry.codexConfig && savedEntry.codexConfig.sandbox) + ")");
  check(savedEntry && savedEntry.codexConfig && savedEntry.codexConfig.approvalPolicy === "never",
    "daemon.json approvalPolicy === 'never' (got " + (savedEntry && savedEntry.codexConfig && savedEntry.codexConfig.approvalPolicy) + ")");

  // Iter 5b: HEAD-only thread fork over WS. We exercise the fork_thread
  // path now (before ws.close()) because we need an ACTIVE session with a
  // real cliSessionId — i.e. one that already completed a turn. The
  // session from step 5 satisfies that.
  //
  // We deliberately do NOT issue a follow-up turn on the fork — that
  // would add another paid LLM call to CI. The unit tests cover the
  // forkActiveThread translation contract; live verify exercises a real
  // turn round-trip.
  console.log("[e2e] step 6.8: fork active thread (HEAD-only, no follow-up turn)");
  // sessionLists is populated by the listener attached at step 3.
  await new Promise(function (r) { setTimeout(r, 200); });
  var preForkList = sessionLists[sessionLists.length - 1] || null;
  var preForkCount = preForkList ? preForkList.sessions.length : 0;
  // Field is named `id` in mapSessionForClient (renamed from session.localId).
  // Use the active flag to pick THE source session — there may be stale
  // sessions from previous runs in the broadcast.
  var sourceLocalId = null;
  var sourceCliSessionId = null;
  if (preForkList) {
    for (var psi = 0; psi < preForkList.sessions.length; psi++) {
      if (preForkList.sessions[psi].active) {
        sourceLocalId = preForkList.sessions[psi].id;
        sourceCliSessionId = preForkList.sessions[psi].cliSessionId;
        break;
      }
    }
  }
  console.log("  pre-fork session count: " + preForkCount + " (sourceLocalId=" + sourceLocalId + ")");

  // Fire fork_thread; wait for either codex_fork_error or a session_switched
  // pointing at a session DIFFERENT from the source. createSession's
  // bootstrap fires a session_switched with cliSessionId=null first; we
  // filter for the post-mutation event by requiring a non-empty
  // cliSessionId AND a localId different from sourceLocalId.
  var forkOutcome = await new Promise(function (resolve) {
    var to = setTimeout(function () { resolve({ kind: "timeout" }); }, 30000);
    function onMsg(raw) {
      var m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.type === "codex_fork_error") {
        clearTimeout(to);
        ws.removeListener("message", onMsg);
        resolve({ kind: "error", msg: m });
        return;
      }
      // Only the FINAL session_switched (from project.js's explicit
      // switchSession after the new session has its cliSessionId) carries
      // both a fresh localId AND a non-empty cliSessionId.
      if (m.type === "session_switched"
          && m.id !== sourceLocalId
          && typeof m.cliSessionId === "string"
          && m.cliSessionId.length > 0) {
        clearTimeout(to);
        ws.removeListener("message", onMsg);
        resolve({ kind: "switched", msg: m });
      }
    }
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ type: "fork_thread" }));
  });
  check(forkOutcome.kind === "switched",
    "fork_thread → session_switched (got kind=" + forkOutcome.kind +
    (forkOutcome.kind === "error" ? ", reason=" + (forkOutcome.msg && forkOutcome.msg.reason) : "") + ")");
  if (forkOutcome.kind === "switched") {
    check(typeof forkOutcome.msg.cliSessionId === "string" && forkOutcome.msg.cliSessionId.length > 0,
      "fork session_switched carries a cliSessionId");
    check(forkOutcome.msg.cliSessionId !== sourceCliSessionId,
      "forked thread id differs from source (" + forkOutcome.msg.cliSessionId +
      " vs source " + sourceCliSessionId + ")");

    // Wait briefly for the post-fork list broadcast.
    await new Promise(function (r) { setTimeout(r, 400); });
    var postForkList = sessionLists[sessionLists.length - 1];
    check(postForkList && postForkList.sessions.length === preForkCount + 1,
      "session list grew by exactly one after fork (preFork=" + preForkCount +
      ", postFork=" + (postForkList ? postForkList.sessions.length : "<none>") + ")");

    // Switch back to the source session and confirm it's still alive.
    if (sourceLocalId != null) {
      var switchOutcome = await new Promise(function (resolve) {
        var to = setTimeout(function () { resolve(null); }, 5000);
        function onMsg(raw) {
          var m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
          if (m.type === "session_switched" && m.id === sourceLocalId) {
            clearTimeout(to);
            ws.removeListener("message", onMsg);
            resolve(m);
          }
        }
        ws.on("message", onMsg);
        ws.send(JSON.stringify({ type: "switch_session", id: sourceLocalId }));
      });
      check(switchOutcome != null,
        "switch_session back to source returns session_switched (id=" + sourceLocalId + ")");
      check(switchOutcome && typeof switchOutcome.cliSessionId === "string"
            && switchOutcome.cliSessionId.length > 0,
        "switched-back session_switched carries source cliSessionId");
    }
  }

  ws.close();
  await new Promise(function (r) { setTimeout(r, 200); });

  // Iter 4 follow-up: reconnect to verify that the codex_config echo on a
  // brand-new WS connection carries the values we just set, not the
  // defaults. This proves the load path (in-memory desired* survives
  // across WS lifecycles) and the connect-handler echo work end-to-end.
  console.log("[e2e] step 6.7: reconnect and verify codex_config echo carries persisted values");
  var ws2 = new WebSocket("ws://localhost:" + PORT + "/p/" + slug + "/ws");
  await new Promise(function (resolve, reject) {
    ws2.once("open", resolve);
    ws2.once("error", reject);
  });
  // Single-drain to avoid the listener-removal race that would otherwise
  // drop codex_config when wsRecv resolves on info.
  var reconnectDrain = await wsRecv(ws2, function (m) { return m.type === "codex_config"; }, 5000, "codex_config on reconnect");
  var reconnectEcho = reconnectDrain.message;
  check(reconnectEcho.sandbox === "read-only",
    "reconnect echo sandbox === 'read-only' (got " + reconnectEcho.sandbox + ")");
  check(reconnectEcho.approvalPolicy === "never",
    "reconnect echo approvalPolicy === 'never' (got " + reconnectEcho.approvalPolicy + ")");
  ws2.close();

  console.log("[e2e] step 7: cleanup — remove project");
  await ipcSend({ cmd: "remove_project", slug: slug }).catch(function () {});

  if (failures.length) {
    console.log("\n[e2e] FAILED " + failures.length + " checks");
    process.exit(1);
  }
  console.log("\n[e2e] PASSED all checks");
  process.exit(0);
})().catch(function (e) {
  console.error("[e2e] crashed:", e.message || e);
  process.exit(2);
});
