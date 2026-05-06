// Playwright UI test for iter-3 step 1: backend-specific UI hiding.
//
// Strategy mirrors codex-approval-ui-e2e.js — load Clay's static assets so
// css/codex.css is parsed, then synthesize the target elements in the page
// and toggle `body.backend-codex` to verify the rule fires.
//
// Why synthesize instead of navigating to a real project? The hide-via-class
// contract is purely CSS — we just need to prove that `body.backend-codex`
// flips display on each affordance. Spinning up a real Codex project here
// would re-test the WS plumbing covered by codex-e2e.js.

var path = require("path");
var fs = require("fs");
var { chromium } = require("playwright");

var URL_BASE = process.env.CLAY_URL || "http://localhost:2637";
var TESTHOME = process.env.TESTHOME || "/tmp/clay-codex-test";
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
  } catch (e) { console.log("  (screenshot failed: " + e.message + ")"); }
}

(async function main() {
  console.log("[hide-ui] launching chromium (headless=" + HEADLESS + ")");
  var browser = await chromium.launch({ headless: HEADLESS });
  var ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });
  var page = await ctx.newPage();

  console.log("[hide-ui] step 1: open dashboard so style.css + codex.css load");
  await page.goto(URL_BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#mobile-project-list, #app", { timeout: 8000 });

  console.log("[hide-ui] step 2: synthesize hide-target elements");
  await page.evaluate(function () {
    // Wipe any existing nodes with these IDs first to avoid colliding with
    // dashboard-side elements (the dashboard page does not host these, but
    // be defensive).
    var ids = ["skills-btn", "new-ralph-btn", "slash-menu"];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.parentNode && el.parentNode.removeChild(el);
    }

    var el = function (tag, id, cls) {
      var n = document.createElement(tag);
      if (id) n.id = id;
      if (cls) n.className = cls;
      n.textContent = id || cls || "";
      // Make sure each node is intrinsically visible without our rule.
      n.style.background = "#444";
      n.style.color = "#fff";
      n.style.padding = "4px";
      document.body.appendChild(n);
      return n;
    };
    window.__skillsBtn = el("button", "skills-btn", null);
    window.__ralphBtn = el("button", "new-ralph-btn", null);
    window.__slashMenu = el("div", "slash-menu", null);
    window.__rewindBtn = el("button", null, "msg-user-rewind-btn");
  });

  console.log("[hide-ui] step 3: assert defaults visible (Claude project)");
  var visClaude = await page.evaluate(function () {
    var vis = function (n) { return n ? window.getComputedStyle(n).display : "missing"; };
    return {
      skills: vis(window.__skillsBtn),
      ralph: vis(window.__ralphBtn),
      slash: vis(window.__slashMenu),
      rewind: vis(window.__rewindBtn),
      bodyClass: document.body.className,
    };
  });
  check(visClaude.skills !== "none", "Skills button visible without backend-codex (got " + visClaude.skills + ")");
  check(visClaude.ralph !== "none", "Ralph Loop button visible without backend-codex");
  // slash-menu has its own pre-existing CSS that hides it until the user types
  // `/`; we only need to verify our rule additionally applies under codex.
  check(visClaude.rewind !== "none", "Rewind button visible without backend-codex");

  await shot(page, "30-hide-ui-default");

  console.log("[hide-ui] step 4: toggle body.backend-codex and assert all hidden");
  var visCodex = await page.evaluate(function () {
    document.body.classList.add("backend-codex");
    var vis = function (n) { return n ? window.getComputedStyle(n).display : "missing"; };
    return {
      skills: vis(window.__skillsBtn),
      ralph: vis(window.__ralphBtn),
      slash: vis(window.__slashMenu),
      rewind: vis(window.__rewindBtn),
    };
  });
  check(visCodex.skills === "none", "Skills button hidden under backend-codex (got " + visCodex.skills + ")");
  check(visCodex.ralph === "none", "Ralph Loop button hidden under backend-codex");
  check(visCodex.slash === "none", "slash-menu hidden under backend-codex");
  check(visCodex.rewind === "none", "Rewind button hidden under backend-codex");

  await shot(page, "31-hide-ui-codex");

  console.log("[hide-ui] step 5: toggle off and assert visibility restored");
  var visBack = await page.evaluate(function () {
    document.body.classList.remove("backend-codex");
    var vis = function (n) { return n ? window.getComputedStyle(n).display : "missing"; };
    return {
      skills: vis(window.__skillsBtn),
      ralph: vis(window.__ralphBtn),
    };
  });
  check(visBack.skills !== "none", "Skills button reappears after removing backend-codex");
  check(visBack.ralph !== "none", "Ralph Loop button reappears after removing backend-codex");

  console.log("[hide-ui] step 6: defaults block dispatch (Claude vs Codex)");
  var defaults = await page.evaluate(function () {
    // Synthesize the two defaults wrappers using the same class names as
    // index.html. We don't rely on the real settings panel being open —
    // CSS selectors target `.ps-defaults-claude` / `.ps-defaults-codex`
    // anywhere in the DOM.
    var claudeWrap = document.createElement("div");
    claudeWrap.className = "ps-defaults-claude";
    claudeWrap.textContent = "claude defaults";
    document.body.appendChild(claudeWrap);

    var codexWrap = document.createElement("div");
    codexWrap.className = "ps-defaults-codex";
    codexWrap.textContent = "codex defaults";
    document.body.appendChild(codexWrap);

    var vis = function (n) { return window.getComputedStyle(n).display; };

    document.body.classList.remove("backend-codex");
    var defaultClaude = vis(claudeWrap);
    var defaultCodex = vis(codexWrap);

    document.body.classList.add("backend-codex");
    var codexClaude = vis(claudeWrap);
    var codexCodex = vis(codexWrap);

    document.body.classList.remove("backend-codex");
    return {
      defaultClaude: defaultClaude,
      defaultCodex: defaultCodex,
      codexClaude: codexClaude,
      codexCodex: codexCodex,
    };
  });
  check(defaults.defaultClaude !== "none", "Claude defaults visible by default (got " + defaults.defaultClaude + ")");
  check(defaults.defaultCodex === "none", "Codex defaults hidden by default (got " + defaults.defaultCodex + ")");
  check(defaults.codexClaude === "none", "Claude defaults hidden under backend-codex");
  check(defaults.codexCodex !== "none", "Codex defaults visible under backend-codex (got " + defaults.codexCodex + ")");

  console.log("[hide-ui] step 7: config chip popup permission model swap");
  var popup = await page.evaluate(function () {
    // Synthesize the four popup sections — we don't need the full popup
    // shell, just the IDs that codex.css targets.
    function el(id) {
      // Avoid colliding with the page's existing elements.
      var existing = document.getElementById(id);
      if (existing) existing.parentNode.removeChild(existing);
      var n = document.createElement("div");
      n.id = id;
      n.style.background = "#444";
      n.style.color = "#fff";
      n.style.padding = "4px";
      n.textContent = id;
      document.body.appendChild(n);
      return n;
    }
    var modeSec = el("config-mode-section");
    var thinkingSec = el("config-thinking-section");
    var betaSec = el("config-beta-section");
    var sandboxSec = el("config-codex-sandbox-section");
    var approvalSec = el("config-codex-approval-section");

    var vis = function (n) { return window.getComputedStyle(n).display; };

    document.body.classList.remove("backend-codex");
    var claude = {
      mode: vis(modeSec),
      thinking: vis(thinkingSec),
      sandbox: vis(sandboxSec),
      approval: vis(approvalSec),
    };

    document.body.classList.add("backend-codex");
    var codex = {
      mode: vis(modeSec),
      thinking: vis(thinkingSec),
      beta: vis(betaSec),
      sandbox: vis(sandboxSec),
      approval: vis(approvalSec),
    };

    document.body.classList.remove("backend-codex");
    return { claude: claude, codex: codex };
  });

  // Claude side: Mode + Thinking visible, Codex sandbox/approval hidden.
  check(popup.claude.mode !== "none", "Claude popup: MODE section visible (got " + popup.claude.mode + ")");
  check(popup.claude.thinking !== "none", "Claude popup: THINKING section visible");
  check(popup.claude.sandbox === "none", "Claude popup: Codex SANDBOX hidden");
  check(popup.claude.approval === "none", "Claude popup: Codex APPROVAL hidden");

  // Codex side: Mode + Thinking + Beta hidden, Sandbox + Approval visible.
  check(popup.codex.mode === "none", "Codex popup: MODE hidden (got " + popup.codex.mode + ")");
  check(popup.codex.thinking === "none", "Codex popup: THINKING hidden");
  check(popup.codex.beta === "none", "Codex popup: BETA hidden");
  check(popup.codex.sandbox !== "none", "Codex popup: SANDBOX visible (got " + popup.codex.sandbox + ")");
  check(popup.codex.approval !== "none", "Codex popup: APPROVAL visible (got " + popup.codex.approval + ")");

  await browser.close();

  if (failures.length) {
    console.log("\n[hide-ui] FAILED " + failures.length + " checks");
    process.exit(1);
  }
  console.log("\n[hide-ui] PASSED all checks");
  process.exit(0);
})().catch(function (e) {
  console.error("[hide-ui] crashed:", e.message || e);
  process.exit(2);
});
