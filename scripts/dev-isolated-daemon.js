#!/usr/bin/env node
// Start / stop / inspect a fully-isolated clay daemon for local testing.
//
// Isolation knobs:
//   HOME       -> <homeDir>   (so os.homedir() resolves here; ~/.clayrc is local)
//   CLAY_HOME  -> <homeDir>   (daemon.json, sessions/, sock all live here)
//   cwd        -> <projectDir> (so the daemon auto-registers the test project,
//                               not the shell's working directory)
//
// Nothing under your real ~/.clay or ~/.clayrc is touched.
//
// Usage:
//   node scripts/dev-isolated-daemon.js start [--home DIR] [--project DIR] [--port N] [--pin PIN]
//   node scripts/dev-isolated-daemon.js stop  [--home DIR]
//   node scripts/dev-isolated-daemon.js status [--home DIR]
//   node scripts/dev-isolated-daemon.js wipe  [--home DIR]   (stop + rm -rf the home dir)
//
// npm shortcut: `npm run dev:isolated -- start --project /tmp/my-test`

var fs = require("fs");
var path = require("path");
var os = require("os");
var spawnSync = require("child_process").spawnSync;

var REPO_ROOT = path.resolve(__dirname, "..");
var CLI = path.join(REPO_ROOT, "bin", "cli.js");

function parseArgs(argv) {
  var out = { _: [] };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a.indexOf("--") === 0) {
      var k = a.slice(2);
      var v = argv[i + 1];
      if (v === undefined || v.indexOf("--") === 0) { out[k] = true; }
      else { out[k] = v; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function withDefaults(args) {
  return {
    cmd: args._[0] || "start",
    homeDir: path.resolve(args.home || path.join(os.tmpdir(), "clay-isolated-home")),
    projectDir: path.resolve(args.project || path.join(os.tmpdir(), "clay-isolated-project")),
    port: String(args.port || "12700"),
    pin: String(args.pin || "123456"),
    host: String(args.host || "127.0.0.1"),
  };
}

function runCli(opts, extraArgs) {
  fs.mkdirSync(opts.homeDir, { recursive: true });
  var env = Object.assign({}, process.env, {
    HOME: opts.homeDir,
    CLAY_HOME: opts.homeDir,
  });
  var cwd = opts.projectDir && fs.existsSync(opts.projectDir) ? opts.projectDir : process.cwd();
  return spawnSync(process.execPath, [CLI].concat(extraArgs), {
    cwd: cwd,
    env: env,
    stdio: "inherit",
  });
}

function cmdStart(opts) {
  fs.mkdirSync(opts.projectDir, { recursive: true });
  console.log("==> HOME=" + opts.homeDir + " (isolated)");
  console.log("==> CLAY_HOME=" + opts.homeDir);
  console.log("==> project=" + opts.projectDir + " (cwd, auto-registered)");
  console.log("==> http://" + opts.host + ":" + opts.port + "/   PIN " + opts.pin);
  var r = runCli(opts, [
    "--headless",
    "--yes",
    "--pin", opts.pin,
    "--port", opts.port,
    "--host", opts.host,
    "--no-https",
    "--no-update",
    "--dangerously-skip-permissions",
  ]);
  if (r.status !== 0) {
    console.error("daemon failed to start (status=" + r.status + ")");
    process.exit(r.status || 1);
  }
  console.log("==> stop: node scripts/dev-isolated-daemon.js stop --home " + opts.homeDir);
}

function cmdStop(opts) {
  console.log("==> shutting down daemon at HOME=" + opts.homeDir);
  runCli(opts, ["--shutdown"]);
}

function cmdStatus(opts) {
  runCli(opts, ["--list"]);
}

function cmdWipe(opts) {
  cmdStop(opts);
  if (fs.existsSync(opts.homeDir)) {
    fs.rmSync(opts.homeDir, { recursive: true, force: true });
    console.log("==> removed " + opts.homeDir);
  } else {
    console.log("==> already gone: " + opts.homeDir);
  }
}

function printHelp() {
  console.log("Usage:");
  console.log("  node scripts/dev-isolated-daemon.js <start|stop|status|wipe> [options]");
  console.log("");
  console.log("Options:");
  console.log("  --home DIR      Isolated HOME and CLAY_HOME (default: $TMPDIR/clay-isolated-home)");
  console.log("  --project DIR   Project directory the daemon will register on startup");
  console.log("                  (default: $TMPDIR/clay-isolated-project)");
  console.log("  --port N        HTTP port (default: 12700)");
  console.log("  --pin PIN       Six-digit PIN (default: 123456)");
  console.log("  --host ADDR     Bind address (default: 127.0.0.1)");
  console.log("");
  console.log("Examples:");
  console.log("  npm run dev:isolated -- start --project /tmp/my-fixtures");
  console.log("  npm run dev:isolated -- stop");
  console.log("  npm run dev:isolated -- wipe   # stop + remove home dir");
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { printHelp(); return; }
  var opts = withDefaults(args);
  switch (opts.cmd) {
    case "start": return cmdStart(opts);
    case "stop": return cmdStop(opts);
    case "status": return cmdStatus(opts);
    case "wipe": return cmdWipe(opts);
    default: printHelp(); process.exit(1);
  }
}

main();
