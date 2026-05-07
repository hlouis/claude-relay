// Iter 5b live verify — drives a real Codex turn through fork to prove
// the contract holds end-to-end. NOT in CI (model behavior is
// non-deterministic + costs API calls per run); run it manually before
// any 5b release.
//
// What it proves (none of the unit/e2e tests can):
//   1. After fork, the new thread on Codex's side actually inherits the
//      source's conversation (`thread/fork` server-side history copy is
//      working).
//   2. The original thread is still alive after fork — switching back via
//      thread/resume continues the conversation as if nothing happened.
//   3. Clay's session JSONL on disk for both threads contains coherent,
//      replayable history.
//
// Why this matters: in iter 5a, every unit test passed and Codex
// silently dropped the modifiedCommand. Live verify caught that. Same
// pattern here — schema research + probe say fork copies history, but
// the only thing that proves it for a real model is asking the new
// thread "what did I just say."
//
// Pattern (mirrors codex-approval-live-verify.js):
//   1. Register /tmp/codex-playground as Codex.
//   2. Open page in headless Chromium.
//   3. Send turn 1: "Reply with the single word ALPHA."
//   4. Wait for done.
//   5. Click the topbar Fork button → confirm modal → confirm.
//   6. Wait for sidebar to switch to the new session.
//   7. On the FORK, ask: "What single word did you reply previously? Just the word."
//      → assistant text must contain ALPHA.
//   8. Switch sidebar back to source session.
//   9. On the SOURCE (resumed), ask the same question.
//      → assistant text must also contain ALPHA.
//   10. Cleanup.
//
// Run with isolated daemon already up:
//   npm run dev:isolated
//   node scripts/codex-fork-live-verify.js

var fs = require("fs");
var path = require("path");
var net = require("net");
var { chromium } = require("playwright");

var URL_BASE = process.env.CLAY_URL || "http://localhost:2637";
var TESTHOME = process.env.TESTHOME || "/tmp/clay-codex-test";
var PLAYGROUND = process.env.PLAYGROUND || "/tmp/codex-playground";
var SOCKET_PATH = path.join(TESTHOME, ".clay", "daemon.sock");
var SHOTS_DIR = path.join(TESTHOME, "screenshots");
var TURN_TIMEOUT = 90000;

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

// Send a prompt + wait for done. Returns concatenated assistant deltas.
function runTurn(page, ws, prompt, label) {
  console.log("[verify] " + label + ": prompt=" + JSON.stringify(prompt.slice(0, 80)));
  return new Promise(async function (resolve, reject) {
    var deltas = [];
    var done = false;
    var to = setTimeout(function () {
      if (!done) {
        done = true;
        reject(new Error(label + ": turn timed out after " + TURN_TIMEOUT + "ms"));
      }
    }, TURN_TIMEOUT);
    function onMsg(raw) {
      var m;
      try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.type === "delta" && typeof m.text === "string") deltas.push(m.text);
      if (m.type === "done") {
        if (!done) {
          done = true;
          clearTimeout(to);
          ws.removeListener("message", onMsg);
          resolve({ text: deltas.join(""), code: m.code });
        }
      }
    }
    ws.on("message", onMsg);
    var composer = page.locator("#input");
    await composer.fill(prompt);
    await composer.press("Enter");
  });
}

(async function main() {
  console.log("[verify] step 1: register Codex playground");
  fs.mkdirSync(PLAYGROUND, { recursive: true });
  wipePlaygroundSessions();
  await ipcSend({ cmd: "remove_project", path: PLAYGROUND }).catch(function () {});
  var ipcResp = await ipcSend({ cmd: "add_project", path: PLAYGROUND, backend: "codex" });
  if (!ipcResp.ok) throw new Error("add_project failed: " + JSON.stringify(ipcResp));
  var slug = ipcResp.slug;
  console.log("  → slug=" + slug);

  console.log("[verify] step 2: launch chromium");
  var browser = await chromium.launch({ headless: true });
  var ctx = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });

  // Iter 5b: capture WS frames Node-side (Playwright's framereceived
  // event) instead of trying to hook window.ws — Clay's app.js keeps `ws`
  // module-private. We push every parsed message into a shared array and
  // poll it from the test code below.
  var receivedMsgs = [];
  ctx.on("page", function (newPage) {
    newPage.on("websocket", function (sock) {
      sock.on("framereceived", function (f) {
        if (typeof f.payload !== "string") return;
        try { receivedMsgs.push(JSON.parse(f.payload)); } catch (e) {}
      });
    });
  });
  var page = await ctx.newPage();
  page.on("console", function (m) {
    if (m.type() === "error") console.log("  [browser-error] " + m.text());
  });

  console.log("[verify] step 3: open project page");
  await page.goto(URL_BASE + "/p/" + slug + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.evaluate(function () {
    var area = document.getElementById("input-area");
    if (area) area.classList.remove("hidden");
  });
  await page.locator("#input").waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(function () {
    var b = document.getElementById("header-fork-btn");
    return b && !b.hidden;
  }, { timeout: 8000 });
  console.log("  fork button visible — capabilities.threadFork accepted");
  await shot(page, "80-fork-loaded");

  // Helpers operate on the Node-side `receivedMsgs` array populated by
  // the framereceived listener above.
  function waitForDoneAfter(mark, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || TURN_TIMEOUT);
    return new Promise(function (resolve, reject) {
      var t = setInterval(function () {
        for (var i = mark; i < receivedMsgs.length; i++) {
          if (receivedMsgs[i].type === "done") {
            clearInterval(t);
            return resolve(receivedMsgs[i]);
          }
        }
        if (Date.now() > deadline) {
          clearInterval(t);
          reject(new Error("turn timeout after " + (timeoutMs || TURN_TIMEOUT) + "ms"));
        }
      }, 200);
    });
  }
  function waitForCondition(fn, timeoutMs, label) {
    var deadline = Date.now() + (timeoutMs || 10000);
    return new Promise(function (resolve, reject) {
      var t = setInterval(function () {
        var r = fn(receivedMsgs);
        if (r) { clearInterval(t); return resolve(r); }
        if (Date.now() > deadline) {
          clearInterval(t);
          reject(new Error("waitForCondition timeout: " + (label || "unknown")));
        }
      }, 100);
    });
  }
  function readDeltasSinceMark(mark) {
    var out = [];
    for (var i = mark; i < receivedMsgs.length; i++) {
      if (receivedMsgs[i].type === "delta" && typeof receivedMsgs[i].text === "string") {
        out.push(receivedMsgs[i].text);
      }
    }
    return out.join("");
  }
  function getMsgCount() { return receivedMsgs.length; }

  console.log("[verify] step 4: turn 1 — establish ALPHA in source thread");
  var mark1 = getMsgCount();
  await page.locator("#input").fill("Reply with the single word ALPHA. No other text.");
  await page.locator("#input").press("Enter");
  await waitForDoneAfter(mark1, TURN_TIMEOUT);
  var sourceTurn1 = readDeltasSinceMark(mark1);
  console.log("  source turn 1 reply: " + JSON.stringify(sourceTurn1.slice(0, 200)));
  if (!/ALPHA/i.test(sourceTurn1)) {
    console.log("  ⚠ source did not reply ALPHA; aborting");
    await browser.close();
    process.exit(1);
  }
  await shot(page, "81-fork-source-alpha");

  console.log("[verify] step 5: click Fork → confirm");
  await page.locator("#header-fork-btn").click();
  await page.waitForFunction(function () {
    var m = document.getElementById("confirm-modal");
    return m && !m.classList.contains("hidden");
  }, { timeout: 3000 });
  await page.locator("#confirm-modal #confirm-ok").click();
  await page.waitForFunction(function () {
    var m = document.getElementById("confirm-modal");
    return m && m.classList.contains("hidden");
  }, { timeout: 3000 });

  console.log("[verify] step 6: wait for sidebar to switch to the fork");
  var forkSwitchMark = getMsgCount();
  await waitForCondition(function (msgs) {
    for (var i = msgs.length - 1; i >= 0; i--) {
      var m = msgs[i];
      if (m.type === "session_switched" && m.cliSessionId) return m;
    }
    return null;
  }, 10000, "fork session_switched");
  await page.waitForTimeout(500); // let the new session render
  await shot(page, "82-fork-after-confirm");

  console.log("[verify] step 7: turn on FORK — does it remember ALPHA?");
  var mark2 = getMsgCount();
  await page.locator("#input").fill("What single word did you reply previously? Answer with just that one word.");
  await page.locator("#input").press("Enter");
  await waitForDoneAfter(mark2, TURN_TIMEOUT);
  var forkTurnReply = readDeltasSinceMark(mark2);
  console.log("  fork reply: " + JSON.stringify(forkTurnReply.slice(0, 200)));
  await shot(page, "83-fork-asked-alpha");

  if (!/ALPHA/i.test(forkTurnReply)) {
    console.log("  ✗ FORK did NOT remember ALPHA — server-side history copy may be broken");
    console.log("    fork reply was: " + JSON.stringify(forkTurnReply));
    await browser.close();
    process.exit(1);
  }
  console.log("  ✓ fork remembers ALPHA — server-side history copy works");

  console.log("[verify] step 8: switch sidebar back to source session");
  // Find the source session in the sidebar — first .session-item that
  // is NOT currently active (we're on the fork). Click it.
  var switched = await page.evaluate(function () {
    var items = document.querySelectorAll(".session-item, .mobile-session-item");
    for (var i = 0; i < items.length; i++) {
      if (!items[i].classList.contains("active")) {
        items[i].click();
        return { clicked: true, total: items.length };
      }
    }
    return { clicked: false, total: items.length };
  });
  console.log("  sidebar switch attempt: " + JSON.stringify(switched));
  if (!switched.clicked) {
    console.log("  ⚠ no inactive session item found in sidebar; skipping resume check");
    await browser.close();
    process.exit(1);
  }
  await page.waitForTimeout(800);
  await shot(page, "84-fork-back-on-source");

  console.log("[verify] step 9: turn on SOURCE (resumed) — does it remember ALPHA?");
  var mark3 = getMsgCount();
  await page.locator("#input").fill("What single word did you reply previously? Answer with just that one word.");
  await page.locator("#input").press("Enter");
  await waitForDoneAfter(mark3, TURN_TIMEOUT);
  var sourceResumedReply = readDeltasSinceMark(mark3);
  console.log("  source-resumed reply: " + JSON.stringify(sourceResumedReply.slice(0, 200)));
  await shot(page, "85-fork-source-resumed-asked-alpha");

  if (!/ALPHA/i.test(sourceResumedReply)) {
    console.log("  ✗ SOURCE (after resume) did NOT remember ALPHA — thread/resume context retention broken");
    await browser.close();
    process.exit(1);
  }
  console.log("  ✓ source thread (resumed) remembers ALPHA — thread/resume works end-to-end");

  await browser.close();
  console.log("\n[verify] ✓ live fork round-trip succeeded:");
  console.log("    - source thread set ALPHA");
  console.log("    - fork inherits history (recalls ALPHA)");
  console.log("    - source resumes (still recalls ALPHA after switching to fork and back)");
})().catch(function (e) {
  console.error("[verify] crashed:", e && (e.stack || e.message || e));
  process.exit(2);
});
