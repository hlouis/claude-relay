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

// Locate an existing Playwright install on the user's machine and return the
// absolute import path. Returns null if none found; caller should prompt to
// `npx playwright install chromium` or pick a specific path.
export function findPlaywright() {
  var candidates = [];
  var roots = [
    path.join(os.homedir(), ".npm", "_npx"),
    path.join(os.homedir(), "Develop"),
    path.join(os.homedir(), "code"),
    path.join(os.homedir(), "projects"),
  ];
  for (var i = 0; i < roots.length; i++) {
    var root = roots[i];
    if (!fs.existsSync(root)) continue;
    walk(root, 5, candidates);
  }
  if (candidates.length === 0) return null;
  // Prefer non-alpha versions
  candidates.sort(function (a, b) { return a.indexOf("alpha") - b.indexOf("alpha"); });
  return path.join(candidates[0], "index.mjs");
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
