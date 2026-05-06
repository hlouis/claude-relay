// Live end-to-end verification for iter-2 approval flow.
// NOT an automated test (model behavior is non-deterministic) — it is a
// human-in-the-loop / debug-time verification that drives a real Codex
// project through Playwright and prints what happens.
//
// What it does:
//   1. Register /tmp/codex-playground as a Codex project via IPC.
//   2. Open the project page in headless Chromium.
//   3. Send a prompt that is very likely to trigger a Codex approval
//      (write a file outside the workspace cwd).
//   4. Watch WS frames; on `permission_request` with source=codex:
//      a. Screenshot the modal.
//      b. Verify the badge text and dataset.
//      c. Click "Allow Once".
//      d. Wait for `permission_resolved` and turn `done`.
//   5. Print streamed assistant text + final outcome.
//
// Run with isolated daemon already up:
//   npm run dev:isolated
//   node scripts/codex-approval-live-verify.js

var fs = require("fs");
var path = require("path");
var net = require("net");
var { chromium } = require("playwright");

var URL_BASE = process.env.CLAY_URL || "http://localhost:2637";
var TESTHOME = process.env.TESTHOME || "/tmp/clay-codex-test";
var PLAYGROUND = "/tmp/codex-playground";
var SOCKET_PATH = path.join(TESTHOME, ".clay", "daemon.sock");
var SHOTS_DIR = path.join(TESTHOME, "screenshots");
// Use a path outside /tmp (Codex's slash_tmp special path is permissively
// allowed in workspace-write) and outside the workspace cwd. The user's
// real home dir is the cleanest way to ensure a sandbox-violation that
// `approvalPolicy: on-request` actually intercepts.
var TARGET_PATH = path.join(process.env.HOME || "/Users/louis", "codex-iter2-approval-target.txt");

function ipcSend(cmd) {
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
    sock.on("connect", function () { sock.write(JSON.stringify(cmd) + "\n"); });
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
      done = true; clearTimeout(to); reject(err);
    });
  });
}

function wipePlaygroundSessions() {
  var encoded = PLAYGROUND.replace(/\//g, "-");
  var dir = path.join(TESTHOME, ".clay", "sessions", encoded);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

async function shot(page, name) {
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    var p = path.join(SHOTS_DIR, name + ".png");
    await page.screenshot({ path: p, fullPage: true });
    console.log("  📸 " + p);
  } catch (e) { console.log("  (screenshot failed: " + e.message + ")"); }
}

(async function main() {
  fs.mkdirSync(PLAYGROUND, { recursive: true });
  try { fs.unlinkSync(TARGET_PATH); } catch (e) {}
  wipePlaygroundSessions();

  console.log("[verify] step 1: register Codex project via IPC");
  // Remove first so we always add fresh — the IPC `add_project` handler
  // returns `existing: true` on dup paths and does NOT update the backend
  // field, which silently routes the project through Claude if a previous
  // Claude-side test left a record behind.
  await ipcSend({ cmd: "remove_project", path: PLAYGROUND }).catch(function () {});
  var ipcResp = await ipcSend({ cmd: "add_project", path: PLAYGROUND, backend: "codex" });
  if (!ipcResp.ok) throw new Error("add_project failed: " + JSON.stringify(ipcResp));
  var slug = ipcResp.slug;
  console.log("  → slug=" + slug + " backend=codex");

  console.log("[verify] step 2: launch chromium");
  var browser = await chromium.launch({ headless: true });
  var ctx = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });

  // Capture WS frames so we can correlate UI behavior with protocol messages.
  var receivedTypes = [];
  var permissionRequests = [];
  var permissionResolved = [];
  var doneCode = null;
  var deltas = [];
  var errorText = null;

  ctx.on("page", function (newPage) {
    newPage.on("websocket", function (ws) {
      ws.on("framereceived", function (f) {
        if (typeof f.payload !== "string") return;
        try {
          var m = JSON.parse(f.payload);
          receivedTypes.push(m.type);
          if (m.type === "permission_request") permissionRequests.push(m);
          if (m.type === "permission_resolved") permissionResolved.push(m);
          if (m.type === "delta" && typeof m.text === "string") deltas.push(m.text);
          if (m.type === "done") doneCode = m.code;
          if (m.type === "error") errorText = m.text;
        } catch (e) {}
      });
    });
  });

  var page = await ctx.newPage();
  page.on("console", function (msg) {
    if (msg.type() === "error") console.log("  [browser-error] " + msg.text());
  });

  console.log("[verify] step 3: open project page");
  await page.goto(URL_BASE + "/p/" + slug + "/", { waitUntil: "domcontentloaded" });
  // Need to wait for app to bootstrap and create a session, then force the
  // composer visible (codex-ui-e2e does the same dance).
  await page.waitForTimeout(1500);
  await page.evaluate(function () {
    var area = document.getElementById("input-area");
    if (area) area.classList.remove("hidden");
  });
  var composer = page.locator("#input");
  await composer.waitFor({ state: "visible", timeout: 10000 });
  await shot(page, "30-project-loaded");

  console.log("[verify] step 4: send a prompt that requires writing outside the sandbox");
  // workspace-write allows writes to cwd and Codex-special paths (including
  // /tmp). Writing to the user's real home directory is unambiguously
  // outside the sandbox and triggers `approvalPolicy: on-request`.
  var prompt = 'Run exactly this shell command, no alternatives, no clarification: '
    + 'echo HELLO_FROM_CODEX > ' + TARGET_PATH + '. '
    + 'After the command succeeds, reply with the single word DONE.';
  await composer.fill(prompt);
  await composer.press("Enter");

  console.log("[verify] step 5: wait for permission_request (up to 60s)");
  var permWaitStart = Date.now();
  while (permissionRequests.length === 0 && Date.now() - permWaitStart < 60000) {
    if (doneCode !== null) break;
    if (errorText) break;
    await new Promise(function (r) { setTimeout(r, 500); });
  }

  if (permissionRequests.length === 0) {
    console.log("  ⚠ no permission_request seen within 60s");
    console.log("  WS types observed: " + JSON.stringify(receivedTypes));
    console.log("  errorText: " + errorText);
    console.log("  doneCode: " + doneCode);
    console.log("  deltas (first 200 chars): " + JSON.stringify(deltas.join("").slice(0, 200)));
    await shot(page, "31-no-permission-after-60s");
    await browser.close();
    process.exit(2);
  }

  var pr = permissionRequests[0];
  console.log("[verify] step 6: permission_request received");
  console.log("    requestId   = " + pr.requestId);
  console.log("    source      = " + pr.source);
  console.log("    toolName    = " + pr.toolName);
  console.log("    toolInput   = " + JSON.stringify(pr.toolInput).slice(0, 220));
  if (pr.source !== "codex") {
    console.log("  ✗ source is not 'codex' (got " + pr.source + ")");
    await browser.close();
    process.exit(1);
  }
  console.log("  ✓ source === 'codex'");

  console.log("[verify] step 7: assert badge in DOM");
  await page.waitForSelector(".permission-source-badge[data-source=\"codex\"]", { timeout: 5000 });
  var badgeText = await page.locator(".permission-source-badge[data-source=\"codex\"]").first().textContent();
  console.log("  ✓ Codex source badge rendered, text=" + JSON.stringify(badgeText));
  await shot(page, "32-permission-modal-codex-badge");

  console.log("[verify] step 8: click 'Allow Once'");
  await page.locator(".permission-container[data-request-id=\"" + pr.requestId + "\"] .permission-allow").first().click();

  console.log("[verify] step 9: wait for permission_resolved + turn done (up to 90s)");
  var doneWaitStart = Date.now();
  while (doneCode === null && Date.now() - doneWaitStart < 90000) {
    await new Promise(function (r) { setTimeout(r, 500); });
  }

  console.log("[verify] step 10: outcome");
  console.log("    permission_resolved frames: " + permissionResolved.length);
  console.log("    deltas total chars        : " + deltas.join("").length);
  console.log("    doneCode                  : " + doneCode);
  console.log("    errorText                 : " + errorText);
  console.log("    file at target            : " + (fs.existsSync(TARGET_PATH) ? "exists" : "missing"));
  if (fs.existsSync(TARGET_PATH)) {
    try {
      var content = fs.readFileSync(TARGET_PATH, "utf8");
      console.log("    file content              : " + JSON.stringify(content));
    } catch (e) {}
  }
  console.log("    last 200 chars assistant  : " + JSON.stringify(deltas.join("").slice(-200)));
  await shot(page, "33-after-approval-complete");

  await browser.close();
  if (doneCode !== 0) {
    console.log("  ✗ turn did not finish cleanly");
    process.exit(1);
  }
  console.log("\n[verify] ✓ live approval flow round-trip succeeded");
})().catch(function (e) {
  console.error("[verify] crashed:", e.message || e);
  process.exit(2);
});
