// Lifecycle helpers for the isolated clay daemon.
// Import from any test script:
//   import { startDaemon, stopDaemon, wipeDaemon, findPlaywright } from ".../lifecycle.mjs";

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Resolve the repo root from this file's location:
//   <repo>/.claude/skills/playwright-e2e/scripts/lifecycle.mjs  ->  <repo>
var SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname);
var REPO_ROOT = path.resolve(SCRIPTS_DIR, "..", "..", "..", "..");

function npm(args, opts) {
  return spawnSync("npm", args, Object.assign({ cwd: REPO_ROOT, stdio: "inherit" }, opts || {}));
}

export function startDaemon(opts) {
  var args = ["run", "dev:isolated", "--", "start",
    "--home", opts.home,
    "--project", opts.project,
    "--port", String(opts.port || 12700),
    "--pin", String(opts.pin || "123456"),
  ];
  if (opts.host) args.push("--host", opts.host);
  var r = npm(args);
  if (r.status !== 0) throw new Error("daemon start failed (status=" + r.status + ")");
}

export function stopDaemon(opts) {
  npm(["run", "dev:isolated", "--", "stop", "--home", opts.home]);
}

export function wipeDaemon(opts) {
  npm(["run", "dev:isolated", "--", "wipe", "--home", opts.home]);
  if (opts.project && fs.existsSync(opts.project)) {
    fs.rmSync(opts.project, { recursive: true, force: true });
  }
}

// Locate an existing Playwright install on the user's machine whose required
// Chromium build is actually downloaded. Returns the absolute import path or
// null. Without this check, `findPlaywright` can pick a version whose chromium
// is missing on disk, which fails at `browser.launch` time with an opaque
// "Executable doesn't exist" error.
export function findPlaywright() {
  var candidates = [];
  var roots = [
    path.join(os.homedir(), ".npm", "_npx"),
    path.join(os.homedir(), "Develop"),
    path.join(os.homedir(), "code"),
    path.join(os.homedir(), "projects"),
  ];
  for (var i = 0; i < roots.length; i++) {
    if (fs.existsSync(roots[i])) walk(roots[i], 5, candidates);
  }
  if (candidates.length === 0) return null;

  // Read each install's package.json to grab the bundled chromium revision,
  // then check that the corresponding browser directory exists in the
  // ms-playwright cache. Pick the highest-rev install that's actually usable.
  var cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  var usable = [];
  for (var j = 0; j < candidates.length; j++) {
    var rev = readChromiumRev(candidates[j]);
    if (!rev) continue;
    var browserDirs = ["chromium-" + rev, "chromium_headless_shell-" + rev];
    var ok = browserDirs.some(function (d) { return fs.existsSync(path.join(cacheDir, d)); });
    if (ok) usable.push({ root: candidates[j], rev: parseInt(rev, 10) || 0 });
  }
  if (usable.length === 0) return null;
  usable.sort(function (a, b) { return b.rev - a.rev; }); // prefer newest
  return path.join(usable[0].root, "index.mjs");
}

function readChromiumRev(pwRoot) {
  // playwright-core/browsers.json lists each browser's revision.
  var candidates = [
    path.join(pwRoot, "..", "playwright-core", "browsers.json"),
    path.join(pwRoot, "browsers.json"),
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      var data = JSON.parse(fs.readFileSync(candidates[i], "utf8"));
      var list = data.browsers || [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].name === "chromium" || list[j].name === "chromium-headless-shell") {
          return String(list[j].revision);
        }
      }
    } catch (e) {}
  }
  return null;
}

function walk(dir, depth, out) {
  if (depth < 0) return;
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return; }
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.isDirectory()) continue;
    var full = path.join(dir, e.name);
    if (e.name === "playwright" && dir.endsWith("node_modules")) {
      if (fs.existsSync(path.join(full, "index.mjs"))) out.push(full);
      continue;
    }
    if (e.name === "node_modules" || e.name === "playwright" || e.name === ".npm" || e.name === "_npx") {
      walk(full, depth - 1, out);
    } else if (depth > 2) {
      walk(full, depth - 1, out);
    }
  }
}

export function projectUrl(opts) {
  var slug = path.basename(opts.project);
  return "http://" + (opts.host || "127.0.0.1") + ":" + (opts.port || 12700) + "/p/" + slug + "/";
}
