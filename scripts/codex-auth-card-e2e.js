// Playwright UI test for the Codex "not logged in" guidance card.
//
// Strategy: temporarily break the Codex auth file (move the .codex
// symlink aside), let the server detect the missing auth, send a turn
// from the UI, and assert the dedicated guidance card renders. Restore
// the symlink before exit so the regular e2e remains green.
//
// Run separately from the main UI e2e so a single bad assertion can't
// mask the chip / badge / WS coverage:
//   npm run dev:isolated      # in another shell
//   node scripts/codex-auth-card-e2e.js

var fs = require("fs");
var path = require("path");
var net = require("net");
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
  } catch (e) {}
}

function ipcSend(cmd) {
  return new Promise(function (resolve, reject) {
    var sock = net.createConnection(path.join(TESTHOME, ".clay", "daemon.sock"));
    var buf = "";
    var done = false;
    var to = setTimeout(function () {
      if (done) return; done = true; sock.destroy(); reject(new Error("IPC timeout"));
    }, 5000);
    sock.on("connect", function () { sock.write(JSON.stringify(cmd) + "\n"); });
    sock.on("data", function (chunk) {
      buf += chunk.toString();
      var idx = buf.indexOf("\n");
      if (idx === -1 || done) return;
      done = true; clearTimeout(to); sock.destroy();
      try { resolve(JSON.parse(buf.substring(0, idx))); } catch (e) { reject(e); }
    });
    sock.on("error", function (e) { if (!done) { done = true; clearTimeout(to); reject(e); } });
  });
}

function wipePlaygroundSessions() {
  var dir = path.join(TESTHOME, ".clay", "sessions", PLAYGROUND.replace(/\//g, "-"));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

(async function main() {
  fs.mkdirSync(PLAYGROUND, { recursive: true });

  // Break Codex auth by renaming the symlink. The codex-backend reads
  // ~/.codex/auth.json relative to HOME — by moving the link we make the
  // file disappear without touching the real ~/.codex on the dev machine.
  var codexLink = path.join(TESTHOME, ".codex");
  var stashed = path.join(TESTHOME, ".codex.stashed");
  var hadLink = false;
  try {
    fs.lstatSync(codexLink);
    fs.renameSync(codexLink, stashed);
    hadLink = true;
    console.log("[auth-card] moved " + codexLink + " -> " + stashed);
  } catch (e) {
    console.log("[auth-card] no codex symlink to move (fresh missing-auth state)");
  }

  // Make sure no codex-playground project survives from a previous run,
  // then re-add fresh so the in-memory project context picks up the
  // missing-auth state. Also wipe sessions.
  await ipcSend({ cmd: "remove_project", slug: "codex-playground" }).catch(function () {});
  wipePlaygroundSessions();

  var failure = null;
  var browser, ctx, page;
  try {
    browser = await chromium.launch({ headless: HEADLESS });
    ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    page = await ctx.newPage();
    page.on("console", function (m) {
      var t = m.type();
      if (t === "error" || t === "warning") console.log("  [browser " + t + "] " + m.text());
    });

    console.log("[auth-card] step 1: open " + URL_BASE);
    await page.goto(URL_BASE + "/?t=" + Date.now(), { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/p\/[^\/]+\/?$/, { timeout: 15000 });

    console.log("[auth-card] step 2: open New Project, select Codex, add /tmp/codex-playground");
    await page.evaluate(function () {
      var modal = document.getElementById("add-project-modal");
      if (modal) modal.classList.remove("hidden");
    });
    await page.waitForSelector("#add-project-modal:not(.hidden)", { timeout: 5000 });
    await page.locator('.add-project-backend-btn[data-backend="codex"]').click();
    await page.locator("#add-project-input").fill(PLAYGROUND);
    await page.locator("#add-project-ok").click();
    // Wait for the daemon broadcast to land on the client.
    await page.waitForFunction(function () {
      var items = document.querySelectorAll(".mobile-project-item .mobile-project-name");
      for (var i = 0; i < items.length; i++) if (items[i].textContent.indexOf("codex-playground") !== -1) return true;
      return false;
    }, { timeout: 10000 });

    console.log("[auth-card] step 3: navigate to the codex project");
    await page.goto(URL_BASE + "/p/codex-playground/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(function () {});

    console.log("[auth-card] step 4: send a prompt — backend should refuse with auth_required");
    await page.evaluate(function () {
      var area = document.getElementById("input-area");
      if (area) area.classList.remove("hidden");
    });
    var composer = page.locator("#input");
    await composer.waitFor({ state: "visible", timeout: 5000 });
    await composer.fill("anything");
    await composer.press("Enter");

    console.log("[auth-card] step 5: assert the Codex guidance card renders");
    var deadline = Date.now() + 15000;
    var cardState = null;
    while (Date.now() < deadline) {
      cardState = await page.evaluate(function () {
        var card = document.querySelector(".codex-auth-card");
        if (!card) return null;
        return {
          headerText: (card.querySelector(".auth-required-header") || {}).textContent,
          hintText: (card.querySelector(".auth-required-hint") || {}).textContent,
          cmdText: (card.querySelector(".codex-auth-cmd") || {}).textContent,
          hasCopyBtn: !!card.querySelector(".codex-auth-copy-btn"),
          hasRetryBtn: !!card.querySelector(".codex-auth-retry-btn"),
          inputAreaHidden: (function () {
            var a = document.getElementById("input-area");
            return !!(a && a.classList.contains("hidden"));
          })(),
        };
      });
      if (cardState) break;
      await page.waitForTimeout(300);
    }
    await shot(page, "10-codex-auth-card");

    check(!!cardState, ".codex-auth-card rendered");
    if (cardState) {
      check(/Codex is not logged in/i.test(cardState.headerText || ""), "header reads 'Codex is not logged in' (got " + JSON.stringify(cardState.headerText) + ")");
      check((cardState.cmdText || "").trim() === "codex login", "command box shows exactly 'codex login' (got " + JSON.stringify(cardState.cmdText) + ")");
      check(cardState.hasCopyBtn, "Copy button present");
      check(cardState.hasRetryBtn, "Retry button present");
      check(cardState.inputAreaHidden, "#input-area is hidden while the card is up");

      console.log("[auth-card] step 6: clicking Retry restores the composer");
      await page.locator(".codex-auth-retry-btn").click();
      await page.waitForTimeout(300);
      var afterRetry = await page.evaluate(function () {
        var card = document.querySelector(".codex-auth-card");
        var area = document.getElementById("input-area");
        return {
          cardGone: !card,
          inputAreaHidden: !!(area && area.classList.contains("hidden")),
        };
      });
      check(afterRetry.cardGone, "guidance card removed after Retry");
      check(!afterRetry.inputAreaHidden, "#input-area no longer hidden after Retry");
    }
  } catch (e) {
    failure = e;
  } finally {
    if (browser) await browser.close().catch(function () {});
    // Restore the codex symlink no matter what.
    if (hadLink) {
      try { fs.renameSync(stashed, codexLink); } catch (e) {
        console.error("[auth-card] WARN: failed to restore symlink:", e.message);
      }
    }
  }

  if (failure) {
    console.error("[auth-card] crashed:", failure && (failure.stack || failure.message));
    process.exit(2);
  }
  if (failures.length) {
    console.log("\n[auth-card] FAILED " + failures.length + " checks");
    process.exit(1);
  }
  console.log("\n[auth-card] PASSED all checks");
  process.exit(0);
})();
