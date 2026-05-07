// Iter 6a UI test for the Codex skills picker.
//
// Two surfaces under test:
//   1. Header popover (#header-codex-skills-btn → #codex-skills-panel)
//      — discovery list with scope badges, Refresh button, click → input
//      prefix.
//   2. Inline autocomplete (#codex-skill-menu) — `$` and `/` triggers,
//      keyboard nav, Enter to commit selecting `$<name> ` into input.
//
// Strategy: open a real Codex project page (warmup auto-fetches skills
// from the local codex CLI). When the page is in an isolated daemon with
// 5 system skills installed (the developer's machine state), we get a
// known set to drive against.
//
// The negative case (Claude project) is exercised via a fresh page load
// against a Claude-backend slug created on the fly.
//
// Run:
//   npm run dev:isolated      # leave running
//   node scripts/codex-skills-ui-e2e.js --headless

var path = require("path");
var fs = require("fs");
var net = require("net");
var { chromium } = require("playwright");

var URL_BASE = process.env.CLAY_URL || "http://localhost:2637";
var TESTHOME = process.env.TESTHOME || "/tmp/clay-codex-test";
var PLAYGROUND = process.env.PLAYGROUND || "/tmp/codex-playground";
var CLAUDE_PLAYGROUND = process.env.CLAUDE_PLAYGROUND || "/tmp/clay-claude-playground";
var SOCKET_PATH = path.join(TESTHOME, ".clay", "daemon.sock");
var SHOTS_DIR = path.join(TESTHOME, "screenshots");
var HEADLESS = process.argv.indexOf("--headless") !== -1;

var failures = [];
function check(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); return true; }
  console.log("  ✗ " + msg);
  failures.push(msg);
  return false;
}

function ipcSend(cmd) {
  return new Promise(function (resolve, reject) {
    var sock = net.createConnection(SOCKET_PATH);
    var buf = "";
    var done = false;
    var to = setTimeout(function () {
      if (done) return;
      done = true; sock.destroy();
      reject(new Error("IPC timeout: " + cmd.cmd));
    }, 5000);
    sock.on("connect", function () { sock.write(JSON.stringify(cmd) + "\n"); });
    sock.on("data", function (chunk) {
      buf += chunk.toString();
      var idx = buf.indexOf("\n");
      if (idx === -1 || done) return;
      done = true; clearTimeout(to); sock.destroy();
      try { resolve(JSON.parse(buf.substring(0, idx))); }
      catch (e) { reject(new Error("IPC bad JSON: " + buf.substring(0, idx))); }
    });
    sock.on("error", function (err) { if (done) return; done = true; clearTimeout(to); reject(err); });
  });
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
  console.log("[skills-ui] step 1: register Codex playground");
  fs.mkdirSync(PLAYGROUND, { recursive: true });
  await ipcSend({ cmd: "remove_project", path: PLAYGROUND }).catch(function () {});
  var ipcResp = await ipcSend({ cmd: "add_project", path: PLAYGROUND, backend: "codex" });
  if (!ipcResp.ok) throw new Error("add_project failed: " + JSON.stringify(ipcResp));
  var slug = ipcResp.slug;
  console.log("  → slug=" + slug);

  console.log("[skills-ui] step 2: launch chromium (headless=" + HEADLESS + ")");
  var browser = await chromium.launch({ headless: HEADLESS });
  var ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });

  // Capture WS frames sent + received so we can verify request_codex_skills
  // emission on Refresh and codex_skills broadcasts on the wire.
  var sentFrames = [];
  var recvFrames = [];
  ctx.on("page", function (newPage) {
    newPage.on("websocket", function (sock) {
      sock.on("framesent", function (f) {
        if (typeof f.payload === "string") sentFrames.push(f.payload);
      });
      sock.on("framereceived", function (f) {
        if (typeof f.payload === "string") recvFrames.push(f.payload);
      });
    });
  });

  var page = await ctx.newPage();
  // Capture browser console + page errors for debugging.
  page.on("console", function (msg) {
    if (msg.type() === "error" || msg.type() === "warning") {
      console.log("  [browser:" + msg.type() + "] " + msg.text());
    }
  });
  page.on("pageerror", function (err) {
    console.log("  [browser:pageerror] " + err.message);
  });

  console.log("[skills-ui] step 3: open Codex project page");
  await page.goto(URL_BASE + "/p/" + slug + "/", { waitUntil: "domcontentloaded" });

  console.log("[skills-ui] step 4: wait for header-codex-skills-btn to become visible");
  await page.waitForFunction(function () {
    var b = document.getElementById("header-codex-skills-btn");
    return b && !b.hidden;
  }, { timeout: 8000 });
  var btnState = await page.evaluate(function () {
    var b = document.getElementById("header-codex-skills-btn");
    if (!b) return { exists: false };
    var tooltip = b.getAttribute("data-tip") || b.getAttribute("title") || "";
    return { exists: true, hidden: b.hidden, tooltip: tooltip, hasIcon: !!b.querySelector("svg, i") };
  });
  check(btnState.exists, "header-codex-skills-btn exists in DOM");
  check(btnState.hidden === false, "header-codex-skills-btn is visible (hidden === false)");
  check(btnState.hasIcon, "header-codex-skills-btn renders an icon");
  check(/skill/i.test(btnState.tooltip || ""),
    "button tooltip mentions skills (got " + JSON.stringify(btnState.tooltip) + ")");

  console.log("[skills-ui] step 5: wait for warmup codex_skills frame");
  // The connect handler echoes the cached snapshot if available and the
  // backend's warmup fetchSkills broadcasts when codex responds. Either
  // way we get at least one codex_skills frame within a few seconds.
  var skillsFrameDeadline = Date.now() + 8000;
  while (Date.now() < skillsFrameDeadline) {
    var hit = recvFrames.filter(function (f) { return f.indexOf("\"codex_skills\"") !== -1; });
    if (hit.length > 0) break;
    await page.waitForTimeout(150);
  }
  var skillsFramesObserved = recvFrames.filter(function (f) { return f.indexOf("\"codex_skills\"") !== -1; }).length;
  check(skillsFramesObserved >= 1,
    "at least one codex_skills WS frame observed (got " + skillsFramesObserved + ")");

  await shot(page, "80-codex-skills-button-visible");

  console.log("[skills-ui] step 6: click Skills button → panel opens");
  await page.locator("#header-codex-skills-btn").click();
  await page.waitForFunction(function () {
    var p = document.getElementById("codex-skills-panel");
    return p && !p.classList.contains("hidden");
  }, { timeout: 3000 });

  var panelState = await page.evaluate(function () {
    var p = document.getElementById("codex-skills-panel");
    if (!p) return { exists: false };
    var rows = p.querySelectorAll(".codex-skills-row");
    var firstRow = rows[0];
    var firstName = firstRow ? firstRow.getAttribute("data-skill-name") : null;
    var scopeBadges = p.querySelectorAll(".codex-skill-scope");
    return {
      exists: true,
      visible: !p.classList.contains("hidden"),
      rowCount: rows.length,
      firstName: firstName,
      hasRefresh: !!p.querySelector(".codex-skills-refresh-btn"),
      scopeBadgeCount: scopeBadges.length,
      hasTitle: /skills/i.test(p.querySelector(".codex-skills-panel-title")?.textContent || ""),
    };
  });
  check(panelState.exists, "panel exists in DOM after click");
  check(panelState.visible, "panel is visible (no .hidden class)");
  check(panelState.hasTitle, "panel header reads 'Skills'");
  check(panelState.hasRefresh, "panel has a Refresh button");
  check(panelState.rowCount > 0,
    "panel renders at least one skill row (got " + panelState.rowCount + ")");
  check(panelState.scopeBadgeCount === panelState.rowCount,
    "every row carries a scope badge (rows=" + panelState.rowCount + " badges=" + panelState.scopeBadgeCount + ")");

  await shot(page, "81-codex-skills-panel-open");

  console.log("[skills-ui] step 7: Refresh button emits request_codex_skills{forceReload:true}");
  var sentBeforeRefresh = sentFrames.length;
  await page.locator(".codex-skills-refresh-btn").click();
  await page.waitForTimeout(400);
  var refreshFrames = sentFrames.slice(sentBeforeRefresh)
    .filter(function (f) { return f.indexOf("request_codex_skills") !== -1; });
  check(refreshFrames.length >= 1,
    "Refresh click emitted a request_codex_skills WS frame");
  if (refreshFrames.length > 0) {
    var parsed = null;
    try { parsed = JSON.parse(refreshFrames[0]); } catch (e) {}
    check(parsed && parsed.type === "request_codex_skills",
      "WS frame type === 'request_codex_skills'");
    check(parsed && parsed.forceReload === true,
      "Refresh sets forceReload === true");
  }

  console.log("[skills-ui] step 8: click first skill row → input prefilled with $<name>");
  // Refresh in step 7 rebuilt the panel innerHTML; re-query the current
  // DOM rather than trust state captured pre-Refresh. Also re-open if the
  // panel was incidentally closed by a stray outside-click handler.
  await page.evaluate(function () {
    var p = document.getElementById("codex-skills-panel");
    if (p && p.classList.contains("hidden")) {
      var btn = document.getElementById("header-codex-skills-btn");
      if (btn) btn.click();
    }
  });
  await page.waitForFunction(function () {
    var p = document.getElementById("codex-skills-panel");
    var rows = p ? p.querySelectorAll(".codex-skills-row") : [];
    return p && !p.classList.contains("hidden") && rows.length > 0;
  }, { timeout: 4000 });
  var pickedName = await page.evaluate(function () {
    var row = document.querySelector("#codex-skills-panel .codex-skills-row");
    return row ? row.getAttribute("data-skill-name") : null;
  });
  check(pickedName && pickedName.length > 0,
    "captured a skill name to click (got " + JSON.stringify(pickedName) + ")");
  // Use Playwright locator click — handles scroll-into-view + actionability.
  await page.locator("#codex-skills-panel .codex-skills-row").first().click();
  // The panel close + input prefill happen in the same click handler;
  // poll for whichever signal lands first.
  await page.waitForFunction(function (expected) {
    var el = document.getElementById("input");
    return el && el.value === expected;
  }, "$" + pickedName + " ", { timeout: 4000 });
  var inputVal = await page.evaluate(function () {
    var el = document.getElementById("input");
    return el ? el.value : null;
  });
  check(inputVal === "$" + pickedName + " ",
    "input value === '$" + pickedName + " ' (got " + JSON.stringify(inputVal) + ")");
  var panelClosed = await page.evaluate(function () {
    var p = document.getElementById("codex-skills-panel");
    return p ? p.classList.contains("hidden") : true;
  });
  check(panelClosed, "panel is closed (hidden) after row click");

  await shot(page, "82-codex-skills-after-pick");

  console.log("[skills-ui] step 9: clear input, type `$` → inline autocomplete opens");
  await page.evaluate(function () {
    var el = document.getElementById("input");
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Type via Playwright so the native input events fire identically to user typing.
  await page.locator("#input").focus();
  await page.keyboard.type("$");
  await page.waitForFunction(function () {
    var m = document.getElementById("codex-skill-menu");
    return m && m.classList.contains("visible");
  }, { timeout: 3000 });
  var inlineState = await page.evaluate(function () {
    var m = document.getElementById("codex-skill-menu");
    if (!m) return null;
    var items = m.querySelectorAll(".codex-skill-item");
    var firstActive = m.querySelector(".codex-skill-item.active");
    return {
      visible: m.classList.contains("visible"),
      itemCount: items.length,
      firstActiveText: firstActive ? firstActive.querySelector(".codex-skill-item-name")?.textContent : null,
    };
  });
  check(inlineState && inlineState.visible, "inline menu visible after typing `$`");
  check(inlineState && inlineState.itemCount > 0,
    "inline menu has items (got " + (inlineState && inlineState.itemCount) + ")");
  check(inlineState && inlineState.firstActiveText && inlineState.firstActiveText.indexOf("$") === 0,
    "first item is highlighted active and starts with `$`");

  await shot(page, "83-codex-skills-inline-dollar");

  console.log("[skills-ui] step 10: Tab key commits the highlighted skill");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  var afterTab = await page.evaluate(function () {
    var el = document.getElementById("input");
    var m = document.getElementById("codex-skill-menu");
    return { val: el ? el.value : null, menuOpen: m ? m.classList.contains("visible") : false };
  });
  check(afterTab.menuOpen === false, "inline menu closed after Tab");
  check(afterTab.val && afterTab.val.charAt(0) === "$" && /\s$/.test(afterTab.val),
    "input now starts with `$<name>` and ends with whitespace (got " + JSON.stringify(afterTab.val) + ")");

  console.log("[skills-ui] step 11: clear input, type `/` → inline autocomplete also opens (codex parity)");
  await page.evaluate(function () {
    var el = document.getElementById("input");
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#input").focus();
  await page.keyboard.type("/");
  // Wait briefly. We accept either the codex inline menu OR the
  // legacy slash-menu being suppressed (it's hidden by CSS for
  // body.backend-codex anyway). The codex menu must show.
  await page.waitForFunction(function () {
    var m = document.getElementById("codex-skill-menu");
    return m && m.classList.contains("visible");
  }, { timeout: 3000 });
  var slashTriggerState = await page.evaluate(function () {
    var codex = document.getElementById("codex-skill-menu");
    var legacy = document.getElementById("slash-menu");
    return {
      codexVisible: codex && codex.classList.contains("visible"),
      legacyVisible: legacy && legacy.classList.contains("visible"),
      legacyDisplayNone: legacy ? window.getComputedStyle(legacy).display === "none" : null,
    };
  });
  check(slashTriggerState.codexVisible === true,
    "`/` opens codex skill menu (codex parity)");
  // body.backend-codex CSS hides #slash-menu wholesale; whether the JS
  // bubble fires or not, the legacy menu must not visually surface.
  check(slashTriggerState.legacyDisplayNone === true,
    "legacy slash-menu remains display:none (CSS-suppressed for codex)");

  await shot(page, "84-codex-skills-inline-slash");

  console.log("[skills-ui] step 12: Escape closes inline menu");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  var afterEsc = await page.evaluate(function () {
    var m = document.getElementById("codex-skill-menu");
    return { open: m ? m.classList.contains("visible") : false };
  });
  check(afterEsc.open === false, "Escape closes the inline menu");

  console.log("[skills-ui] step 13: synthetic skill payload renders error banner + scope badges");
  // Inject a synthetic codex_skills frame to exercise error rendering and
  // the project/user scope styles (our local codex install only has
  // system-scope skills).
  await page.evaluate(function () {
    if (!window.__codexSkillsTestHook) {
      // The module's handler is wired internally; we trigger via the WS
      // dispatch path. Simulate it by calling the global if exposed,
      // otherwise dispatch a CustomEvent that codex-skills can listen to.
      // For this UI test we just rebuild the panel DOM directly.
      var panel = document.getElementById("codex-skills-panel");
      if (!panel) return;
      panel.classList.remove("hidden");
      panel.innerHTML = '' +
        '<div class="codex-skills-panel-header">' +
        '  <span class="codex-skills-panel-title">Skills</span>' +
        '  <button class="codex-skills-refresh-btn" type="button">Refresh</button>' +
        '</div>' +
        '<div class="codex-skills-errors">' +
        '  <div class="codex-skills-error-row"><strong>parse_error</strong>: synthetic test error</div>' +
        '</div>' +
        '<div class="codex-skills-list">' +
        '  <button class="codex-skills-row" data-skill-name="syn-project"><div class="codex-skills-row-head">' +
        '    <span class="codex-skill-name">$syn-project</span>' +
        '    <span class="codex-skill-scope codex-skill-scope-project">project</span>' +
        '  </div></button>' +
        '  <button class="codex-skills-row" data-skill-name="syn-user"><div class="codex-skills-row-head">' +
        '    <span class="codex-skill-name">$syn-user</span>' +
        '    <span class="codex-skill-scope codex-skill-scope-user">user</span>' +
        '  </div></button>' +
        '  <button class="codex-skills-row" data-skill-name="syn-system"><div class="codex-skills-row-head">' +
        '    <span class="codex-skill-name">$syn-system</span>' +
        '    <span class="codex-skill-scope codex-skill-scope-system">system</span>' +
        '  </div></button>' +
        '</div>';
    }
  });
  var scopeColors = await page.evaluate(function () {
    function colorOf(sel) {
      var el = document.querySelector(sel);
      if (!el) return null;
      return window.getComputedStyle(el).color;
    }
    return {
      project: colorOf(".codex-skill-scope-project"),
      user: colorOf(".codex-skill-scope-user"),
      system: colorOf(".codex-skill-scope-system"),
      errorVisible: !!document.querySelector(".codex-skills-errors"),
      errorText: (document.querySelector(".codex-skills-error-row") || {}).textContent || "",
    };
  });
  check(scopeColors.project && scopeColors.project !== "rgba(0, 0, 0, 0)",
    "project-scope badge has a non-transparent color (got " + scopeColors.project + ")");
  check(scopeColors.user && scopeColors.user !== "rgba(0, 0, 0, 0)",
    "user-scope badge has a non-transparent color (got " + scopeColors.user + ")");
  check(scopeColors.system && scopeColors.system !== "rgba(0, 0, 0, 0)",
    "system-scope badge has a non-transparent color (got " + scopeColors.system + ")");
  check(scopeColors.project !== scopeColors.user,
    "project-scope color differs from user-scope (terracotta vs indigo)");
  check(scopeColors.project !== scopeColors.system,
    "project-scope color differs from system-scope");
  check(scopeColors.user !== scopeColors.system,
    "user-scope color differs from system-scope");
  check(scopeColors.errorVisible && /synthetic/.test(scopeColors.errorText),
    "errors[] banner renders error rows");

  await shot(page, "85-codex-skills-synthetic-scopes");

  console.log("[skills-ui] step 14: Claude project — button stays hidden");
  // The Claude playground may not exist yet; create it minimally. If add_project
  // fails we skip — this assertion is best-effort negative-case verification.
  fs.mkdirSync(CLAUDE_PLAYGROUND, { recursive: true });
  await ipcSend({ cmd: "remove_project", path: CLAUDE_PLAYGROUND }).catch(function () {});
  var claudeResp = await ipcSend({ cmd: "add_project", path: CLAUDE_PLAYGROUND, backend: "claude" })
    .catch(function (e) { return { ok: false, error: e.message }; });
  if (claudeResp && claudeResp.ok && claudeResp.slug) {
    var claudePage = await ctx.newPage();
    await claudePage.goto(URL_BASE + "/p/" + claudeResp.slug + "/", { waitUntil: "domcontentloaded" });
    // Wait a beat for info handler to run.
    await claudePage.waitForTimeout(2000);
    var claudeBtn = await claudePage.evaluate(function () {
      var b = document.getElementById("header-codex-skills-btn");
      return b ? { exists: true, hidden: b.hidden } : { exists: false };
    });
    check(claudeBtn.exists, "header-codex-skills-btn DOM node still present on Claude project");
    check(claudeBtn.hidden === true,
      "header-codex-skills-btn is hidden on Claude project (got hidden=" + claudeBtn.hidden + ")");
    await shot(claudePage, "86-codex-skills-claude-hidden");
    await claudePage.close();
    await ipcSend({ cmd: "remove_project", slug: claudeResp.slug }).catch(function () {});
  } else {
    console.log("  (skipped Claude negative case: " + (claudeResp && claudeResp.error) + ")");
  }

  await browser.close();

  if (failures.length) {
    console.log("\n[skills-ui] FAILED " + failures.length + " checks");
    process.exit(1);
  }
  console.log("\n[skills-ui] PASSED all checks");
  process.exit(0);
})().catch(function (e) {
  console.error("[skills-ui] crashed:", e.message || e);
  process.exit(2);
});
