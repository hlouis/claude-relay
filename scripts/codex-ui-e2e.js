// Playwright UI smoke test for the Codex backend integration.
//
// Drives a real Chromium against the isolated daemon (default localhost:2637)
// and exercises the New Project modal → backend selection → project creation →
// chat round-trip. Asserts each step and prints PASSED/FAILED at the end.
//
// Run after starting the isolated daemon:
//   npm run dev:isolated      # in another shell, leave running
//   node scripts/codex-ui-e2e.js
//
// Headful by default so you can watch. Pass --headless to hide the browser.
// Screenshots land in /tmp/clay-codex-test/screenshots/.

var path = require("path");
var fs = require("fs");
var { chromium } = require("playwright");

var URL_BASE = process.env.CLAY_URL || "http://localhost:2637";
var TESTHOME = process.env.TESTHOME || "/tmp/clay-codex-test";
var PLAYGROUND = "/tmp/codex-playground";
var SHOTS_DIR = path.join(TESTHOME, "screenshots");
var HEADLESS = process.argv.indexOf("--headless") !== -1;

var failures = [];
function check(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); return true; }
  console.log("  ✗ " + msg);
  failures.push(msg);
  return false;
}

async function shot(page, name) {
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    var p = path.join(SHOTS_DIR, name + ".png");
    await page.screenshot({ path: p, fullPage: true });
    console.log("  📸 " + p);
  } catch (e) {
    console.log("  (screenshot failed: " + e.message + ")");
  }
}

// Clean any session JSONL left behind for the playground path. Without this
// step, removing+re-adding the project loads stale sessions that were
// created under a previous backend choice — making subsequent UI assertions
// race against ghost messages from prior runs.
function wipePlaygroundSessions() {
  // Clay encodes a project's cwd by replacing "/" with "-" (see
  // lib/sessions.js); URL-encoding is NOT used. Match that scheme exactly
  // or the wipe silently no-ops.
  var encoded = PLAYGROUND.replace(/\//g, "-");
  var dir = path.join(TESTHOME, ".clay", "sessions", encoded);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

(async function main() {
  fs.mkdirSync(PLAYGROUND, { recursive: true });
  wipePlaygroundSessions();

  console.log("[ui] launching chromium (headless=" + HEADLESS + ")");
  var browser = await chromium.launch({ headless: HEADLESS });
  // serviceWorkers:"block" prevents Clay's offline SW from caching/interfering
  // on this run. Without it, /p/<slug>/ can serve a stale 503 from the SW.
  // viewport must be wide enough for the desktop layout — headless default
  // is 1280×720 which is fine, but be explicit so the textarea is visible.
  var ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });

  // Capture *all* WS frames in this context, before any page is opened.
  var sentFrames = [];
  ctx.on("page", function (newPage) {
    newPage.on("websocket", function (ws) {
      ws.on("framesent", function (f) {
        if (typeof f.payload === "string") sentFrames.push(f.payload);
      });
    });
  });

  var page = await ctx.newPage();
  page.on("console", function (m) {
    var t = m.type();
    if (t === "error" || t === "warning") {
      console.log("  [browser " + t + "] " + m.text());
    }
  });

  console.log("[ui] step 1: open " + URL_BASE);
  // Bypass any service-worker cache by adding a query string + reloading.
  await page.goto(URL_BASE + "/?nosw=" + Date.now(), { waitUntil: "domcontentloaded" });
  // Server redirects / → /p/<slug>/. Wait for the project URL.
  await page.waitForURL(/\/p\/[^\/]+\/?$/, { timeout: 15000 });
  console.log("  → on " + page.url());

  // SW is blocked at context level, so no need to unregister here.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(function () {});

  console.log("[ui] step 2: open Add Project modal");
  // The button isn't always visible at the same selector across viewports;
  // we rely on the modal opener function exposed by the app.
  await page.evaluate(function () {
    var modal = document.getElementById("add-project-modal");
    if (modal) modal.classList.remove("hidden");
  });
  await page.waitForSelector("#add-project-modal:not(.hidden)", { timeout: 5000 });

  console.log("[ui] step 3: assert backend selector renders");
  var btnCount = await page.locator(".add-project-backend-btn").count();
  check(btnCount === 2, "two backend buttons present (got " + btnCount + ")");
  var codexDisabled = await page.locator('.add-project-backend-btn[data-backend="codex"]').isDisabled();
  check(!codexDisabled, "Codex backend button is enabled");
  await shot(page, "01-modal-open");

  console.log("[ui] step 4: click Codex backend");
  await page.locator('.add-project-backend-btn[data-backend="codex"]').click();
  var codexActive = await page.locator('.add-project-backend-btn[data-backend="codex"].active').count();
  check(codexActive === 1, "Codex button shows .active after click");

  console.log("[ui] step 5: enter playground path and submit");
  // Default mode is "existing"; populate the input. WS capture was wired
  // at context level above, so frames are already being collected.
  await page.locator("#add-project-input").fill(PLAYGROUND);
  await shot(page, "02-codex-selected");
  await page.locator("#add-project-ok").click();

  console.log("[ui] step 6: wait for the new project to register in DOM");
  // Poll the rendered project list until codex-playground shows up. The
  // sidebar updates via a WS broadcast from the daemon, which can take a
  // moment after add_project.
  var newProjEntry = null;
  var deadline6 = Date.now() + 10000;
  while (Date.now() < deadline6) {
    newProjEntry = await page.evaluate(function () {
      var items = document.querySelectorAll(".mobile-project-item");
      for (var i = 0; i < items.length; i++) {
        var n = items[i].querySelector(".mobile-project-name");
        if (n && n.textContent.indexOf("codex-playground") !== -1) {
          var badge = items[i].querySelector(".mobile-project-backend-badge");
          return { found: true, badgeText: badge ? badge.textContent.trim() : null };
        }
      }
      return { found: false };
    });
    if (newProjEntry.found) break;
    await page.waitForTimeout(250);
  }
  // Debug: dump the raw project payload last received from the daemon, to
  // pinpoint whether the backend field is missing on the wire or the
  // sidebar rendering simply skipped it.
  var debugDump = await page.evaluate(function () {
    var els = document.querySelectorAll(".mobile-project-item");
    var rows = [];
    for (var i = 0; i < els.length; i++) {
      var n = els[i].querySelector(".mobile-project-name");
      rows.push({
        text: n ? n.textContent : null,
        hasBadge: !!els[i].querySelector(".mobile-project-backend-badge"),
        innerHTML: els[i].innerHTML.slice(0, 300),
      });
    }
    return rows;
  });
  console.log("  debug rendered items: " + JSON.stringify(debugDump, null, 2));
  check(newProjEntry.found, "codex-playground entry rendered in project list");
  check(newProjEntry.badgeText === "Codex", "Codex outline badge text === 'Codex' (got " + JSON.stringify(newProjEntry.badgeText) + ")");
  await shot(page, "03-project-created");

  // Sanity: confirm the WS payload carried backend=codex.
  var matched = sentFrames.filter(function (p) {
    return p.indexOf('"add_project"') !== -1 || p.indexOf('"create_project"') !== -1;
  });
  console.log("  ws add/create payloads: " + JSON.stringify(matched));
  var anyCodex = matched.some(function (p) { return p.indexOf('"backend":"codex"') !== -1; });
  check(anyCodex, "WS add_project frame carried backend:codex");

  console.log("[ui] step 7: full-page nav to the new project (so the WS reconnects to its slug)");
  await page.goto(URL_BASE + "/p/codex-playground/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(function () {});
  // Wait until app.js has re-bound to the new slug.
  var deadlineSlug = Date.now() + 10000;
  while (Date.now() < deadlineSlug) {
    var ok = await page.evaluate(function () {
      var hdr = document.getElementById("title-bar-project-name");
      return !!hdr && hdr.textContent.indexOf("codex-playground") !== -1;
    });
    if (ok) break;
    await page.waitForTimeout(250);
  }

  console.log("[ui] step 8: poll for active WS to project page, then send via UI");
  // Wait for an `info` message tagged with codex-playground (the WS we're
  // really interested in). The page-level WS is not exposed on `window`
  // by app.js, so we observe the app-level state by waiting until the
  // project header swaps to the new slug.
  var deadlineSwap = Date.now() + 10000;
  while (Date.now() < deadlineSwap) {
    var swapped = await page.evaluate(function () {
      var hdr = document.getElementById("title-bar-project-name");
      return !!hdr && hdr.textContent.indexOf("codex-playground") !== -1;
    });
    if (swapped) break;
    await page.waitForTimeout(250);
  }
  // The composer is gated by app.js setting a class on #input-area when a
  // session is active. For headless testing we don't need to wait for that
  // CSS state — the underlying handler still works regardless. Force the
  // panel visible and proceed.
  await page.evaluate(function () {
    var area = document.getElementById("input-area");
    if (area) area.classList.remove("hidden");
  });
  var composer = page.locator("#input");
  await composer.waitFor({ state: "visible", timeout: 5000 });
  await composer.fill("Reply with just the single word HELLO and nothing else.");
  await composer.press("Enter");

  // Take only the LAST assistant bubble's text so we don't get false
  // positives from the user prompt (which itself contains the word HELLO)
  // or from any leftover content in the page. We identify "user vs
  // assistant" by Clay's bubble container — user messages are aligned
  // right inside .user-message-row containers; assistants live in the
  // main message-flow without that wrapper.
  console.log("[ui] step 9: poll for the latest assistant message");
  var deadline = Date.now() + 90000;
  var lastAssistant = "";
  var sawAuthCard = false;
  while (Date.now() < deadline) {
    var snap = await page.evaluate(function () {
      // The auth-required card is a strong negative signal — if it shows up
      // for THIS turn, routing went to Claude.
      var authCard = document.querySelector('[class*="auth-required"], [class*="not-logged-in"]');
      var authCardVisible = !!(authCard && authCard.offsetParent !== null);
      // Heuristic: the assistant-only message text Clay puts in
      // .message-flow leaves user prompts inside a right-aligned bubble
      // with class .user-message-row. The plain-text reply lives directly
      // in a .message-assistant container or as un-bubbled text under
      // .message-flow. Walk children of .message-flow and skip user rows.
      var flow = document.getElementById("messages") || document.querySelector(".message-flow");
      var rows = flow ? flow.children : [];
      var lastTxt = "";
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var cls = r.className || "";
        if (/user-message|user-bubble|user-row/i.test(cls)) continue;
        // Skip the orange "Claude Code is not logged in" card too.
        if (/auth-required|not-logged-in|login-card/i.test(cls)) continue;
        var t = (r.innerText || "").trim();
        if (t) lastTxt = t;
      }
      return { lastAssistant: lastTxt, authCardVisible: authCardVisible };
    });
    lastAssistant = snap.lastAssistant;
    if (snap.authCardVisible) sawAuthCard = true;
    if (/^HELLO$|^HELLO[\s.!]/i.test(lastAssistant)) break;
    await page.waitForTimeout(500);
  }
  await shot(page, "04-assistant-replied");

  check(!sawAuthCard, "no Claude auth-required card appeared during the turn");
  check(/HELLO/i.test(lastAssistant), "last assistant message contains 'HELLO' (got " + JSON.stringify(lastAssistant.slice(0, 200)) + ")");

  console.log("[ui] step 10: assert topbar Codex chip is visible with the model name");
  var chipState = await page.evaluate(function () {
    var chip = document.getElementById("header-backend-chip");
    if (!chip) return { present: false };
    return {
      present: true,
      hidden: chip.classList.contains("hidden"),
      text: (chip.textContent || "").trim(),
    };
  });
  check(chipState.present, "#header-backend-chip element exists in DOM");
  check(!chipState.hidden, "#header-backend-chip is not .hidden on a Codex project");
  check(/Codex/.test(chipState.text), "chip text starts with 'Codex' (got " + JSON.stringify(chipState.text) + ")");
  check(/gpt|codex|o\d|model/i.test(chipState.text), "chip text includes a model identifier (got " + JSON.stringify(chipState.text) + ")");

  await browser.close();

  if (failures.length) {
    console.log("\n[ui] FAILED " + failures.length + " checks");
    process.exit(1);
  }
  console.log("\n[ui] PASSED all checks");
  process.exit(0);
})().catch(function (e) {
  console.error("[ui] crashed:", e && (e.stack || e.message || e));
  process.exit(2);
});
