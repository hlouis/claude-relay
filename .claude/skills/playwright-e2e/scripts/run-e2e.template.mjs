// Template: copy this file, customize the TEST CASES section, run with `node`.
//
// Lifecycle: start isolated daemon -> drop fixtures -> drive browser -> wipe.
// Even if a test throws, the `finally` block tears the daemon down.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startDaemon, wipeDaemon, findPlaywright, projectUrl } from "<ABSOLUTE_PATH_TO>/lifecycle.mjs";

// ---- Configuration ----
var FEATURE = "my-feature";  // used in tmp dir names; pick something unique per script
var HOME = path.join(os.tmpdir(), "clay-e2e-" + FEATURE + "-home");
var PROJECT = path.join(os.tmpdir(), "clay-e2e-" + FEATURE + "-project");
var PORT = 12700;
var OUT_DIR = path.join(PROJECT, "screenshots");

// ---- Fixtures: write any HTML/JS/etc. files needed for the test here ----
fs.mkdirSync(PROJECT, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
// Example — copy a fixture from the skill's assets/fixtures/ if applicable.
// fs.copyFileSync("<SKILL_DIR>/assets/fixtures/static.html", path.join(PROJECT, "static.html"));

// ---- Start daemon ----
startDaemon({ home: HOME, project: PROJECT, port: PORT });

// ---- Load Playwright (not a project dep — find it elsewhere on disk) ----
var pwPath = findPlaywright();
if (!pwPath) throw new Error("Playwright not found. Run: npx playwright install chromium");
var { chromium } = await import(pwPath);

var results = [];
function record(name, ok, msg) {
  results.push({ name: name, ok: ok, msg: msg });
  console.log("[" + name + "] " + (ok ? "PASS" : "FAIL") + " — " + msg);
}

try {
  var browser = await chromium.launch({ headless: true });
  var ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  var page = await ctx.newPage();
  page.on("pageerror", function (e) { console.log("pageerror:", e.message); });

  var URL = projectUrl({ project: PROJECT, port: PORT });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // ===========================
  // TEST CASES — customize here
  // ===========================

  // Example: open File browser, click a file, assert the title bar
  try {
    await page.locator("text=File browser").first().click();
    await page.waitForTimeout(800);
    // For nested paths, click each parent dir first:
    //   await page.locator(".file-tree-item[data-path=\"site\"]").click();
    //   await page.waitForTimeout(300);
    //   await page.locator(".file-tree-item[data-path=\"site/index.html\"]").click();
    record("file-browser-opens", true, "tool tile clicked");
  } catch (e) {
    record("file-browser-opens", false, e.message);
  }

  // Example: assert iframe content of an HTML preview
  // await page.locator("#file-viewer-render").click();
  // await page.waitForTimeout(1000);
  // var h1 = await page.frameLocator(".file-viewer-html-preview").locator("h1").textContent({ timeout: 3000 });
  // record("preview-renders", h1 === "Expected", "h1=" + JSON.stringify(h1));

  // Example: verify a response header
  // var resp = await page.request.get(URL + "api/file-preview/index.html");
  // record("csp-header", resp.headers()["content-security-policy"]?.startsWith("sandbox"), resp.status() + "");

  await browser.close();
} finally {
  // ---- Always tear down ----
  wipeDaemon({ home: HOME, project: PROJECT });
}

// ---- Summary ----
var pass = results.filter(function (r) { return r.ok; }).length;
console.log("\n=== " + pass + "/" + results.length + " passed ===");
process.exit(pass === results.length ? 0 : 1);
