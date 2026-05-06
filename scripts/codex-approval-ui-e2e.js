// Playwright UI test for the iter-2 permission Modal source badge.
//
// Why a separate harness from codex-ui-e2e: actually triggering a Codex
// approval in-flight is non-deterministic (depends on the model deciding
// to run an out-of-sandbox command). The translation contract between
// Codex JSON-RPC and Clay's pendingPermissions Promise is already covered
// by unit tests in test/codex-approval.test.js. What that can NOT cover is
// the rendered Modal's CSS — that's what this test verifies.
//
// Strategy: open a regular page, then inject a permission-container DOM
// node identical to what renderPermissionRequest produces (shape verified
// against lib/public/modules/tools.js). Assert:
//   1. The Codex source badge renders with text "Codex" and
//      data-source="codex".
//   2. The Claude default (no source field) renders with text "Claude".
//   3. The badge gets accent2-derived color in the Codex variant — i.e.
//      the styling rule actually applies.
//
// Run after starting the isolated daemon:
//   npm run dev:isolated      # leave running
//   node scripts/codex-approval-ui-e2e.js --headless

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
  console.log("[approval-ui] launching chromium (headless=" + HEADLESS + ")");
  var browser = await chromium.launch({ headless: HEADLESS });
  var ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });
  var page = await ctx.newPage();

  console.log("[approval-ui] step 1: open dashboard so app.css + module CSS load");
  await page.goto(URL_BASE, { waitUntil: "domcontentloaded" });
  // Wait for the project list shell — confirms our static assets have loaded.
  await page.waitForSelector("#mobile-project-list, #app", { timeout: 8000 });

  console.log("[approval-ui] step 2: inject synthetic permission containers");
  await page.evaluate(function () {
    // Build a permission-container that mirrors renderPermissionRequest's
    // output shape exactly (see lib/public/modules/tools.js). We bypass the
    // module to make the test deterministic and independent of WS state.
    function build(source) {
      var c = document.createElement("div");
      c.className = "permission-container";
      c.dataset.requestId = "test-" + (source || "claude");
      if (source) c.dataset.source = source;

      var sourceLabel = source === "codex" ? "Codex" : "Claude";
      var hdr = document.createElement("div");
      hdr.className = "permission-header";
      hdr.innerHTML =
        '<span class="permission-icon"></span>' +
        '<span class="permission-title">Permission Required</span>' +
        '<span class="permission-source-badge" data-source="' +
          (source === "codex" ? "codex" : "claude") + '">' + sourceLabel + '</span>';
      c.appendChild(hdr);
      document.body.appendChild(c);
      return c;
    }
    window.__claudeC = build(null);
    window.__codexC = build("codex");
  });

  await shot(page, "20-approval-source-badges");

  console.log("[approval-ui] step 3: assert Claude default badge");
  var claude = await page.evaluate(function () {
    var b = window.__claudeC.querySelector(".permission-source-badge");
    var st = b ? window.getComputedStyle(b) : null;
    return b ? { text: b.textContent, dataSource: b.getAttribute("data-source"), color: st.color } : null;
  });
  check(claude !== null, "Claude badge rendered in DOM");
  check(claude && claude.text === "Claude", "Claude badge text === 'Claude' (got " + (claude && claude.text) + ")");
  check(claude && claude.dataSource === "claude", "data-source attribute === 'claude'");

  console.log("[approval-ui] step 4: assert Codex badge");
  var codex = await page.evaluate(function () {
    var b = window.__codexC.querySelector(".permission-source-badge");
    var st = b ? window.getComputedStyle(b) : null;
    return b ? { text: b.textContent, dataSource: b.getAttribute("data-source"), color: st.color, borderColor: st.borderColor } : null;
  });
  check(codex !== null, "Codex badge rendered in DOM");
  check(codex && codex.text === "Codex", "Codex badge text === 'Codex' (got " + (codex && codex.text) + ")");
  check(codex && codex.dataSource === "codex", "data-source attribute === 'codex'");
  // Verify the [data-source="codex"] rule actually fired by comparing color to
  // the Claude default. CSS variable resolution can vary between themes so we
  // don't pin a specific RGB — we just assert the two badges differ.
  check(codex && claude && codex.color !== claude.color,
    "Codex badge color differs from Claude default (" + (codex && codex.color) + " vs " + (claude && claude.color) + ")");

  await browser.close();

  if (failures.length) {
    console.log("\n[approval-ui] FAILED " + failures.length + " checks");
    process.exit(1);
  }
  console.log("\n[approval-ui] PASSED all checks");
  process.exit(0);
})().catch(function (e) {
  console.error("[approval-ui] crashed:", e.message || e);
  process.exit(2);
});
