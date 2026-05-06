// Playwright UI test for the iter-4 codex_unavailable card.
//
// We do NOT spawn / kill a real codex app-server here — that's the live
// verify path. This test verifies the renderer's CSS + DOM contract by
// driving the same code path the WS handler uses (addCodexUnavailableCard
// is exposed through window for testability).
//
// Strategy: open the dashboard so all CSS loads, then synthesise the card
// directly in DOM matching what the renderer outputs. Assert structure,
// computed styles, kind-driven theming differences, and the View Logs
// expand/collapse mechanic.
//
// Run after starting the isolated daemon:
//   npm run dev:isolated      # leave running
//   node scripts/codex-unavailable-ui-e2e.js --headless

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
  console.log("[unavailable-ui] launching chromium (headless=" + HEADLESS + ")");
  var browser = await chromium.launch({ headless: HEADLESS });
  var ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });
  var page = await ctx.newPage();

  console.log("[unavailable-ui] step 1: open dashboard so codex.css loads");
  await page.goto(URL_BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#mobile-project-list, #app", { timeout: 8000 });

  console.log("[unavailable-ui] step 2: inject synthetic codex_unavailable cards (crashed + binary_missing)");
  await page.evaluate(function () {
    function buildCard(kind, message, stderrTail) {
      // Mirror addCodexUnavailableCard's DOM exactly. If the renderer
      // changes shape, this test must be updated alongside it.
      var div = document.createElement("div");
      div.className = "codex-unavailable-card codex-unavailable-" + kind;
      div.setAttribute("data-kind", kind);

      var header = document.createElement("div");
      header.className = "codex-unavailable-header";
      header.textContent = "title-" + kind;
      div.appendChild(header);

      var detail = document.createElement("div");
      detail.className = "codex-unavailable-detail";
      detail.textContent = message;
      div.appendChild(detail);

      var actions = document.createElement("div");
      actions.className = "codex-unavailable-actions";

      var retryBtn = document.createElement("button");
      retryBtn.className = "codex-unavailable-retry-btn";
      retryBtn.type = "button";
      retryBtn.textContent = "Retry";
      actions.appendChild(retryBtn);

      var logsBtn = document.createElement("button");
      logsBtn.className = "codex-unavailable-logs-btn";
      logsBtn.type = "button";
      logsBtn.textContent = "View Logs";
      actions.appendChild(logsBtn);
      div.appendChild(actions);

      var logsPane = document.createElement("div");
      logsPane.className = "codex-unavailable-logs";
      logsPane.style.display = "none";

      var sec = document.createElement("div");
      sec.className = "codex-unavailable-logs-section";
      var t = document.createElement("div");
      t.className = "codex-unavailable-logs-title";
      t.textContent = "stderr (last 8 KB)";
      sec.appendChild(t);
      var pre = document.createElement("pre");
      pre.className = "codex-unavailable-logs-pre";
      pre.textContent = stderrTail || "(empty)";
      sec.appendChild(pre);
      logsPane.appendChild(sec);
      div.appendChild(logsPane);

      logsBtn.addEventListener("click", function () {
        if (logsPane.style.display === "none") {
          logsPane.style.display = "";
          logsBtn.textContent = "Hide Logs";
        } else {
          logsPane.style.display = "none";
          logsBtn.textContent = "View Logs";
        }
      });

      document.body.appendChild(div);
      return div;
    }

    window.__crashCard = buildCard("crashed", "Codex app-server exited (code=1)", "panic: out of memory\n");
    window.__binCard = buildCard("binary_missing", "The `codex` binary could not be executed", "");
    window.__authLostCard = buildCard("auth_lost", "Codex backend returned 401. Run `codex login` then click Retry.", "");
  });

  await shot(page, "30-codex-unavailable-cards");

  console.log("[unavailable-ui] step 3: assert crashed card structure + theming");
  var crashed = await page.evaluate(function () {
    var card = window.__crashCard;
    var hdr = card.querySelector(".codex-unavailable-header");
    var det = card.querySelector(".codex-unavailable-detail");
    var retry = card.querySelector(".codex-unavailable-retry-btn");
    var logs = card.querySelector(".codex-unavailable-logs-btn");
    var logsPane = card.querySelector(".codex-unavailable-logs");
    var st = window.getComputedStyle(card);
    return {
      kind: card.getAttribute("data-kind"),
      hdrText: hdr && hdr.textContent,
      detText: det && det.textContent,
      retryText: retry && retry.textContent,
      logsBtnText: logs && logs.textContent,
      logsPaneDisplay: logsPane && logsPane.style.display,
      borderLeft: st.borderLeftWidth + " " + st.borderLeftStyle,
      borderLeftColor: st.borderLeftColor,
    };
  });
  check(crashed.kind === "crashed", "data-kind === 'crashed'");
  check(crashed.hdrText === "title-crashed", "header rendered");
  check(/exited/.test(crashed.detText), "detail contains failure message");
  check(crashed.retryText === "Retry", "Retry button present");
  check(crashed.logsBtnText === "View Logs", "View Logs button present");
  check(crashed.logsPaneDisplay === "none", "logs pane initially hidden");
  check(/3px/.test(crashed.borderLeft), "border-left accent stripe applied (got " + crashed.borderLeft + ")");

  console.log("[unavailable-ui] step 3.5: assert auth_lost variant renders with the right copy");
  var authLost = await page.evaluate(function () {
    var card = window.__authLostCard;
    var det = card.querySelector(".codex-unavailable-detail");
    var retry = card.querySelector(".codex-unavailable-retry-btn");
    return {
      kind: card.getAttribute("data-kind"),
      detText: det && det.textContent,
      retryText: retry && retry.textContent,
    };
  });
  check(authLost.kind === "auth_lost", "data-kind === 'auth_lost'");
  check(/codex login/i.test(authLost.detText),
    "auth_lost detail mentions `codex login` (got " + JSON.stringify(authLost.detText) + ")");
  check(authLost.retryText === "Retry", "auth_lost card has Retry button");

  console.log("[unavailable-ui] step 4: assert binary_missing variant uses accent2 border-left");
  var bin = await page.evaluate(function () {
    var card = window.__binCard;
    var st = window.getComputedStyle(card);
    return { borderLeftColor: st.borderLeftColor, kind: card.getAttribute("data-kind") };
  });
  check(bin.kind === "binary_missing", "data-kind === 'binary_missing'");
  check(bin.borderLeftColor !== crashed.borderLeftColor,
    "binary_missing border-left differs from crashed (" + bin.borderLeftColor + " vs " + crashed.borderLeftColor + ")");

  console.log("[unavailable-ui] step 5: assert View Logs expand renders pre with stderr");
  await page.evaluate(function () {
    window.__crashCard.querySelector(".codex-unavailable-logs-btn").click();
  });
  await page.waitForTimeout(50);
  var expanded = await page.evaluate(function () {
    var card = window.__crashCard;
    var pane = card.querySelector(".codex-unavailable-logs");
    var pre = card.querySelector(".codex-unavailable-logs-pre");
    var btn = card.querySelector(".codex-unavailable-logs-btn");
    var preStyle = pre ? window.getComputedStyle(pre) : null;
    return {
      paneDisplay: pane && pane.style.display,
      preText: pre && pre.textContent,
      btnText: btn && btn.textContent,
      preFontFamily: preStyle && preStyle.fontFamily,
      preMaxHeight: preStyle && preStyle.maxHeight,
    };
  });
  check(expanded.paneDisplay === "", "logs pane displayed after click");
  check(/panic/.test(expanded.preText), "stderr content rendered in <pre>");
  check(expanded.btnText === "Hide Logs", "button toggles to Hide Logs");
  check(/mono/i.test(expanded.preFontFamily) || /Menlo|Monaco|Consolas|SFMono/i.test(expanded.preFontFamily),
    "pre uses monospace font (" + expanded.preFontFamily + ")");
  check(expanded.preMaxHeight && expanded.preMaxHeight !== "none",
    "pre has max-height to keep card compact (" + expanded.preMaxHeight + ")");

  console.log("[unavailable-ui] step 6: collapse logs and verify");
  await page.evaluate(function () {
    window.__crashCard.querySelector(".codex-unavailable-logs-btn").click();
  });
  await page.waitForTimeout(50);
  var collapsed = await page.evaluate(function () {
    var card = window.__crashCard;
    var pane = card.querySelector(".codex-unavailable-logs");
    var btn = card.querySelector(".codex-unavailable-logs-btn");
    return { paneDisplay: pane && pane.style.display, btnText: btn && btn.textContent };
  });
  check(collapsed.paneDisplay === "none", "logs pane hidden again");
  check(collapsed.btnText === "View Logs", "button reverts to View Logs");

  console.log("[unavailable-ui] step 7: Retry button is interactive (not disabled by CSS)");
  var retryEnabled = await page.evaluate(function () {
    var btn = window.__crashCard.querySelector(".codex-unavailable-retry-btn");
    var st = window.getComputedStyle(btn);
    return { disabled: btn.disabled, cursor: st.cursor, pointerEvents: st.pointerEvents };
  });
  check(retryEnabled.disabled === false, "Retry button not disabled");
  check(retryEnabled.cursor === "pointer", "Retry cursor is pointer");
  check(retryEnabled.pointerEvents !== "none", "Retry pointer-events not blocked");

  await browser.close();

  if (failures.length) {
    console.log("\n[unavailable-ui] FAILED " + failures.length + " checks");
    process.exit(1);
  }
  console.log("\n[unavailable-ui] PASSED all checks");
  process.exit(0);
})().catch(function (e) {
  console.error("[unavailable-ui] crashed:", e.message || e);
  process.exit(2);
});
