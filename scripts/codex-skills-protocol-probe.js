// Iter 6a protocol probe — VERIFY before designing the Skills UI.
//
// Lessons from Iter 5a/5b: don't trust schema descriptions; exercise the
// real `codex app-server` and assert what comes back.
//
// What we want to learn:
//   1. Is `skills/list` reachable on this codex CLI? (method-not-found =
//      kill switch — we'd disable Iter 6a until users update.)
//   2. Does it return the documented shape `{ data: [{ cwd, skills, errors }] }`?
//   3. With NO params (defaulting to session cwd), what do we actually get?
//   4. With explicit `cwds: [<probe cwd>]`, same?
//   5. Does this user have ANY real skills installed (vs just bundled
//      system samples)? — drives the "is this worth doing" decision.
//   6. Does `forceReload: true` work without errors?
//   7. Does the `skills/changed` notification fire if we touch a SKILL.md
//      file under ~/.codex/skills/? (best-effort — only if the user
//      already has a skill we can poke.)
//
// Out of scope:
//   - Actually invoking a skill via `$<name>`. That requires a turn/start
//     and an LLM call; we'd burn API quota for a single yes/no signal that
//     we can also infer from the schema. Defer to live verify.
//   - SkillsConfig writes (`skills/config/write`).
//   - Plugin/marketplace/hook RPCs.
//
// Cost note: zero turns. Just `initialize` + a few `skills/list` calls.
//
// Usage:
//   node scripts/codex-skills-protocol-probe.js
//   PROBE_VERBOSE=1 node scripts/codex-skills-protocol-probe.js
//   PROBE_CWD=/some/path node scripts/codex-skills-protocol-probe.js

var path = require("path");
var fs = require("fs");
var os = require("os");
var { createCodexClient } = require("../lib/codex-jsonrpc");

var VERBOSE = !!process.env.PROBE_VERBOSE;
var CWD = process.env.PROBE_CWD || process.cwd();

function log() {
  console.log.apply(console, ["[probe]"].concat(Array.prototype.slice.call(arguments)));
}
function vlog() {
  if (VERBOSE) console.log.apply(console, ["[probe]"].concat(Array.prototype.slice.call(arguments)));
}

var failures = [];
function check(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); return true; }
  console.log("  ✗ " + msg);
  failures.push(msg);
  return false;
}

function locateCodexBin() {
  var which = require("child_process").spawnSync("which", ["codex"]);
  if (which.status === 0) return which.stdout.toString().trim();
  return null;
}

function summarizeSkill(s) {
  return {
    name: s.name,
    scope: s.scope,
    enabled: s.enabled,
    descLen: (s.description || "").length,
    hasInterface: !!s.interface,
    hasDeps: !!s.dependencies,
    pathTail: typeof s.path === "string" ? s.path.slice(-60) : (s.path && s.path.path ? String(s.path.path).slice(-60) : "(non-string path)"),
  };
}

(async function main() {
  var bin = locateCodexBin();
  if (!bin) {
    console.error("codex binary not found in PATH");
    process.exit(2);
  }
  log("codex binary:", bin);
  log("probe cwd:", CWD);

  var notifications = [];
  var serverRequests = [];

  var client = createCodexClient({
    command: bin,
    args: ["app-server"],
    cwd: CWD,
    onNotification: function (n) {
      notifications.push(n);
      vlog("« notify", n.method, JSON.stringify(n.params || {}).slice(0, 200));
    },
    onServerRequest: function (msg) {
      serverRequests.push(msg);
      vlog("« request", msg.method);
      try { client.respondError(msg.id, -32601, "probe declines all server requests"); } catch (_) {}
    },
    onExit: function (code, signal) {
      log("client exited code=" + code + " signal=" + signal);
    },
    onStderr: function (chunk) {
      if (VERBOSE) process.stderr.write("[codex-stderr] " + chunk);
    },
  });

  try {
    log("step 1: initialize");
    var initResp = await client.request("initialize", {
      clientInfo: { name: "clay-skills-probe", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    check(typeof initResp === "object", "initialize returned an object");

    // --- Probe A: skills/list with no params ---
    log("step 2: skills/list (no params)");
    var noArgErr = null;
    var noArgResp = null;
    try {
      noArgResp = await client.request("skills/list", {});
    } catch (e) {
      noArgErr = e;
    }
    check(noArgErr == null,
      "skills/list with empty params did NOT error (err=" + (noArgErr && noArgErr.message) + ")");
    if (noArgErr && noArgErr.code === -32601) {
      log("  -32601 means this codex CLI doesn't expose skills/list — kill switch.");
      log("  Skip remaining steps; report and exit.");
      log("\n=== probe summary ===");
      log("FAILURES: skills/list method missing");
      client.close();
      process.exit(1);
    }

    var dataArr = noArgResp && noArgResp.data;
    check(Array.isArray(dataArr), "response.data is an array (got " + typeof dataArr + ")");
    if (Array.isArray(dataArr)) {
      log("  data.length=" + dataArr.length);
      // With empty params, codex says "defaults to current session working
      // directory". The "current session" here is undefined because we
      // haven't started a thread — observe what codex actually does.
      for (var i = 0; i < dataArr.length; i++) {
        var entry = dataArr[i];
        log("  entry[" + i + "]: cwd=" + entry.cwd + " skills.len=" + (entry.skills ? entry.skills.length : "?") + " errors.len=" + (entry.errors ? entry.errors.length : "?"));
      }
    }

    // --- Probe B: skills/list with explicit cwds ---
    log("step 3: skills/list { cwds: [PROBE_CWD] }");
    var cwdsResp = null;
    try {
      cwdsResp = await client.request("skills/list", { cwds: [CWD] });
    } catch (e) {
      check(false, "skills/list { cwds } failed: " + e.message);
    }
    if (cwdsResp) {
      var arr2 = cwdsResp.data || [];
      check(Array.isArray(arr2), "explicit-cwds response.data is an array");
      check(arr2.length >= 1, "explicit-cwds response has at least one entry (got " + arr2.length + ")");
      var totalSkills = 0;
      var enabledSkills = 0;
      var byScope = {};
      var firstSkill = null;
      for (var j = 0; j < arr2.length; j++) {
        var e2 = arr2[j];
        log("  entry[" + j + "]: cwd=" + e2.cwd + " skills.len=" + (e2.skills ? e2.skills.length : "?") + " errors.len=" + (e2.errors ? e2.errors.length : "?"));
        if (Array.isArray(e2.skills)) {
          totalSkills += e2.skills.length;
          for (var k = 0; k < e2.skills.length; k++) {
            var sk = e2.skills[k];
            if (sk.enabled) enabledSkills++;
            var scopeKey = typeof sk.scope === "string" ? sk.scope : JSON.stringify(sk.scope);
            byScope[scopeKey] = (byScope[scopeKey] || 0) + 1;
            if (!firstSkill) firstSkill = sk;
          }
        }
        if (Array.isArray(e2.errors) && e2.errors.length > 0) {
          log("    errors:", JSON.stringify(e2.errors).slice(0, 300));
        }
      }
      log("  TOTAL skills: " + totalSkills + " (enabled: " + enabledSkills + ")");
      log("  by scope: " + JSON.stringify(byScope));
      if (firstSkill) {
        log("  sample skill shape:", JSON.stringify(summarizeSkill(firstSkill)));
        // Schema sanity: every documented field present?
        check(typeof firstSkill.name === "string", "skill.name is string");
        check(typeof firstSkill.description === "string", "skill.description is string");
        check(typeof firstSkill.enabled === "boolean", "skill.enabled is boolean");
        check(firstSkill.scope != null, "skill.scope is present");
        check(firstSkill.path != null, "skill.path is present");
      } else {
        log("  NO SKILLS FOUND — this account/cwd has zero installed skills");
        log("  (Iter 6a UI would render an empty state; verify whether bundled");
        log("   system skills are supposed to appear here.)");
      }
    }

    // --- Probe C: forceReload ---
    log("step 4: skills/list { cwds, forceReload: true }");
    var forceResp = null;
    try {
      forceResp = await client.request("skills/list", { cwds: [CWD], forceReload: true });
    } catch (e) {
      check(false, "skills/list { forceReload: true } failed: " + e.message);
    }
    if (forceResp) {
      check(Array.isArray(forceResp.data), "forceReload response.data is an array");
    }

    // --- Probe D: skills/list with multiple cwds ---
    log("step 5: skills/list { cwds: [PROBE_CWD, $HOME] } (multi-cwd)");
    var multiResp = null;
    try {
      multiResp = await client.request("skills/list", { cwds: [CWD, os.homedir()] });
    } catch (e) {
      check(false, "skills/list multi-cwd failed: " + e.message);
    }
    if (multiResp && Array.isArray(multiResp.data)) {
      check(multiResp.data.length === 2,
        "multi-cwd returns one entry per cwd (got " + multiResp.data.length + ")");
    }

    // --- Probe E: skills/list with bogus cwd ---
    log("step 6: skills/list { cwds: ['/path/that/does/not/exist'] }");
    var bogusResp = null;
    var bogusErr = null;
    try {
      bogusResp = await client.request("skills/list", { cwds: ["/nonexistent/path/probe-" + Date.now()] });
    } catch (e) {
      bogusErr = e;
    }
    log("  bogus-cwd: error=" + (bogusErr && bogusErr.message) + ", entries=" + (bogusResp && bogusResp.data && bogusResp.data.length));
    // No assertion — we just want to know whether codex errors or returns
    // an entry with errors[]. UI design needs to know which.

    // --- Probe F: ~/.codex/skills/ directory inspection ---
    log("step 7: filesystem inspection of ~/.codex/skills/");
    var skillsDir = path.join(os.homedir(), ".codex", "skills");
    var hasSkillsDir = false;
    try {
      var st = fs.statSync(skillsDir);
      hasSkillsDir = st.isDirectory();
    } catch (_) {}
    log("  ~/.codex/skills exists: " + hasSkillsDir);
    if (hasSkillsDir) {
      try {
        var entries = fs.readdirSync(skillsDir);
        log("  entries: " + entries.length + " (" + entries.slice(0, 10).join(", ") + (entries.length > 10 ? ", ..." : "") + ")");
      } catch (e) {
        log("  readdir failed:", e.message);
      }
    }

    // --- Probe G: skills/changed notification (best-effort) ---
    log("step 8: did we receive any skills/changed notifications during the probe?");
    var changedCount = 0;
    for (var i2 = 0; i2 < notifications.length; i2++) {
      if (notifications[i2].method === "skills/changed") changedCount++;
    }
    log("  skills/changed notifications received: " + changedCount + " (best-effort; we didn't actively touch skill files)");

    log("\n=== probe summary ===");
    log("notifications observed: " + notifications.length);
    log("server requests during probe: " + serverRequests.length + " (probe declines all)");
    if (failures.length) {
      log("FAILURES: " + failures.length);
      failures.forEach(function (f) { log("  - " + f); });
      client.close();
      process.exit(1);
    }
    log("all probe assertions passed");
    client.close();
    setTimeout(function () { process.exit(0); }, 500);
  } catch (e) {
    console.error("[probe] crashed:", e && (e.stack || e.message || e));
    try { client.close(); } catch (_) {}
    process.exit(2);
  }
})();
