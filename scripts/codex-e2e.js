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

  console.log("[e2e] step 4: wait for info; assert codex flags");
  var info = (await wsRecv(ws, function (m) { return m.type === "info"; }, 10000, "info")).message;
  check(info.backend === "codex", "info.backend === 'codex' (got " + info.backend + ")");
  check(info.codex && info.codex.binAvailable === true, "info.codex.binAvailable === true");
  check(info.codex && info.codex.authOk === true, "info.codex.authOk === true (got " + JSON.stringify(info.codex) + ")");

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

  ws.close();

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
