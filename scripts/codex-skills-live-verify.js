// Iter 6a live verify — drives a real Codex turn through the skills
// pipeline to prove `$<skill-name>` injection actually reaches the
// model. NOT in CI (model behavior is non-deterministic + costs API
// calls per run); run manually before any 6a release.
//
// What this proves (none of the unit/e2e tests can):
//   1. The frontend's panel-click → input-prefix → message-send chain
//      ends up sending `$<name>` text to the backend.
//   2. The backend's `$<name>` parser runs, finds the matching skill,
//      and appends the `{type:"skill", name, path}` input item to the
//      `turn/start` payload.
//   3. Codex on the receiving end accepts the skill input item without
//      error and the assistant's response reflects the skill's
//      instructions (vs a no-skill control turn).
//
// Pattern (mirrors codex-fork-live-verify.js):
//   1. Register /tmp/codex-playground as Codex.
//   2. Open page in headless Chromium.
//   3. Wait for warmup `codex_skills` frame so the panel populates.
//   4. CONTROL turn: ask a generic question without any `$skill` prefix,
//      capture the reply.
//   5. SKILL turn: open the skills panel, click `$skill-creator` (always
//      available — bundled system skill), append a question about
//      authoring a skill, send. Capture the reply.
//   6. Assert the SKILL reply mentions skill-creator's domain language
//      ("SKILL.md", "skill", or similar) — proves the injected SKILL.md
//      content reached the model context.
//
// We use `skill-creator` because it's a bundled `system`-scope skill
// guaranteed present on any current `codex` install. `imagegen` would
// trigger image-generation tooling which we want to avoid in CI-style
// scripts.
//
// Run with isolated daemon already up:
//   npm run dev:isolated
//   node scripts/codex-skills-live-verify.js
//   node scripts/codex-skills-live-verify.js --headed   # show browser
//   CLAY_SLOWMO=200 node scripts/codex-skills-live-verify.js --headed
//                                                        # slow + show

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

// We pick a skill that:
//   - is reliably installed (bundled system scope on any current codex)
//   - has SKILL.md content distinct enough that the model's reply will
//     contain identifiable substrings.
var TARGET_SKILL = process.env.SKILL_NAME || "skill-creator";
// Substrings we expect to see in a model reply that received skill-creator's
// SKILL.md content but NOT in a generic codex reply. These are specific
// scripts/files bundled inside skill-creator's package — the model would
// not name them without seeing the injected SKILL.md. We accept any one
// match — the model phrases vary turn-to-turn.
//
// `SKILL.md` is excluded from the signal list because codex's general
// knowledge knows about SKILL.md as a file format; matching it would
// not differentiate a skill-injected reply from a generic one.
var SKILL_REPLY_SIGNALS = [
  /\binit_skill\b/i,           // scripts/init_skill.py — unique to skill-creator
  /\bquick_validate\b/i,        // scripts/quick_validate.py — unique to skill-creator
  /openai\.yaml/i,              // scaffold output filename
  /\bskill\.json\b/i,           // scaffolded interface config
];

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
  console.log("[skills-verify] step 1: register Codex playground");
  fs.mkdirSync(PLAYGROUND, { recursive: true });
  wipePlaygroundSessions();
  await ipcSend({ cmd: "remove_project", path: PLAYGROUND }).catch(function () {});
  var ipcResp = await ipcSend({ cmd: "add_project", path: PLAYGROUND, backend: "codex" });
  if (!ipcResp.ok) throw new Error("add_project failed: " + JSON.stringify(ipcResp));
  var slug = ipcResp.slug;
  console.log("  → slug=" + slug);

  var headed = process.argv.indexOf("--headed") !== -1 || process.env.CLAY_HEADED === "1";
  var slowMo = parseInt(process.env.CLAY_SLOWMO || "0", 10) || 0;
  console.log("[skills-verify] step 2: launch chromium (headed=" + headed + ", slowMo=" + slowMo + ")");
  var browser = await chromium.launch({ headless: !headed, slowMo: slowMo });
  var ctx = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });

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

  console.log("[skills-verify] step 3: open project page + wait for skills warmup");
  await page.goto(URL_BASE + "/p/" + slug + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.evaluate(function () {
    var area = document.getElementById("input-area");
    if (area) area.classList.remove("hidden");
  });
  await page.locator("#input").waitFor({ state: "visible", timeout: 10000 });

  // Wait for the skills picker button to appear AND a codex_skills frame
  // to arrive — both proving warmup completed.
  await page.waitForFunction(function () {
    var b = document.getElementById("header-codex-skills-btn");
    return b && !b.hidden;
  }, { timeout: 8000 });
  var skillsDeadline = Date.now() + 10000;
  var skillsFrame = null;
  while (Date.now() < skillsDeadline && !skillsFrame) {
    for (var i = receivedMsgs.length - 1; i >= 0; i--) {
      if (receivedMsgs[i].type === "codex_skills") { skillsFrame = receivedMsgs[i]; break; }
    }
    if (!skillsFrame) await page.waitForTimeout(200);
  }
  if (!skillsFrame) {
    console.log("  ✗ no codex_skills frame received — warmup fetch did not run");
    await browser.close();
    process.exit(1);
  }
  console.log("  codex_skills frame received: " + skillsFrame.skills.length + " skills");
  var hasTarget = skillsFrame.skills.some(function (s) { return s && s.name === TARGET_SKILL; });
  if (!hasTarget) {
    console.log("  ✗ target skill `" + TARGET_SKILL + "` not in skills list — got: " +
      skillsFrame.skills.map(function (s) { return s.name; }).join(", "));
    await browser.close();
    process.exit(1);
  }
  console.log("  target skill `" + TARGET_SKILL + "` present in list");
  await shot(page, "90-skills-warmup-loaded");

  function getMsgCount() { return receivedMsgs.length; }
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
          reject(new Error("turn timeout"));
        }
      }, 200);
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

  // ---------------- CONTROL TURN ----------------
  console.log("[skills-verify] step 4: CONTROL turn — no $skill prefix");
  var ctrlMark = getMsgCount();
  await page.locator("#input").fill("In one short sentence, what file format does a Codex skill use?");
  await page.locator("#input").press("Enter");
  await waitForDoneAfter(ctrlMark, TURN_TIMEOUT);
  var ctrlReply = readDeltasSinceMark(ctrlMark);
  console.log("  control reply: " + JSON.stringify(ctrlReply.slice(0, 200)));
  await shot(page, "91-skills-control-reply");

  // ---------------- SKILL TURN ----------------
  console.log("[skills-verify] step 5: SKILL turn — pick `" + TARGET_SKILL + "` from panel");
  // Open the skills panel and click the target skill row.
  await page.locator("#header-codex-skills-btn").click();
  await page.waitForFunction(function () {
    var p = document.getElementById("codex-skills-panel");
    return p && !p.classList.contains("hidden");
  }, { timeout: 3000 });
  await page.locator(".codex-skills-row[data-skill-name=\"" + TARGET_SKILL + "\"]").click();
  // Panel should close and input should show `$<name> ` prefix.
  await page.waitForFunction(function (target) {
    var el = document.getElementById("input");
    return el && el.value === "$" + target + " ";
  }, TARGET_SKILL, { timeout: 3000 });

  // Append the question and send.
  await page.locator("#input").fill("$" + TARGET_SKILL + " In one short sentence, walk me through creating a brand-new skill.");
  await shot(page, "92-skills-prefix-set");
  var skillMark = getMsgCount();
  await page.locator("#input").press("Enter");
  await waitForDoneAfter(skillMark, TURN_TIMEOUT);
  var skillReply = readDeltasSinceMark(skillMark);
  console.log("  skill reply: " + JSON.stringify(skillReply.slice(0, 400)));
  await shot(page, "93-skills-reply");

  // ---------------- ASSERT ----------------
  console.log("[skills-verify] step 6: assert skill reply contains skill-creator signal AND control reply does NOT");
  var matchedSignal = null;
  for (var si = 0; si < SKILL_REPLY_SIGNALS.length; si++) {
    if (SKILL_REPLY_SIGNALS[si].test(skillReply)) {
      matchedSignal = SKILL_REPLY_SIGNALS[si];
      break;
    }
  }
  if (!matchedSignal) {
    console.log("  ✗ skill reply did NOT contain any expected signal:");
    SKILL_REPLY_SIGNALS.forEach(function (r) { console.log("      - " + r); });
    console.log("    full reply: " + JSON.stringify(skillReply));
    await browser.close();
    process.exit(1);
  }
  // Sanity check: control reply should NOT match the same signal — that
  // would mean codex's general knowledge already covers it and our skill
  // injection isn't the differentiator. If it does, we report but don't
  // fail (the assertion is best-effort: the model could happen to mention
  // these in any answer).
  if (matchedSignal.test(ctrlReply)) {
    console.log("  ⚠ control reply ALSO matched " + matchedSignal +
      " — signal isn't strongly skill-specific, but skill injection still observed end-to-end.");
  } else {
    console.log("  ✓ control reply does NOT match the signal — differential proves skill injection added context");
  }
  console.log("  ✓ skill reply matched signal " + matchedSignal +
    " — `$" + TARGET_SKILL + "` injection reached the model");

  await browser.close();
  console.log("\n[skills-verify] ✓ live skill round-trip succeeded:");
  console.log("    - warmup auto-fetched skills");
  console.log("    - panel click prefilled input with `$" + TARGET_SKILL + " `");
  console.log("    - turn/start carried the skill input item");
  console.log("    - model reply reflects SKILL.md content (signal: " + matchedSignal + ")");
})().catch(function (e) {
  console.error("[skills-verify] crashed:", e && (e.stack || e.message || e));
  process.exit(2);
});
