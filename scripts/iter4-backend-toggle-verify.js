// Iter 4 verify — exercises the project-default-backend toggle UI end-to-end.
//
// Pre-req: `npm run dev:isolated` running on http://localhost:2637 with at
// least one project. The test uses the Claude Playground (or whatever
// project is reachable at /p/<slug>/) since iter 4 doesn't depend on which
// backend the project starts with.
//
// What's checked:
//   1. Project Settings panel opens and the "Backend" card renders with
//      both Claude / Codex buttons.
//   2. The currently-active button matches the project's defaultBackend
//      reported by the WS info frame.
//   3. Clicking the OTHER backend:
//        a. emits a `set_project_backend` frame on the wire,
//        b. server responds with `project_backend_changed`,
//        c. the active button flips to the new value,
//        d. daemon.json gets the projects[i].backend field updated.
//   4. Existing sessions in the sidebar receive the iter-4 backend badge
//      whenever their backend differs from the new project default.
//
// Run:
//   node scripts/iter4-backend-toggle-verify.js [--headless]
//
// Screenshots land in /tmp/clay-codex-test/screenshots/iter4-*.png

var path = require("path");
var fs = require("fs");
var { chromium } = require("playwright");

var URL_BASE = process.env.CLAY_URL || "http://localhost:2637";
var TESTHOME = process.env.TESTHOME || "/tmp/clay-codex-test";
var DAEMON_JSON = path.join(TESTHOME, ".clay", "daemon.json");
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
    var p = path.join(SHOTS_DIR, "iter4-" + name + ".png");
    await page.screenshot({ path: p, fullPage: true });
    console.log("  📸 " + p);
  } catch (e) {
    console.log("  (screenshot failed: " + e.message + ")");
  }
}

function readDaemonJson() {
  try { return JSON.parse(fs.readFileSync(DAEMON_JSON, "utf8")); }
  catch (e) { return null; }
}

(async function main() {
  console.log("[iter4] launching chromium (headless=" + HEADLESS + ")");
  var browser = await chromium.launch({ headless: HEADLESS });
  var ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });

  // Capture WS frames in both directions. We grep `set_project_backend` on
  // the way out and `project_backend_changed` on the way in.
  var sentFrames = [];
  var recvFrames = [];
  ctx.on("page", function (newPage) {
    newPage.on("websocket", function (ws) {
      ws.on("framesent", function (f) {
        if (typeof f.payload === "string") sentFrames.push(f.payload);
      });
      ws.on("framereceived", function (f) {
        if (typeof f.payload === "string") recvFrames.push(f.payload);
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

  // ── Step 1: open the app and land on a project ────────────────────────
  console.log("[iter4] step 1: open " + URL_BASE);
  await page.goto(URL_BASE + "/?nosw=" + Date.now(), { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/p\/[^\/]+\/?$/, { timeout: 15000 });
  console.log("  → on " + page.url());
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(function () {});

  // ── Step 2: capture the project's current defaultBackend from info ────
  console.log("[iter4] step 2: read defaultBackend from WS info frame");
  // Wait for the FIRST info frame to arrive so we have a baseline.
  var deadline = Date.now() + 5000;
  var infoMsg = null;
  while (Date.now() < deadline && !infoMsg) {
    for (var i = 0; i < recvFrames.length; i++) {
      try {
        var m = JSON.parse(recvFrames[i]);
        if (m.type === "info") { infoMsg = m; break; }
      } catch (e) {}
    }
    if (!infoMsg) await page.waitForTimeout(100);
  }
  check(!!infoMsg, "info frame received from daemon");
  if (!infoMsg) { failures.push("no info frame — aborting"); finish(); return; }
  var startingDefault = infoMsg.defaultBackend || infoMsg.backend || "claude";
  var startingActive = infoMsg.backend || startingDefault;
  console.log("  starting defaultBackend = " + startingDefault + ", active session backend = " + startingActive);
  check(typeof infoMsg.defaultBackend !== "undefined",
    "info carries defaultBackend (iter 3 protocol split)");

  // ── Step 3: open Project Settings → Defaults ─────────────────────────
  console.log("[iter4] step 3: open Project Settings → Defaults");
  // The settings panel is opened by clicking a gear in the topbar; the
  // exact selector varies, but the panel itself is reliable. We unhide it
  // directly and synthesize the same setup the click would do.
  await page.evaluate(function () {
    var panel = document.getElementById("project-settings");
    if (panel) panel.classList.remove("hidden");
    // Activate the "defaults" section so populateDefaults() runs.
    var navItems = panel.querySelectorAll(".settings-nav-item");
    for (var i = 0; i < navItems.length; i++) {
      if (navItems[i].dataset.section === "defaults") {
        navItems[i].click();
        break;
      }
    }
  });
  // Wait for the backend card to render.
  await page.waitForSelector("#ps-backend-bar .ps-backend-btn", { timeout: 5000 });

  // ── Step 4: assert backend card shape + active button matches default ─
  console.log("[iter4] step 4: assert backend card matches defaultBackend");
  var btnCount = await page.locator("#ps-backend-bar .ps-backend-btn").count();
  check(btnCount === 2, "two backend buttons in the toggle (got " + btnCount + ")");

  var activeData = await page.evaluate(function () {
    var bar = document.getElementById("ps-backend-bar");
    if (!bar) return null;
    var act = bar.querySelector(".ps-backend-btn.active");
    return act ? act.dataset.value : null;
  });
  check(activeData === startingDefault,
    "active button = '" + activeData + "' matches defaultBackend '" + startingDefault + "'");
  await shot(page, "01-settings-open");

  // ── Step 5: click the OTHER backend ──────────────────────────────────
  var targetBackend = startingDefault === "codex" ? "claude" : "codex";
  console.log("[iter4] step 5: click " + targetBackend + " button (flip from " + startingDefault + ")");
  sentFrames.length = 0; // reset capture window
  recvFrames.length = 0;
  await page.locator('#ps-backend-bar .ps-backend-btn[data-value="' + targetBackend + '"]').click();

  // ── Step 6: wait for project_backend_changed reply ───────────────────
  console.log("[iter4] step 6: wait for project_backend_changed reply");
  var changedMsg = null;
  var deadline6 = Date.now() + 5000;
  while (Date.now() < deadline6 && !changedMsg) {
    for (var k = 0; k < recvFrames.length; k++) {
      try {
        var rm = JSON.parse(recvFrames[k]);
        if (rm.type === "project_backend_changed") { changedMsg = rm; break; }
      } catch (e) {}
    }
    if (!changedMsg) await page.waitForTimeout(100);
  }
  check(!!changedMsg, "server emitted project_backend_changed frame");
  if (changedMsg) {
    check(changedMsg.defaultBackend === targetBackend,
      "frame's defaultBackend = '" + (changedMsg && changedMsg.defaultBackend) + "' matches target '" + targetBackend + "'");
  }

  // ── Step 7: verify outgoing set_project_backend was sent ─────────────
  var sawSet = sentFrames.some(function (f) {
    try {
      var m = JSON.parse(f);
      return m.type === "set_project_backend" && m.backend === targetBackend;
    } catch (e) { return false; }
  });
  check(sawSet, "client sent set_project_backend { backend: '" + targetBackend + "' }");

  // ── Step 8: button state reflects the flip ───────────────────────────
  console.log("[iter4] step 8: assert active button flipped");
  await page.waitForTimeout(150); // let the optimistic + confirm passes settle
  var newActive = await page.evaluate(function () {
    var bar = document.getElementById("ps-backend-bar");
    if (!bar) return null;
    var act = bar.querySelector(".ps-backend-btn.active");
    return act ? act.dataset.value : null;
  });
  check(newActive === targetBackend,
    "active button is now '" + newActive + "' (target '" + targetBackend + "')");
  await shot(page, "02-after-flip");

  // ── Step 9: persistence — daemon.json reflects the new backend ───────
  console.log("[iter4] step 9: assert daemon.json was persisted");
  // The slug we're operating on lives in the URL.
  var slugMatch = page.url().match(/\/p\/([^\/]+)\/?$/);
  var activeSlug = slugMatch ? slugMatch[1] : null;
  check(!!activeSlug, "could parse slug from URL");
  var dj = readDaemonJson();
  check(dj && Array.isArray(dj.projects), "daemon.json readable with projects[]");
  if (dj && activeSlug) {
    var entry = dj.projects.find(function (p) { return p.slug === activeSlug; });
    check(!!entry, "daemon.json has an entry for slug '" + activeSlug + "'");
    if (entry) {
      check(entry.backend === targetBackend,
        "daemon.json projects['" + activeSlug + "'].backend = '" + entry.backend + "' (target '" + targetBackend + "')");
    }
  }

  // ── Step 10: sidebar badge — sessions whose backend != new default ──
  console.log("[iter4] step 10: assert sidebar badge appears on diverging sessions");
  // After the flip, server re-broadcasts session_list so the sidebar
  // reapplies the badge rule (session.backend !== defaultBackend). Give
  // the WS round-trip a moment, then enumerate.
  await page.waitForTimeout(500);
  // Debug: dump every session_list frame seen since the flip so we can
  // distinguish "session.backend missing on the wire" from "frontend
  // didn't re-render" from "ordering bug". Helpful when this test fails.
  var lists = recvFrames.filter(function (f) {
    try { return JSON.parse(f).type === "session_list"; } catch (e) { return false; }
  });
  console.log("  session_list frames seen since reset: " + lists.length);
  if (lists.length > 0) {
    var lastList = JSON.parse(lists[lists.length - 1]);
    console.log("  last session_list payload: " + JSON.stringify(lastList.sessions));
  }
  // Also dump the frontend's view of currentDefaultBackend.
  var feDefault = await page.evaluate(function () {
    // ctx is the closure of app.js's exposed module-init shape; we
    // installed a getter currentDefaultBackend in iter 4. The settings
    // module reads ctx.currentDefaultBackend, but ctx itself isn't
    // globally exposed — peek body.classList instead, plus the bar's
    // active button which IS authoritative.
    var bar = document.getElementById("ps-backend-bar");
    var act = bar && bar.querySelector(".ps-backend-btn.active");
    return {
      bodyHasCodex: !!document.body && document.body.classList.contains("backend-codex"),
      activeToggle: act ? act.dataset.value : null,
    };
  });
  console.log("  frontend state: " + JSON.stringify(feDefault));
  var badgeReport = await page.evaluate(function () {
    var items = document.querySelectorAll(".session-item");
    var report = [];
    for (var i = 0; i < items.length; i++) {
      var b = items[i].querySelector(".session-backend-badge");
      report.push({
        sid: items[i].dataset.sessionId,
        badgeText: b ? b.textContent.trim() : null,
        badgeBackend: b ? b.dataset.backend : null,
      });
    }
    return report;
  });
  console.log("  sessions: " + JSON.stringify(badgeReport));

  // Cross-check against startingActive: the active session's backend was
  // captured at step 2. After the flip its backend (frozen, iter 1) should
  // differ from targetBackend, so we expect EXACTLY one badge for it.
  if (startingActive !== targetBackend) {
    var badgedCount = badgeReport.filter(function (r) { return !!r.badgeBackend; }).length;
    check(badgedCount >= 1,
      "at least one session badged after flip (got " + badgedCount + ", starting active was '" + startingActive + "')");
    // And every badge that exists must match starting backend (= the frozen
    // identity), not the new project default.
    for (var bi = 0; bi < badgeReport.length; bi++) {
      var br = badgeReport[bi];
      if (br.badgeBackend) {
        check(br.badgeBackend === startingActive,
          "session " + br.sid + " badge '" + br.badgeBackend + "' equals frozen original '" + startingActive + "'");
        check(br.badgeBackend !== targetBackend,
          "session " + br.sid + " badge does NOT equal new default '" + targetBackend + "'");
      }
    }
  } else {
    console.log("  (active session backend already matches target — no badge expected)");
  }
  await shot(page, "03-sidebar-after-flip");

  // ── Step 11: flip BACK so we leave daemon.json in a known state ──────
  console.log("[iter4] step 11: flip back to '" + startingDefault + "' (cleanup)");
  await page.locator('#ps-backend-bar .ps-backend-btn[data-value="' + startingDefault + '"]').click();
  await page.waitForTimeout(300);
  var dj2 = readDaemonJson();
  if (dj2 && activeSlug) {
    var entry2 = dj2.projects.find(function (p) { return p.slug === activeSlug; });
    if (entry2) {
      check(entry2.backend === startingDefault,
        "daemon.json restored to starting default '" + startingDefault + "'");
    }
  }

  finish();

  function finish() {
    console.log("");
    if (failures.length === 0) {
      console.log("[iter4] ✅ ALL CHECKS PASSED");
    } else {
      console.log("[iter4] ❌ " + failures.length + " FAILURE(S):");
      for (var f = 0; f < failures.length; f++) console.log("  - " + failures[f]);
    }
    browser.close().then(function () {
      process.exit(failures.length === 0 ? 0 : 1);
    });
  }
})().catch(function (err) {
  console.error("[iter4] FATAL: " + (err && err.stack || err));
  process.exit(2);
});
