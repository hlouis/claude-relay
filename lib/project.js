var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var { createSessionManager } = require("./sessions");
var { createAgentBackend, getBackendCapabilities } = require("./agent-backend");
var { createBackendRegistry } = require("./backend-registry");
var codexBackendModule = require("./codex-backend");
var { createTerminalManager } = require("./terminal-manager");
var { createNotesManager } = require("./notes");
var { fetchLatestVersion, fetchVersion, isNewer } = require("./updater");
var { execFileSync, spawn } = require("child_process");
var { createLoopRegistry } = require("./scheduler");
var usersModule = require("./users");
var { resolveOsUserInfo, fsAsUser } = require("./os-users");

var MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// Validate environment variable string (KEY=VALUE per line)
// Returns null if valid, or an error string if invalid
function validateEnvString(str) {
  if (!str || !str.trim()) return null;
  var lines = str.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === "#") continue;
    // Must be KEY=VALUE format
    var eqIdx = line.indexOf("=");
    if (eqIdx < 1) return "Invalid format at line " + (i + 1) + ": expected KEY=VALUE";
    var key = line.substring(0, eqIdx);
    // Key must be valid env var name (no shell metacharacters)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      return "Invalid variable name at line " + (i + 1) + ": " + key;
    }
    // Value must not contain shell injection characters
    var value = line.substring(eqIdx + 1);
    if (/[`$\\;|&><(){}\n]/.test(value) && !/^["'].*["']$/.test(value)) {
      return "Potentially unsafe value at line " + (i + 1) + ": shell metacharacters detected";
    }
  }
  return null;
}

// SDK loaded dynamically (ESM module)
var sdkModule = null;
function getSDK() {
  if (!sdkModule) sdkModule = import("@anthropic-ai/claude-agent-sdk");
  return sdkModule;
}

// Cheap host-level probe surfaced to the dashboard so the New Project modal
// can render the Codex backend chip in the right state. Cached for a short
// window because both calls touch the filesystem; we never want to re-stat
// `~/.codex/auth.json` on every WS connection.
var _codexInfoCache = null;
var _codexInfoCacheAt = 0;
function computeCodexAvailability() {
  var now = Date.now();
  if (_codexInfoCache && now - _codexInfoCacheAt < 5000) return _codexInfoCache;
  var binPath = codexBackendModule.findCodexBinary();
  // findCodexBinary returns "codex" as a fallback when nothing exists on disk.
  // Treat that fallback as "not found" so the UI doesn't promise availability
  // we can't deliver.
  var binAvailable = binPath !== "codex" || (function () {
    try { require("child_process").execFileSync("which", ["codex"], { stdio: "ignore" }); return true; }
    catch (e) { return false; }
  })();
  var auth = codexBackendModule.checkCodexAuth();
  _codexInfoCache = {
    binAvailable: !!binAvailable,
    binPath: binAvailable ? binPath : null,
    authOk: !!(auth && auth.ok),
    authCode: auth && !auth.ok ? auth.code : null,
    authMessage: auth && !auth.ok ? auth.message : null,
  };
  _codexInfoCacheAt = now;
  return _codexInfoCache;
}

// --- Shared constants ---
var IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "__pycache__", ".cache", "dist", "build", ".clay", ".claude-relay"]);
var BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".pyc", ".o", ".a", ".class",
]);
var IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
var FS_MAX_SIZE = 512 * 1024;
var MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function safePath(base, requested) {
  var resolved = path.resolve(base, requested);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  try {
    var real = fs.realpathSync(resolved);
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    return real;
  } catch (e) {
    return null;
  }
}

/**
 * Create a project context — per-project state and handlers.
 * opts: { cwd, slug, title, pushModule, debug, dangerouslySkipPermissions, currentVersion }
 */
function createProjectContext(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug;
  var project = path.basename(cwd);
  var title = opts.title || null;
  var icon = opts.icon || null;
  var pushModule = opts.pushModule || null;
  var debug = opts.debug || false;
  var dangerouslySkipPermissions = opts.dangerouslySkipPermissions || false;
  var backend = opts.backend || "claude"; // agent backend: "claude" | "codex" (codex lands in iter 1)
  // Iter 4 follow-up: codex per-project settings persisted in daemon.json.
  // The daemon owns the file write; we just thread the snapshot down to
  // the backend for seeding, and a callback up for setter-driven updates.
  var initialCodexConfig = opts.codexConfig || null;
  var persistCodexConfig = (typeof opts.persistCodexConfig === "function")
    ? opts.persistCodexConfig
    : function () {};
  var currentVersion = opts.currentVersion;
  var lanHost = opts.lanHost || null;
  var getProjectCount = opts.getProjectCount || function () { return 1; };
  var getProjectList = opts.getProjectList || function () { return []; };
  var getHubSchedules = opts.getHubSchedules || function () { return []; };
  var moveScheduleToProject = opts.moveScheduleToProject || function () { return { ok: false, error: "Not supported" }; };
  var moveAllSchedulesToProject = opts.moveAllSchedulesToProject || function () { return { ok: false, error: "Not supported" }; };
  var getScheduleCount = opts.getScheduleCount || function () { return 0; };
  var onProcessingChanged = opts.onProcessingChanged || function () {};
  var onSessionDone = opts.onSessionDone || function () {};
  var onPresenceChange = opts.onPresenceChange || function () {};
  var updateChannel = opts.updateChannel || "stable";
  var osUsers = opts.osUsers || false;
  var projectOwnerId = opts.projectOwnerId || null;
  var worktreeMeta = opts.worktreeMeta || null; // { parentSlug, branch, accessible }
  var onCreateWorktree = opts.onCreateWorktree || null;
  var latestVersion = null;

  // --- OS-level user isolation helper ---
  // Returns the Linux username for the session owner.
  // Each session uses its own owner's Claude account and credits.
  function getLinuxUserForSession(session) {
    if (!osUsers) return null;
    if (!session.ownerId) return null;
    var user = usersModule.findUserById(session.ownerId);
    if (!user || !user.linuxUser) return null;
    return user.linuxUser;
  }

  function getLinuxUserForWs(ws) {
    if (!osUsers) return null;
    if (!ws._clayUser || !ws._clayUser.linuxUser) return null;
    return ws._clayUser.linuxUser;
  }

  // Cache resolved OS user info to avoid repeated getent calls
  var osUserInfoCache = {};
  function getOsUserInfoForWs(ws) {
    var linuxUser = getLinuxUserForWs(ws);
    if (!linuxUser) return null;
    if (osUserInfoCache[linuxUser]) return osUserInfoCache[linuxUser];
    try {
      var info = resolveOsUserInfo(linuxUser);
      osUserInfoCache[linuxUser] = info;
      return info;
    } catch (e) {
      console.error("[project] Failed to resolve OS user info for " + linuxUser + ":", e.message);
      return null;
    }
  }

  function getOsUserInfoForReq(req) {
    if (!osUsers) return null;
    if (!req._clayUser || !req._clayUser.linuxUser) return null;
    var linuxUser = req._clayUser.linuxUser;
    if (osUserInfoCache[linuxUser]) return osUserInfoCache[linuxUser];
    try {
      var info = resolveOsUserInfo(linuxUser);
      osUserInfoCache[linuxUser] = info;
      return info;
    } catch (e) {
      console.error("[project] Failed to resolve OS user info for " + linuxUser + ":", e.message);
      return null;
    }
  }

  // --- Per-project clients ---
  var clients = new Set();

  function send(obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  function sendTo(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function sendToAdmins(obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws.readyState === 1 && ws._clayUser && ws._clayUser.role === "admin") ws.send(data);
    }
  }

  function broadcastClientCount() {
    var msg = { type: "client_count", count: clients.size };
    if (usersModule.isMultiUser()) {
      var seen = {};
      var userList = [];
      for (var c of clients) {
        if (!c._clayUser) continue;
        var u = c._clayUser;
        if (seen[u.id]) continue;
        seen[u.id] = true;
        var p = u.profile || {};
        userList.push({
          id: u.id,
          displayName: p.name || u.displayName || u.username,
          username: u.username,
          avatarStyle: p.avatarStyle || "thumbs",
          avatarSeed: p.avatarSeed || u.username,
        });
      }
      msg.users = userList;
    }
    send(msg);
    onPresenceChange();
  }

  function sendToOthers(sender, obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws !== sender && ws.readyState === 1) ws.send(data);
    }
  }

  function sendToSession(sessionId, obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws.readyState === 1 && ws._clayActiveSession === sessionId) {
        ws.send(data);
      }
    }
  }

  function sendToSessionOthers(sender, sessionId, obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws !== sender && ws.readyState === 1 && ws._clayActiveSession === sessionId) {
        ws.send(data);
      }
    }
  }

  // --- File watcher ---
  var fileWatcher = null;
  var watchedPath = null;
  var watchDebounce = null;

  function startFileWatch(relPath) {
    var absPath = safePath(cwd, relPath);
    if (!absPath) return;
    if (watchedPath === relPath) return;
    stopFileWatch();
    watchedPath = relPath;
    try {
      fileWatcher = fs.watch(absPath, function () {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(function () {
          try {
            var stat = fs.statSync(absPath);
            var ext = path.extname(absPath).toLowerCase();
            if (stat.size > FS_MAX_SIZE || BINARY_EXTS.has(ext)) return;
            var content = fs.readFileSync(absPath, "utf8");
            send({ type: "fs_file_changed", path: relPath, content: content, size: stat.size });
          } catch (e) {
            stopFileWatch();
          }
        }, 200);
      });
      fileWatcher.on("error", function () { stopFileWatch(); });
    } catch (e) {
      watchedPath = null;
    }
  }

  function stopFileWatch() {
    if (fileWatcher) {
      try { fileWatcher.close(); } catch (e) {}
      fileWatcher = null;
    }
    clearTimeout(watchDebounce);
    watchDebounce = null;
    watchedPath = null;
  }

  // --- Directory watcher ---
  var dirWatchers = {};  // relPath -> { watcher, debounce }

  function startDirWatch(relPath) {
    if (dirWatchers[relPath]) return;
    var absPath = safePath(cwd, relPath);
    if (!absPath) return;
    try {
      var debounce = null;
      var watcher = fs.watch(absPath, function () {
        clearTimeout(debounce);
        debounce = setTimeout(function () {
          // Re-read directory and broadcast to all clients
          try {
            var items = fs.readdirSync(absPath, { withFileTypes: true });
            var entries = [];
            for (var i = 0; i < items.length; i++) {
              if (items[i].isDirectory() && IGNORED_DIRS.has(items[i].name)) continue;
              entries.push({
                name: items[i].name,
                type: items[i].isDirectory() ? "dir" : "file",
                path: path.relative(cwd, path.join(absPath, items[i].name)).split(path.sep).join("/"),
              });
            }
            send({ type: "fs_dir_changed", path: relPath, entries: entries });
          } catch (e) {
            stopDirWatch(relPath);
          }
        }, 300);
      });
      watcher.on("error", function () { stopDirWatch(relPath); });
      dirWatchers[relPath] = { watcher: watcher, debounce: debounce };
    } catch (e) {}
  }

  function stopDirWatch(relPath) {
    var entry = dirWatchers[relPath];
    if (entry) {
      clearTimeout(entry.debounce);
      try { entry.watcher.close(); } catch (e) {}
      delete dirWatchers[relPath];
    }
  }

  function stopAllDirWatches() {
    var paths = Object.keys(dirWatchers);
    for (var i = 0; i < paths.length; i++) {
      stopDirWatch(paths[i]);
    }
  }

  // --- Session manager ---
  var sm = createSessionManager({
    cwd: cwd,
    send: send,
    sendTo: sendTo,
    sendEach: function (fn) {
      for (var ws of clients) {
        var user = ws._clayUser;
        var filterFn = null;
        if (usersModule.isMultiUser() && user) {
          filterFn = (function (u) {
            return function (s) {
              return usersModule.canAccessSession(u.id, s, { visibility: "public" });
            };
          })(user);
        }
        fn(ws, filterFn);
      }
    },
    // Resolves the project's CURRENT default backend at the moment a new
    // session is created. Sessions stamp this once at birth and treat it
    // as immutable thereafter (see sessions.js). Today `backend` is fixed
    // for the project's lifetime; iter 4 will make it user-mutable, at
    // which point this getter returns the latest value automatically.
    getProjectBackend: function () { return backend; },
    // Iter 3: lets session_switched embed the right capabilities for the
    // session's backend so the frontend can re-gate UI without a
    // round-trip. Pure function — no side effects, no async.
    getCapabilitiesFor: function (backendName) { return getBackendCapabilities(backendName); },
    onSessionDone: onSessionDone,
  });
  var _projMode = typeof opts.onGetProjectDefaultMode === "function" ? opts.onGetProjectDefaultMode(slug) : null;
  var _srvMode = typeof opts.onGetServerDefaultMode === "function" ? opts.onGetServerDefaultMode() : null;
  sm.currentPermissionMode = (_projMode && _projMode.mode) || (_srvMode && _srvMode.mode) || "default";

  var _projEffort = typeof opts.onGetProjectDefaultEffort === "function" ? opts.onGetProjectDefaultEffort(slug) : null;
  var _srvEffort = typeof opts.onGetServerDefaultEffort === "function" ? opts.onGetServerDefaultEffort() : null;
  sm.currentEffort = (_projEffort && _projEffort.effort) || (_srvEffort && _srvEffort.effort) || "medium";

  var _projModel = typeof opts.onGetProjectDefaultModel === "function" ? opts.onGetProjectDefaultModel(slug) : null;
  var _srvModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel() : null;
  sm._savedDefaultModel = (_projModel && _projModel.model) || (_srvModel && _srvModel.model) || null;

  // --- Agent backends (Claude / Codex), lazy-instantiated per project ---
  //
  // Iter 2: a project may host sessions of more than one backend (today
  // it doesn't because project.backend is still immutable, but iter 4
  // unlocks that). The session's backend is its frozen identity (iter 1),
  // so every operation routes to the SDK that matches `session.backend`,
  // never to a single project-level SDK.
  //
  // Lazy-init policy: spin up an SDK only on first use. Today this means
  // exactly one SDK per project (the project default). Post-iter-4 a
  // second backend boots only when its first session actually runs. We
  // do NOT pre-warm the non-default backend — it pays the warmup cost
  // on first send, which is acceptable and avoids wasted resources.
  //
  // The map + lazy create + non-instantiating peek live in their own
  // module (lib/backend-registry.js) so the contract can be unit-tested
  // without standing up an entire project.
  var _backendRegistry = createBackendRegistry({
    defaultBackend: backend,
    factory: function (name) {
      return createAgentBackend({
        backend: name,
        cwd: cwd,
        slug: slug,
        sessionManager: sm,
        send: send,
        pushModule: pushModule,
        getSDK: getSDK,
        dangerouslySkipPermissions: dangerouslySkipPermissions,
        onProcessingChanged: onProcessingChanged,
        // Codex-only seeds. Harmless to Claude (it ignores unknown opts).
        // We only thread the persisted config into the codex slot —
        // a Claude SDK has no use for sandbox/approvalPolicy.
        codexConfig: name === "codex" ? initialCodexConfig : null,
        onCodexConfigChange: name === "codex"
          ? function (snapshot) { persistCodexConfig(snapshot); }
          : function () {},
      });
    },
  });

  // Convenience wrappers so the call sites read naturally:
  //   - sdkForSession(session): route by session's frozen backend identity.
  //     With a session in scope this is ALWAYS the right answer; we never
  //     read project.backend here (would defeat iter 1's frozen invariant).
  //   - defaultSdk(): for project-scoped ops with no session (warmup, info
  //     broadcasts, codex_config echo).
  //   - hasBackend(name): non-instantiating check, used by kill_process to
  //     refuse without spinning up a Claude SDK in a never-Claude project.
  function sdkForSession(session) { return _backendRegistry.sdkForSession(session); }
  function defaultSdk() { return _backendRegistry.defaultSdk(); }
  function hasBackend(name) { return _backendRegistry.hasBackend(name); }

  // --- Ralph Loop state ---
  var loopState = {
    active: false,
    phase: "idle", // idle | crafting | approval | executing | done
    promptText: "",
    judgeText: "",
    iteration: 0,
    maxIterations: 20,
    baseCommit: null,
    currentSessionId: null,
    judgeSessionId: null,
    results: [],
    stopping: false,
    wizardData: null,
    craftingSessionId: null,
    startedAt: null,
    loopId: null,
  };

  function loopDir() {
    if (!loopState.loopId) return null;
    return path.join(cwd, ".claude", "loops", loopState.loopId);
  }

  function generateLoopId() {
    return "loop_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
  }

  // Loop state persistence
  var _loopConfig = require("./config");
  var _loopUtils = require("./utils");
  var _loopDir = path.join(_loopConfig.CONFIG_DIR, "loops");
  var _loopEncodedCwd = _loopUtils.resolveEncodedFile(_loopDir, cwd, ".json");
  var _loopStatePath = path.join(_loopDir, _loopEncodedCwd + ".json");

  function saveLoopState() {
    try {
      fs.mkdirSync(_loopDir, { recursive: true });
      var data = {
        phase: loopState.phase,
        active: loopState.active,
        iteration: loopState.iteration,
        maxIterations: loopState.maxIterations,
        baseCommit: loopState.baseCommit,
        results: loopState.results,
        wizardData: loopState.wizardData,
        startedAt: loopState.startedAt,
        loopId: loopState.loopId,
      };
      var tmpPath = _loopStatePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, _loopStatePath);
    } catch (e) {
      console.error("[ralph-loop] Failed to save state:", e.message);
    }
  }

  function loadLoopState() {
    try {
      var raw = fs.readFileSync(_loopStatePath, "utf8");
      var data = JSON.parse(raw);
      loopState.phase = data.phase || "idle";
      loopState.active = data.active || false;
      loopState.iteration = data.iteration || 0;
      loopState.maxIterations = data.maxIterations || 20;
      loopState.baseCommit = data.baseCommit || null;
      loopState.results = data.results || [];
      loopState.wizardData = data.wizardData || null;
      loopState.startedAt = data.startedAt || null;
      loopState.loopId = data.loopId || null;
      // SDK sessions cannot survive daemon restart
      loopState.currentSessionId = null;
      loopState.judgeSessionId = null;
      loopState.craftingSessionId = null;
      loopState.stopping = false;
      // If was executing, schedule resume after SDK is ready
      if (loopState.phase === "executing" && loopState.active) {
        loopState._needsResume = true;
      }
      // If was crafting, check if files exist and move to approval
      if (loopState.phase === "crafting") {
        var hasFiles = checkLoopFilesExist();
        if (hasFiles) {
          loopState.phase = "approval";
          saveLoopState();
        } else {
          loopState.phase = "idle";
          saveLoopState();
        }
      }
    } catch (e) {
      // No saved state, use defaults
    }
    // Recover orphaned loops: if idle but completed loop files exist in .claude/loops/
    if (loopState.phase === "idle") {
      var _loopsBase = path.join(cwd, ".claude", "loops");
      try {
        var _loopDirs = fs.readdirSync(_loopsBase).filter(function (d) {
          return d.indexOf("loop_") === 0;
        });
        for (var _li = 0; _li < _loopDirs.length; _li++) {
          var _ld = path.join(_loopsBase, _loopDirs[_li]);
          try {
            fs.accessSync(path.join(_ld, "PROMPT.md"));
            fs.accessSync(path.join(_ld, "JUDGE.md"));
            fs.accessSync(path.join(_ld, "LOOP.json"));
            // Found a completed loop — recover to approval phase
            loopState.loopId = _loopDirs[_li];
            loopState.phase = "approval";
            var _loopCfg = JSON.parse(fs.readFileSync(path.join(_ld, "LOOP.json"), "utf8"));
            loopState.maxIterations = _loopCfg.maxIterations || 20;
            saveLoopState();
            console.log("[ralph-loop] Recovered orphaned loop: " + _loopDirs[_li]);
            break;
          } catch (e) {}
        }
      } catch (e) {}
    }
  }

  function clearLoopState() {
    loopState.active = false;
    loopState.phase = "idle";
    loopState.promptText = "";
    loopState.judgeText = "";
    loopState.iteration = 0;
    loopState.maxIterations = 20;
    loopState.baseCommit = null;
    loopState.currentSessionId = null;
    loopState.judgeSessionId = null;
    loopState.results = [];
    loopState.stopping = false;
    loopState.wizardData = null;
    loopState.craftingSessionId = null;
    loopState.startedAt = null;
    loopState.loopId = null;
    saveLoopState();
  }

  function checkLoopFilesExist() {
    var dir = loopDir();
    if (!dir) return false;
    var hasPrompt = false;
    var hasJudge = false;
    try { fs.accessSync(path.join(dir, "PROMPT.md")); hasPrompt = true; } catch (e) {}
    try { fs.accessSync(path.join(dir, "JUDGE.md")); hasJudge = true; } catch (e) {}
    return hasPrompt && hasJudge;
  }

  // .claude/ directory watcher for PROMPT.md / JUDGE.md
  var claudeDirWatcher = null;
  var claudeDirDebounce = null;

  function startClaudeDirWatch() {
    if (claudeDirWatcher) return;
    var watchDir = loopDir();
    if (!watchDir) return;
    try { fs.mkdirSync(watchDir, { recursive: true }); } catch (e) {}
    try {
      claudeDirWatcher = fs.watch(watchDir, function () {
        if (claudeDirDebounce) clearTimeout(claudeDirDebounce);
        claudeDirDebounce = setTimeout(function () {
          broadcastLoopFilesStatus();
        }, 300);
      });
      claudeDirWatcher.on("error", function () {});
    } catch (e) {
      console.error("[ralph-loop] Failed to watch .claude/:", e.message);
    }
  }

  function stopClaudeDirWatch() {
    if (claudeDirWatcher) {
      claudeDirWatcher.close();
      claudeDirWatcher = null;
    }
    if (claudeDirDebounce) {
      clearTimeout(claudeDirDebounce);
      claudeDirDebounce = null;
    }
  }

  function broadcastLoopFilesStatus() {
    var dir = loopDir();
    var hasPrompt = false;
    var hasJudge = false;
    var hasLoopJson = false;
    if (dir) {
      try { fs.accessSync(path.join(dir, "PROMPT.md")); hasPrompt = true; } catch (e) {}
      try { fs.accessSync(path.join(dir, "JUDGE.md")); hasJudge = true; } catch (e) {}
      try { fs.accessSync(path.join(dir, "LOOP.json")); hasLoopJson = true; } catch (e) {}
    }
    send({
      type: "ralph_files_status",
      promptReady: hasPrompt,
      judgeReady: hasJudge,
      loopJsonReady: hasLoopJson,
      bothReady: hasPrompt && hasJudge,
      taskId: loopState.loopId,
    });
    // Auto-transition to approval phase when both files appear
    if (hasPrompt && hasJudge && loopState.phase === "crafting") {
      loopState.phase = "approval";
      saveLoopState();

      // Parse recommended title from crafting session conversation
      if (loopState.craftingSessionId && loopState.loopId) {
        var craftSess = sm.sessions.get(loopState.craftingSessionId);
        if (craftSess && craftSess.history) {
          for (var hi = craftSess.history.length - 1; hi >= 0; hi--) {
            var entry = craftSess.history[hi];
            var entryText = entry.text || "";
            var titleMatch = entryText.match(/\[\[LOOP_TITLE:\s*(.+?)\]\]/);
            if (titleMatch) {
              var suggestedTitle = titleMatch[1].trim();
              if (suggestedTitle) {
                loopRegistry.updateRecord(loopState.loopId, { name: suggestedTitle });
              }
              break;
            }
          }
        }
      }
    }
  }

  // Load persisted state on startup
  loadLoopState();

  // --- Loop Registry (unified one-off + scheduled) ---
  var activeRegistryId = null; // track which registry record triggered current loop

  var loopRegistry = createLoopRegistry({
    cwd: cwd,
    onTrigger: function (record) {
      // Only trigger if no loop is currently active
      if (loopState.active || loopState.phase === "executing") {
        console.log("[loop-registry] Skipping trigger — loop already active");
        return;
      }

      // For schedule records, resolve the linked task to get loop files
      var loopId = record.id;
      if (record.source === "schedule") {
        if (!record.linkedTaskId) {
          console.error("[loop-registry] Schedule has no linked task: " + record.name);
          return;
        }
        loopId = record.linkedTaskId;
        console.log("[loop-registry] Schedule triggered: " + record.name + " → linked task " + loopId);
      }

      // Verify the loop directory and files exist
      var recDir = path.join(cwd, ".claude", "loops", loopId);
      try {
        fs.accessSync(path.join(recDir, "PROMPT.md"));
        fs.accessSync(path.join(recDir, "JUDGE.md"));
      } catch (e) {
        console.error("[loop-registry] Loop files missing for " + loopId);
        return;
      }
      // Set the loopId and start
      loopState.loopId = loopId;
      activeRegistryId = record.id;
      console.log("[loop-registry] Auto-starting loop: " + record.name + " (" + loopId + ")");
      send({ type: "schedule_run_started", recordId: record.id });
      startLoop();
    },
    onChange: function () {
      send({ type: "loop_registry_updated", records: getHubSchedules() });
    },
  });
  loopRegistry.load();
  loopRegistry.startTimer();

  // Wire loop info resolution for session list broadcasts
  sm.setResolveLoopInfo(function (loopId) {
    var rec = loopRegistry.getById(loopId);
    if (!rec) return null;
    return { name: rec.name || null, source: rec.source || null };
  });

  function startLoop(opts) {
    var loopOpts = opts || {};
    var dir = loopDir();
    if (!dir) {
      send({ type: "loop_error", text: "No loop directory. Run the wizard first." });
      return;
    }
    var promptPath = path.join(dir, "PROMPT.md");
    var judgePath = path.join(dir, "JUDGE.md");
    var promptText, judgeText;
    try {
      promptText = fs.readFileSync(promptPath, "utf8");
    } catch (e) {
      send({ type: "loop_error", text: "Missing PROMPT.md in " + dir });
      return;
    }
    try {
      judgeText = fs.readFileSync(judgePath, "utf8");
    } catch (e) {
      send({ type: "loop_error", text: "Missing JUDGE.md in " + dir });
      return;
    }

    var baseCommit;
    try {
      baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: cwd, encoding: "utf8", timeout: 5000,
      }).trim();
    } catch (e) {
      send({ type: "loop_error", text: "Failed to get git HEAD: " + e.message });
      return;
    }

    // Read loop config from LOOP.json in loop directory
    var loopConfig = {};
    try {
      loopConfig = JSON.parse(fs.readFileSync(path.join(dir, "LOOP.json"), "utf8"));
    } catch (e) {}

    loopState.active = true;
    loopState.phase = "executing";
    loopState.promptText = promptText;
    loopState.judgeText = judgeText;
    loopState.iteration = 0;
    loopState.maxIterations = loopConfig.maxIterations || loopOpts.maxIterations || 20;
    loopState.baseCommit = baseCommit;
    loopState.currentSessionId = null;
    loopState.judgeSessionId = null;
    loopState.results = [];
    loopState.stopping = false;
    loopState.startedAt = Date.now();
    saveLoopState();

    stopClaudeDirWatch();

    send({ type: "loop_started", maxIterations: loopState.maxIterations });
    runNextIteration();
  }

  function runNextIteration() {
    console.log("[ralph-loop] runNextIteration called, iteration: " + loopState.iteration + ", active: " + loopState.active + ", stopping: " + loopState.stopping);
    if (!loopState.active || loopState.stopping) {
      finishLoop("stopped");
      return;
    }

    loopState.iteration++;
    if (loopState.iteration > loopState.maxIterations) {
      finishLoop("max_iterations");
      return;
    }

    var session = sm.createSession();
    var loopName = (loopState.wizardData && loopState.wizardData.name) || "";
    var loopSource = loopRegistry.getById(loopState.loopId);
    var loopSourceTag = (loopSource && loopSource.source) || null;
    var isRalphLoop = loopSourceTag === "ralph";
    session.loop = { active: true, iteration: loopState.iteration, role: "coder", loopId: loopState.loopId, name: loopName, source: loopSourceTag, startedAt: loopState.startedAt };
    session.title = (isRalphLoop ? "Ralph" : "Task") + (loopName ? " " + loopName : "") + " #" + loopState.iteration;
    sm.saveSessionFile(session);
    sm.broadcastSessionList();

    loopState.currentSessionId = session.localId;

    send({
      type: "loop_iteration",
      iteration: loopState.iteration,
      maxIterations: loopState.maxIterations,
      sessionId: session.localId,
    });

    session.onQueryComplete = function(completedSession) {
      console.log("[ralph-loop] Coder #" + loopState.iteration + " onQueryComplete fired, history length: " + completedSession.history.length);
      if (!loopState.active) { console.log("[ralph-loop] Coder: loopState.active is false, skipping"); return; }
      // Check if session ended with error
      var lastItems = completedSession.history.slice(-3);
      var hadError = false;
      for (var i = 0; i < lastItems.length; i++) {
        if (lastItems[i].type === "error" || (lastItems[i].type === "done" && lastItems[i].code === 1)) {
          hadError = true;
          break;
        }
      }
      if (hadError) {
        loopState.results.push({
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Iteration ended with error",
        });
        send({
          type: "loop_verdict",
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Iteration ended with error, retrying...",
        });
        setTimeout(function() { runNextIteration(); }, 2000);
        return;
      }
      runJudge();
    };

    var userMsg = { type: "user_message", text: loopState.promptText };
    session.history.push(userMsg);
    sm.appendToSessionFile(session, userMsg);

    session.isProcessing = true;
    onProcessingChanged();
    session.sentToolResults = {};
    sendToSession(session.localId, { type: "status", status: "processing" });
    session.acceptEditsAfterStart = true;
    session.singleTurn = true;
    sdkForSession(session).startQuery(session, loopState.promptText, undefined, getLinuxUserForSession(session));
  }

  function runJudge() {
    if (!loopState.active || loopState.stopping) {
      finishLoop("stopped");
      return;
    }

    var diff;
    try {
      diff = execFileSync("git", ["diff", loopState.baseCommit], {
        cwd: cwd, encoding: "utf8", timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (e) {
      send({ type: "loop_error", text: "Failed to generate git diff: " + e.message });
      finishLoop("error");
      return;
    }

    var judgePrompt = "You are a judge evaluating whether a coding task has been completed.\n\n" +
      "## Original Task (PROMPT.md)\n\n" + loopState.promptText + "\n\n" +
      "## Evaluation Criteria (JUDGE.md)\n\n" + loopState.judgeText + "\n\n" +
      "## Changes Made (git diff)\n\n```diff\n" + diff + "\n```\n\n" +
      "Based on the evaluation criteria, has the task been completed successfully?\n\n" +
      "Respond with exactly one of:\n" +
      "- PASS: [brief explanation]\n" +
      "- FAIL: [brief explanation of what is still missing]\n\n" +
      "Do NOT use any tools. Just analyze and respond.";

    var judgeSession = sm.createSession();
    var judgeName = (loopState.wizardData && loopState.wizardData.name) || "";
    var judgeSource = loopRegistry.getById(loopState.loopId);
    var judgeSourceTag = (judgeSource && judgeSource.source) || null;
    var isRalphJudge = judgeSourceTag === "ralph";
    judgeSession.loop = { active: true, iteration: loopState.iteration, role: "judge", loopId: loopState.loopId, name: judgeName, source: judgeSourceTag, startedAt: loopState.startedAt };
    judgeSession.title = (isRalphJudge ? "Ralph" : "Task") + (judgeName ? " " + judgeName : "") + " Judge #" + loopState.iteration;
    sm.saveSessionFile(judgeSession);
    sm.broadcastSessionList();
    loopState.judgeSessionId = judgeSession.localId;

    send({
      type: "loop_judging",
      iteration: loopState.iteration,
      sessionId: judgeSession.localId,
    });

    judgeSession.onQueryComplete = function(completedSession) {
      console.log("[ralph-loop] Judge #" + loopState.iteration + " onQueryComplete fired, history length: " + completedSession.history.length);
      var verdict = parseJudgeVerdict(completedSession);
      console.log("[ralph-loop] Judge verdict: " + (verdict.pass ? "PASS" : "FAIL") + " - " + verdict.explanation);

      loopState.results.push({
        iteration: loopState.iteration,
        verdict: verdict.pass ? "pass" : "fail",
        summary: verdict.explanation,
      });

      send({
        type: "loop_verdict",
        iteration: loopState.iteration,
        verdict: verdict.pass ? "pass" : "fail",
        summary: verdict.explanation,
      });

      if (verdict.pass) {
        finishLoop("pass");
      } else {
        setTimeout(function() { runNextIteration(); }, 1000);
      }
    };

    var userMsg = { type: "user_message", text: judgePrompt };
    judgeSession.history.push(userMsg);
    sm.appendToSessionFile(judgeSession, userMsg);

    judgeSession.isProcessing = true;
    onProcessingChanged();
    judgeSession.sentToolResults = {};
    judgeSession.acceptEditsAfterStart = true;
    judgeSession.singleTurn = true;
    sdkForSession(judgeSession).startQuery(judgeSession, judgePrompt, undefined, getLinuxUserForSession(judgeSession));
  }

  function parseJudgeVerdict(session) {
    var text = "";
    for (var i = 0; i < session.history.length; i++) {
      var h = session.history[i];
      if (h.type === "delta" && h.text) text += h.text;
      if (h.type === "text" && h.text) text += h.text;
    }
    console.log("[ralph-loop] Judge raw text (last 500 chars): " + text.slice(-500));
    var upper = text.toUpperCase();
    var passIdx = upper.indexOf("PASS");
    var failIdx = upper.indexOf("FAIL");
    if (passIdx !== -1 && (failIdx === -1 || passIdx < failIdx)) {
      var explanation = text.substring(passIdx + 4).replace(/^[\s:]+/, "").split("\n")[0].trim();
      return { pass: true, explanation: explanation || "Task completed" };
    }
    if (failIdx !== -1) {
      var explanation = text.substring(failIdx + 4).replace(/^[\s:]+/, "").split("\n")[0].trim();
      return { pass: false, explanation: explanation || "Task not yet complete" };
    }
    return { pass: false, explanation: "Could not parse judge verdict" };
  }

  function finishLoop(reason) {
    console.log("[ralph-loop] finishLoop called, reason: " + reason + ", iteration: " + loopState.iteration);
    loopState.active = false;
    loopState.phase = "done";
    loopState.stopping = false;
    loopState.currentSessionId = null;
    loopState.judgeSessionId = null;
    saveLoopState();

    send({
      type: "loop_finished",
      reason: reason,
      iterations: loopState.iteration,
      results: loopState.results,
    });

    // Record result in loop registry
    if (loopState.loopId) {
      loopRegistry.recordRun(loopState.loopId, {
        reason: reason,
        startedAt: loopState.startedAt,
        iterations: loopState.iteration,
      });
    }
    if (activeRegistryId) {
      send({ type: "schedule_run_finished", recordId: activeRegistryId, reason: reason, iterations: loopState.iteration });
      activeRegistryId = null;
    }

    if (pushModule) {
      var body = reason === "pass"
        ? "Task completed after " + loopState.iteration + " iteration(s)"
        : reason === "max_iterations"
          ? "Reached max iterations (" + loopState.maxIterations + ")"
          : reason === "stopped"
            ? "Loop stopped by user"
            : "Loop ended due to error";
      pushModule.sendPush({
        type: "done",
        slug: slug,
        title: "Ralph Loop Complete",
        body: body,
        tag: "ralph-loop-done",
      });
    }
  }

  function resumeLoop() {
    var dir = loopDir();
    if (!dir) {
      console.error("[ralph-loop] Cannot resume: no loop directory");
      loopState.active = false;
      loopState.phase = "idle";
      saveLoopState();
      return;
    }
    try {
      loopState.promptText = fs.readFileSync(path.join(dir, "PROMPT.md"), "utf8");
    } catch (e) {
      console.error("[ralph-loop] Cannot resume: missing PROMPT.md");
      loopState.active = false;
      loopState.phase = "idle";
      saveLoopState();
      return;
    }
    try {
      loopState.judgeText = fs.readFileSync(path.join(dir, "JUDGE.md"), "utf8");
    } catch (e) {
      console.error("[ralph-loop] Cannot resume: missing JUDGE.md");
      loopState.active = false;
      loopState.phase = "idle";
      saveLoopState();
      return;
    }
    // Retry the interrupted iteration (runNextIteration will increment)
    if (loopState.iteration > 0) {
      loopState.iteration--;
    }
    console.log("[ralph-loop] Resuming loop, next iteration will be " + (loopState.iteration + 1) + "/" + loopState.maxIterations);
    send({ type: "loop_started", maxIterations: loopState.maxIterations });
    runNextIteration();
  }

  function stopLoop() {
    if (!loopState.active) return;
    console.log("[ralph-loop] stopLoop called");
    loopState.stopping = true;

    // Abort all loop-related sessions (coder + judge)
    var sessionIds = [loopState.currentSessionId, loopState.judgeSessionId];
    for (var i = 0; i < sessionIds.length; i++) {
      if (sessionIds[i] == null) continue;
      var s = sm.sessions.get(sessionIds[i]);
      if (!s) continue;
      // End message queue so SDK exits prompt wait
      if (s.messageQueue) { try { s.messageQueue.end(); } catch (e) {} }
      // Abort active API call
      if (s.abortController) { try { s.abortController.abort(); } catch (e) {} }
    }

    send({ type: "loop_stopping" });

    // Fallback: force finish if onQueryComplete hasn't fired after 5s
    setTimeout(function() {
      if (loopState.active && loopState.stopping) {
        console.log("[ralph-loop] Stop fallback triggered — forcing finishLoop");
        finishLoop("stopped");
      }
    }, 5000);
  }

  // --- Terminal manager ---
  var tm = createTerminalManager({ cwd: cwd, send: send, sendTo: sendTo });
  var nm = createNotesManager({ cwd: cwd, send: send, sendTo: sendTo });

  // Check for updates in background (admin only)
  fetchVersion(updateChannel).then(function (v) {
    if (v && isNewer(v, currentVersion)) {
      latestVersion = v;
      sendToAdmins({ type: "update_available", version: v });
    }
  });

  // --- WS connection handler ---
  function handleConnection(ws, wsUser, resumeOpts) {
    ws._clayUser = wsUser || null;
    clients.add(ws);
    broadcastClientCount();

    // Resume loop if server restarted mid-execution (deferred so client gets initial state first)
    if (loopState._needsResume) {
      delete loopState._needsResume;
      setTimeout(function() { resumeLoop(); }, 500);
    }

    // Send cached state
    var _userId = ws._clayUser ? ws._clayUser.id : null;
    var _filteredProjects = getProjectList(_userId);
    var _codexInfo = computeCodexAvailability();
    // Iter 3: protocol split. `defaultBackend` is the project's default
    // (used by "Add new session" / setting UIs); `backend` is the active
    // session's frozen backend at the moment of this broadcast — that
    // governs body.backend-codex and capability-gated affordances. They
    // happen to be equal in single-backend projects (today's reality)
    // but the frontend already routes UI off whichever the active
    // session reports, so the split costs nothing and unlocks iter 4.
    var _activeSessionForInfo = sm.getActiveSession();
    var _activeBackend = (_activeSessionForInfo && _activeSessionForInfo.backend) || backend;
    sendTo(ws, { type: "info", cwd: cwd, slug: slug, project: title || project, version: currentVersion, debug: !!debug, dangerouslySkipPermissions: dangerouslySkipPermissions, osUsers: osUsers, lanHost: lanHost, projectCount: _filteredProjects.length, projects: _filteredProjects, projectOwnerId: projectOwnerId, backend: _activeBackend, defaultBackend: backend, codex: _codexInfo, capabilities: getBackendCapabilities(_activeBackend) });
    // Connect-time codex echo. Iter 4 follow-up:
    //
    // Iter 2 originally gated this on `backend === "codex"` (project
    // default) because that was the only case in which the codex SDK
    // could exist. Iter 1 froze session.backend; iter 4 lets project.backend
    // mutate. As a result, a project whose DEFAULT is Claude can host an
    // ACTIVE Codex session — and that session needs the codex_config + skills
    // echoes to render the input bar's `$skill` autocomplete and the
    // settings drawer's sandbox/approval controls.
    //
    // The right gate is therefore the active session's backend (already
    // computed above as `_activeBackend`), NOT the project default.
    //
    // Lazy-init implication: when the codex SDK was never spawned in this
    // project (e.g., user reloaded before sending the first message in a
    // freshly-created codex session), getSkills() / getCodexConfig() would
    // return null. We trigger a warmup so skills/list runs and the cache
    // populates — the resulting `codex_skills` broadcast from fetchSkills
    // catches the page up. Failures are best-effort: codex CLI missing /
    // unauthenticated already routes to the unavailable card.
    if (_activeBackend === "codex") {
      var _codexSdk = sdkForSession(_activeSessionForInfo);
      if (typeof _codexSdk.getCodexConfig === "function") {
        var _codexConfigSnap = _codexSdk.getCodexConfig();
        sendTo(ws, {
          type: "codex_config",
          sandbox: _codexConfigSnap.sandbox,
          approvalPolicy: _codexConfigSnap.approvalPolicy,
          model: _codexConfigSnap.model,
          effort: _codexConfigSnap.effort,
        });
      }
      // If the cache is empty AND the SDK exposes warmup, fire it now so
      // the next skill autocomplete has data. defaultSdk()'s warmup at
      // ctx.warmup() time only covers the project default backend; when
      // active session is codex but project default is claude, this is
      // the first opportunity to warm the codex SDK for this session.
      if (typeof _codexSdk.getSkills === "function") {
        var _skillsSnap = _codexSdk.getSkills();
        if (!_skillsSnap && typeof _codexSdk.warmup === "function") {
          _codexSdk.warmup().catch(function () { /* warmup logs internally */ });
        }
        if (_skillsSnap) {
          sendTo(ws, {
            type: "codex_skills",
            skills: _skillsSnap.skills,
            errors: _skillsSnap.errors,
            cwd: _skillsSnap.cwd,
            fetchedAt: _skillsSnap.fetchedAt,
          });
        }
      }
    }
    if (latestVersion && ws._clayUser && ws._clayUser.role === "admin") {
      sendTo(ws, { type: "update_available", version: latestVersion });
    }
    if (sm.slashCommands) {
      sendTo(ws, { type: "slash_commands", commands: sm.slashCommands });
    }
    if (sm.currentModel) {
      sendTo(ws, { type: "model_info", model: sm.currentModel, models: sm.availableModels || [] });
    }
    sendTo(ws, { type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
    sendTo(ws, { type: "term_list", terminals: tm.list() });
    sendTo(ws, { type: "notes_list", notes: nm.list() });
    sendTo(ws, { type: "loop_registry_updated", records: getHubSchedules() });

    // Ralph Loop availability
    var hasLoopFiles = false;
    try {
      fs.accessSync(path.join(cwd, ".claude", "PROMPT.md"));
      fs.accessSync(path.join(cwd, ".claude", "JUDGE.md"));
      hasLoopFiles = true;
    } catch (e) {}
    // Also check loop directory files
    if (!hasLoopFiles && loopState.loopId) {
      var _avDir = loopDir();
      if (_avDir) {
        try {
          fs.accessSync(path.join(_avDir, "PROMPT.md"));
          fs.accessSync(path.join(_avDir, "JUDGE.md"));
          hasLoopFiles = true;
        } catch (e) {}
      }
    }
    sendTo(ws, {
      type: "loop_available",
      available: hasLoopFiles,
      active: loopState.active,
      iteration: loopState.iteration,
      maxIterations: loopState.maxIterations,
    });

    // Ralph phase state
    sendTo(ws, {
      type: "ralph_phase",
      phase: loopState.phase,
      wizardData: loopState.wizardData,
      craftingSessionId: loopState.craftingSessionId || null,
    });
    if (loopState.phase === "crafting" || loopState.phase === "approval") {
      var _hasPrompt = false;
      var _hasJudge = false;
      var _lDir = loopDir();
      if (_lDir) {
        try { fs.accessSync(path.join(_lDir, "PROMPT.md")); _hasPrompt = true; } catch (e) {}
        try { fs.accessSync(path.join(_lDir, "JUDGE.md")); _hasJudge = true; } catch (e) {}
      }
      sendTo(ws, {
        type: "ralph_files_status",
        promptReady: _hasPrompt,
        judgeReady: _hasJudge,
        bothReady: _hasPrompt && _hasJudge,
        taskId: loopState.loopId,
      });
    }

    // Session list (filtered for access control)
    var allSessions = [].concat(Array.from(sm.sessions.values())).filter(function (s) { return !s.hidden; });
    if (usersModule.isMultiUser() && wsUser) {
      allSessions = allSessions.filter(function (s) {
        return usersModule.canAccessSession(wsUser.id, s, { visibility: "public" });
      });
    } else if (!usersModule.isMultiUser()) {
      allSessions = allSessions.filter(function (s) { return !s.ownerId; });
    }
    sendTo(ws, {
      type: "session_list",
      sessions: allSessions.map(function (s) {
        var loop = s.loop ? Object.assign({}, s.loop) : null;
        if (loop && loop.loopId && loopRegistry) {
          var rec = loopRegistry.getById(loop.loopId);
          if (rec) {
            if (rec.name) loop.name = rec.name;
            if (rec.source) loop.source = rec.source;
          }
        }
        return {
          id: s.localId,
          cliSessionId: s.cliSessionId || null,
          title: s.title || "New Session",
          active: s.localId === sm.activeSessionId,
          isProcessing: s.isProcessing,
          lastActivity: s.lastActivity || s.createdAt || 0,
          loop: loop,
          ownerId: s.ownerId || null,
          sessionVisibility: s.sessionVisibility || "shared",
        };
      }),
    });

    // Restore active session for this client (check access)
    var active = sm.getActiveSession();
    if (active && usersModule.isMultiUser() && wsUser) {
      if (!usersModule.canAccessSession(wsUser.id, active, { visibility: "public" })) {
        active = null;
      }
    } else if (active && !usersModule.isMultiUser() && active.ownerId) {
      active = null;
    }
    // Fallback: pick the most recent accessible session
    if (!active && allSessions.length > 0) {
      active = allSessions[0];
      for (var fi = 1; fi < allSessions.length; fi++) {
        if ((allSessions[fi].lastActivity || 0) > (active.lastActivity || 0)) {
          active = allSessions[fi];
        }
      }
    }
    // Auto-create a session if none exist for this client
    var autoCreated = false;
    if (!active) {
      var autoOpts = {};
      if (wsUser) autoOpts.ownerId = wsUser.id;
      active = sm.createSession(autoOpts, ws);
      autoCreated = true;
    }
    if (active && !autoCreated) {
      // Backfill ownerId for legacy sessions restored without one
      if (!active.ownerId && wsUser) {
        active.ownerId = wsUser.id;
        sm.saveSessionFile(active);
      }
      ws._clayActiveSession = active.localId;
      sendTo(ws, { type: "session_switched", id: active.localId, cliSessionId: active.cliSessionId || null, loop: active.loop || null });

      var total = active.history.length;
      // Incremental reconnect: if client already has history up to lastSeq for this session
      var canResume = resumeOpts
        && resumeOpts.sessionId === active.localId
        && typeof resumeOpts.lastSeq === "number"
        && resumeOpts.lastSeq >= 0
        && resumeOpts.lastSeq <= total;
      if (canResume) {
        // Send only messages after client's lastSeq
        var resumeFrom = resumeOpts.lastSeq;
        sendTo(ws, { type: "history_meta", total: total, from: resumeFrom, resumed: true });
        for (var i = resumeFrom; i < total; i++) {
          active.history[i].seq = i;
          sendTo(ws, active.history[i]);
        }
      } else {
        var fromIndex = 0;
        if (total > sm.HISTORY_PAGE_SIZE) {
          fromIndex = sm.findTurnBoundary(active.history, Math.max(0, total - sm.HISTORY_PAGE_SIZE));
        }
        sendTo(ws, { type: "history_meta", total: total, from: fromIndex });
        for (var i = fromIndex; i < total; i++) {
          active.history[i].seq = i;
          sendTo(ws, active.history[i]);
        }
      }
      // Include last usage data for context panel
      var hDoneMsg = { type: "history_done" };
      for (var uj = total - 1; uj >= 0; uj--) {
        if (active.history[uj].type === "result") {
          var ur = active.history[uj];
          hDoneMsg.lastUsage = ur.usage || null;
          hDoneMsg.lastModelUsage = ur.modelUsage || null;
          hDoneMsg.lastCost = ur.cost != null ? ur.cost : null;
          hDoneMsg.lastStreamInputTokens = ur.lastStreamInputTokens || null;
          break;
        }
      }
      sendTo(ws, hDoneMsg);

      if (active.isProcessing) {
        sendTo(ws, { type: "status", status: "processing" });
      }
      var pendingIds = Object.keys(active.pendingPermissions);
      for (var pi = 0; pi < pendingIds.length; pi++) {
        var p = active.pendingPermissions[pendingIds[pi]];
        sendTo(ws, {
          type: "permission_request_pending",
          requestId: p.requestId,
          toolName: p.toolName,
          toolInput: p.toolInput,
          toolUseId: p.toolUseId,
          decisionReason: p.decisionReason,
        });
      }
    }

    broadcastPresence();

    ws.on("message", function (raw) {
      var msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      handleMessage(ws, msg);
    });

    ws.on("close", function () {
      handleDisconnection(ws);
    });
  }

  // --- WS message handler ---
  function getSessionForWs(ws) {
    return sm.sessions.get(ws._clayActiveSession) || null;
  }

  function handleMessage(ws, msg) {
    // --- DM messages (delegated to server-level handler) ---
    if (msg.type === "dm_open" || msg.type === "dm_send" || msg.type === "dm_list" || msg.type === "dm_typing" || msg.type === "dm_add_favorite" || msg.type === "dm_remove_favorite") {
      if (typeof opts.onDmMessage === "function") {
        opts.onDmMessage(ws, msg);
      }
      return;
    }

    if (msg.type === "tab_visible") {
      if (typeof opts.onTabVisible === "function") opts.onTabVisible(ws);
      return;
    }

    if (msg.type === "push_subscribe") {
      if (pushModule && msg.subscription) pushModule.addSubscription(msg.subscription, msg.replaceEndpoint);
      return;
    }

    if (msg.type === "load_more_history") {
      var session = getSessionForWs(ws);
      if (!session || typeof msg.before !== "number") return;
      var before = msg.before;
      var targetFrom = typeof msg.target === "number" ? msg.target : before - sm.HISTORY_PAGE_SIZE;
      var from = sm.findTurnBoundary(session.history, Math.max(0, targetFrom));
      var to = before;
      var items = session.history.slice(from, to);
      for (var hi = 0; hi < items.length; hi++) {
        items[hi].seq = from + hi;
      }
      sendTo(ws, {
        type: "history_prepend",
        items: items,
        meta: { from: from, to: to, hasMore: from > 0 },
      });
      return;
    }

    if (msg.type === "new_session") {
      var sessionOpts = {};
      if (ws._clayUser) sessionOpts.ownerId = ws._clayUser.id;
      if (msg.sessionVisibility) sessionOpts.sessionVisibility = msg.sessionVisibility;
      var newSess = sm.createSession(sessionOpts, ws);
      ws._clayActiveSession = newSess.localId;
      if (usersModule.isMultiUser()) {
        broadcastPresence();
      }
      return;
    }

    if (msg.type === "set_session_visibility") {
      if (typeof msg.sessionId === "number" && (msg.visibility === "shared" || msg.visibility === "private")) {
        sm.setSessionVisibility(msg.sessionId, msg.visibility);
      }
      return;
    }

    if (msg.type === "transfer_project_owner") {
      var isAdmin = ws._clayUser && ws._clayUser.role === "admin";
      var isProjectOwner = ws._clayUser && projectOwnerId && ws._clayUser.id === projectOwnerId;
      if (!ws._clayUser || (!isAdmin && !isProjectOwner)) {
        sendTo(ws, { type: "error", text: "Only project owners or admins can transfer ownership." });
        return;
      }
      var targetUser = msg.userId ? usersModule.findUserById(msg.userId) : null;
      if (!targetUser) {
        sendTo(ws, { type: "error", text: "User not found." });
        return;
      }
      projectOwnerId = targetUser.id;
      // Persist via daemon callback
      if (opts.onProjectOwnerChanged) {
        opts.onProjectOwnerChanged(slug, projectOwnerId);
      }
      send({ type: "project_owner_changed", ownerId: projectOwnerId, ownerName: targetUser.displayName || targetUser.username });
      return;
    }

    if (msg.type === "resume_session") {
      if (!msg.cliSessionId) return;
      var cliSess = require("./cli-sessions");
      // Try SDK for title first, then fall back to manual parsing
      var titlePromise = getSDK().then(function(sdkMod) {
        return sdkMod.getSessionInfo(msg.cliSessionId, { dir: cwd });
      }).then(function(info) {
        return (info && info.summary) ? info.summary.substring(0, 100) : null;
      }).catch(function() { return null; });

      Promise.all([
        cliSess.readCliSessionHistory(cwd, msg.cliSessionId),
        titlePromise
      ]).then(function(results) {
        var history = results[0];
        var sdkTitle = results[1];
        var title = sdkTitle || "Resumed session";
        if (!sdkTitle) {
          for (var i = 0; i < history.length; i++) {
            if (history[i].type === "user_message" && history[i].text) {
              title = history[i].text.substring(0, 50);
              break;
            }
          }
        }
        var resumed = sm.resumeSession(msg.cliSessionId, { history: history, title: title }, ws);
        if (resumed) ws._clayActiveSession = resumed.localId;
      }).catch(function() {
        var resumed = sm.resumeSession(msg.cliSessionId, undefined, ws);
        if (resumed) ws._clayActiveSession = resumed.localId;
      });
      return;
    }

    if (msg.type === "list_cli_sessions") {
      var _fs = require("fs");
      // Collect session IDs already in relay (in-memory + persisted on disk)
      var relayIds = {};
      sm.sessions.forEach(function (s) {
        if (s.cliSessionId) relayIds[s.cliSessionId] = true;
      });
      try {
        var sessDir = sm.sessionsDir;
        var diskFiles = _fs.readdirSync(sessDir);
        for (var fi = 0; fi < diskFiles.length; fi++) {
          if (diskFiles[fi].endsWith(".jsonl")) {
            relayIds[diskFiles[fi].replace(".jsonl", "")] = true;
          }
        }
      } catch (e) {}

      getSDK().then(function(sdkMod) {
        return sdkMod.listSessions({ dir: cwd });
      }).then(function(sdkSessions) {
        var filtered = sdkSessions.filter(function(s) {
          return !relayIds[s.sessionId];
        }).map(function(s) {
          return {
            sessionId: s.sessionId,
            firstPrompt: s.summary || s.firstPrompt || "",
            model: null,
            gitBranch: s.gitBranch || null,
            startTime: s.createdAt ? new Date(s.createdAt).toISOString() : null,
            lastActivity: s.lastModified ? new Date(s.lastModified).toISOString() : null,
          };
        });
        sendTo(ws, { type: "cli_session_list", sessions: filtered });
      }).catch(function() {
        // Fallback to manual parsing if SDK fails
        var cliSessions = require("./cli-sessions");
        cliSessions.listCliSessions(cwd).then(function(sessions) {
          var filtered = sessions.filter(function(s) {
            return !relayIds[s.sessionId];
          });
          sendTo(ws, { type: "cli_session_list", sessions: filtered });
        }).catch(function() {
          sendTo(ws, { type: "cli_session_list", sessions: [] });
        });
      });
      return;
    }


    // Iter 5b: HEAD-only thread fork. Codex-only; Claude backend has no
    // forkActiveThread method and we explicitly guard so a stray frame
    // from a Claude project (or a malicious client) doesn't silently
    // succeed. The handler's job is small: ask the backend to fork the
    // currently-active session, then route the sidebar to the new one.
    if (msg.type === "fork_thread") {
      // Iter 2: route by source session's backend rather than project's.
      // Today these are the same (project.backend is immutable), but the
      // session-frozen rule from iter 1 is the right gate — a Codex
      // session must be forked even if the project default has flipped
      // away from Codex (post-iter-4). Fork is meaningless on Claude.
      var sourceSession = getSessionForWs(ws);
      if (!sourceSession) {
        sendTo(ws, { type: "codex_fork_error", reason: "no active session to fork" });
        return;
      }
      var forkSdk = sdkForSession(sourceSession);
      if (sourceSession.backend !== "codex" || typeof forkSdk.forkActiveThread !== "function") {
        sendTo(ws, { type: "codex_fork_error", reason: "fork is only supported on Codex sessions" });
        return;
      }
      // Multi-user mode: only the owner (or a user with write access) can
      // fork. We piggy-back on the same access check rewind uses — see
      // `switch_session` below for the read-side counterpart.
      if (usersModule.isMultiUser() && ws._clayUser) {
        if (!usersModule.canAccessSession(ws._clayUser.id, sourceSession, { visibility: "private" })) {
          sendTo(ws, { type: "codex_fork_error", reason: "permission denied" });
          return;
        }
      }
      forkSdk.forkActiveThread(sourceSession).then(function (newSession) {
        // The backend already broadcast the session list. Now move the
        // requesting client's view to the fork.
        ws._clayActiveSession = newSession.localId;
        sm.switchSession(newSession.localId, ws);
      }).catch(function (e) {
        console.error("[project] fork_thread failed:", e && (e.message || e));
        sendTo(ws, {
          type: "codex_fork_error",
          reason: (e && e.message) ? e.message : "fork failed",
        });
      });
      return;
    }

    if (msg.type === "switch_session") {
      if (msg.id && sm.sessions.has(msg.id)) {
        var resumeSeq = typeof msg.lastSeq === "number" ? msg.lastSeq : undefined;
        // Check access in multi-user mode
        if (usersModule.isMultiUser() && ws._clayUser) {
          var switchTarget = sm.sessions.get(msg.id);
          if (!usersModule.canAccessSession(ws._clayUser.id, switchTarget, { visibility: "public" })) return;
          ws._clayActiveSession = msg.id;
          sm.switchSession(msg.id, ws, resumeSeq);
          broadcastPresence();
        } else {
          ws._clayActiveSession = msg.id;
          sm.switchSession(msg.id, ws, resumeSeq);
        }
      }
      return;
    }

    if (msg.type === "delete_session") {
      if (msg.id && sm.sessions.has(msg.id)) {
        sm.deleteSession(msg.id, ws);
      }
      return;
    }

    if (msg.type === "rename_session") {
      if (msg.id && sm.sessions.has(msg.id) && msg.title) {
        var s = sm.sessions.get(msg.id);
        s.title = String(msg.title).substring(0, 100);
        sm.saveSessionFile(s);
        sm.broadcastSessionList();
        // Sync title to SDK session
        if (s.cliSessionId) {
          getSDK().then(function(sdk) {
            sdk.renameSession(s.cliSessionId, s.title, { dir: cwd }).catch(function(e) {
              console.error("[project] SDK renameSession failed:", e.message);
            });
          }).catch(function() {});
        }
      }
      return;
    }

    if (msg.type === "search_sessions") {
      var results = sm.searchSessions(msg.query || "");
      sendTo(ws, { type: "search_results", query: msg.query || "", results: results });
      return;
    }

    if (msg.type === "search_session_content") {
      var targetSession = msg.id ? sm.sessions.get(msg.id) : getSessionForWs(ws);
      if (!targetSession) return;
      var contentResults = sm.searchSessionContent(targetSession.localId, msg.query || "");
      var searchResp = { type: "search_content_results", query: msg.query || "", sessionId: targetSession.localId, hits: contentResults.hits, total: contentResults.total };
      if (msg.source) searchResp.source = msg.source;
      sendTo(ws, searchResp);
      return;
    }

    if (msg.type === "set_update_channel") {
      if (usersModule.isMultiUser() && (!ws._clayUser || ws._clayUser.role !== "admin")) return;
      var newChannel = msg.channel === "beta" ? "beta" : "stable";
      updateChannel = newChannel;
      latestVersion = null;
      if (typeof opts.onSetUpdateChannel === "function") {
        opts.onSetUpdateChannel(newChannel);
      }
      // Re-fetch with new channel and broadcast to admin clients
      fetchVersion(updateChannel).then(function (v) {
        if (v && isNewer(v, currentVersion)) {
          latestVersion = v;
          sendToAdmins({ type: "update_available", version: v });
        }
      }).catch(function () {});
      return;
    }

    if (msg.type === "check_update") {
      if (usersModule.isMultiUser() && (!ws._clayUser || ws._clayUser.role !== "admin")) return;
      fetchVersion(updateChannel).then(function (v) {
        if (v && isNewer(v, currentVersion)) {
          latestVersion = v;
          sendTo(ws, { type: "update_available", version: v });
        }
      }).catch(function () {});
      return;
    }

    if (msg.type === "update_now") {
      if (usersModule.isMultiUser() && (!ws._clayUser || ws._clayUser.role !== "admin")) return;
      send({ type: "update_started", version: latestVersion || "" });
      var _ipc = require("./ipc");
      var _config = require("./config");
      _ipc.sendIPCCommand(_config.socketPath(), { cmd: "update" });
      return;
    }

    if (msg.type === "process_stats") {
      var sessionCount = sm.sessions.size;
      var processingCount = 0;
      sm.sessions.forEach(function (s) {
        if (s.isProcessing) processingCount++;
      });
      var mem = process.memoryUsage();
      sendTo(ws, {
        type: "process_stats",
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
        sessions: sessionCount,
        processing: processingCount,
        clients: clients.size,
        terminals: tm.list().length,
      });
      return;
    }

    if (msg.type === "stop") {
      var session = getSessionForWs(ws);
      if (session && session.abortController && session.isProcessing) {
        session.abortController.abort();
      }
      return;
    }


    if (msg.type === "stop_task") {
      if (msg.taskId) {
        // Tasks belong to whichever session the client is viewing — route
        // by that session's frozen backend. Falls back to project default
        // when no session is in scope (shouldn't happen, but defensive).
        var stopSession = getSessionForWs(ws);
        sdkForSession(stopSession).stopTask(msg.taskId);
      }
      return;
    }

    if (msg.type === "kill_process") {
      var pid = msg.pid;
      if (!pid || typeof pid !== "number") return;
      // kill_process targets stale Claude PIDs from a previous run. We
      // refuse if the Claude SDK was never instantiated for this project
      // (no Claude session ever ran here, so this can't be one of OUR
      // processes). This avoids spinning up a Claude SDK just to answer
      // a kill request — hasBackend() is the non-instantiating peek.
      if (!hasBackend("claude") || !_backendRegistry.getSdkFor("claude").isClaudeProcess(pid)) {
        console.error("[project] Refused to kill PID " + pid + ": not a claude process");
        sendTo(ws, { type: "error", text: "Process " + pid + " is not a Claude process." });
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
        console.log("[project] Sent SIGTERM to conflicting Claude process PID " + pid);
        sendTo(ws, { type: "process_killed", pid: pid });
      } catch (e) {
        console.error("[project] Failed to kill PID " + pid + ":", e.message);
        sendTo(ws, { type: "error", text: "Failed to kill process " + pid + ": " + (e.message || e) });
      }
      return;
    }

    if (msg.type === "set_model" && msg.model) {
      var session = getSessionForWs(ws);
      if (session) {
        sdkForSession(session).setModel(session, msg.model);
      }
      return;
    }

    if (msg.type === "set_server_default_model" && msg.model) {
      if (typeof opts.onSetServerDefaultModel === "function") {
        opts.onSetServerDefaultModel(msg.model);
      }
      var session = getSessionForWs(ws);
      if (session) {
        sdkForSession(session).setModel(session, msg.model);
      }
      return;
    }

    if (msg.type === "set_project_default_model" && msg.model) {
      if (typeof opts.onSetProjectDefaultModel === "function") {
        opts.onSetProjectDefaultModel(slug, msg.model);
      }
      var session = getSessionForWs(ws);
      if (session) {
        sdkForSession(session).setModel(session, msg.model);
      }
      return;
    }

    if (msg.type === "set_permission_mode" && msg.mode) {
      // When dangerouslySkipPermissions is active, don't allow UI to change mode
      if (dangerouslySkipPermissions) {
        send({ type: "config_state", model: sm.currentModel || "", mode: "bypassPermissions", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
        return;
      }
      sm.currentPermissionMode = msg.mode;
      var session = getSessionForWs(ws);
      if (session) {
        sdkForSession(session).setPermissionMode(session, msg.mode);
      }
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return;
    }

    if (msg.type === "set_server_default_mode" && msg.mode) {
      if (typeof opts.onSetServerDefaultMode === "function") {
        opts.onSetServerDefaultMode(msg.mode);
      }
      if (!dangerouslySkipPermissions) {
        sm.currentPermissionMode = msg.mode;
        var session = getSessionForWs(ws);
        if (session) {
          sdkForSession(session).setPermissionMode(session, msg.mode);
        }
        send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      }
      return;
    }

    if (msg.type === "set_project_default_mode" && msg.mode) {
      if (typeof opts.onSetProjectDefaultMode === "function") {
        opts.onSetProjectDefaultMode(slug, msg.mode);
      }
      if (!dangerouslySkipPermissions) {
        sm.currentPermissionMode = msg.mode;
        var session = getSessionForWs(ws);
        if (session) {
          sdkForSession(session).setPermissionMode(session, msg.mode);
        }
        send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      }
      return;
    }

    if (msg.type === "set_effort" && msg.effort) {
      sm.currentEffort = msg.effort;
      var session = getSessionForWs(ws);
      if (session) {
        sdkForSession(session).setEffort(session, msg.effort);
      }
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return;
    }

    if (msg.type === "set_server_default_effort" && msg.effort) {
      if (typeof opts.onSetServerDefaultEffort === "function") {
        opts.onSetServerDefaultEffort(msg.effort);
      }
      sm.currentEffort = msg.effort;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return;
    }

    if (msg.type === "set_project_default_effort" && msg.effort) {
      if (typeof opts.onSetProjectDefaultEffort === "function") {
        opts.onSetProjectDefaultEffort(slug, msg.effort);
      }
      sm.currentEffort = msg.effort;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return;
    }

    // Iter 4: change the project's default backend.
    //
    // Effect: future calls to sm.createSession() / sm.resumeSession() will
    // stamp the new backend into freshly-born sessions (iter 1 reads
    // getProjectBackend() at session creation time, which now returns the
    // mutated closure value). Existing sessions are UNAFFECTED — their
    // backend is frozen at birth (iter 1 invariant), and iter 2's lazy SDK
    // map keeps routing them to their original SDK.
    //
    // What we deliberately do NOT do here:
    //   - Tear down or warm up SDKs. The non-default SDK boots lazily on
    //     first session use; flipping the default doesn't change that.
    //   - Rebroadcast `info`. That would force a full UI rerender on every
    //     connected client. We send a small `project_backend_changed` frame
    //     instead — clients only need to update their `defaultBackend`
    //     state and any UI showing "next session will use X".
    if (msg.type === "set_project_backend" && msg.backend) {
      var _newBackend = msg.backend;
      if (_newBackend !== "claude" && _newBackend !== "codex") {
        sendTo(ws, { type: "error", text: "Invalid backend: " + _newBackend });
        return;
      }
      if (_newBackend === backend) {
        // No-op — but echo so the UI's pending state can clear.
        sendTo(ws, { type: "project_backend_changed", defaultBackend: backend });
        return;
      }
      // Mutate the closure variable. getProjectBackend() (sessions.js) and
      // defaultSdk() (backend-registry) both close over `backend`, so this
      // single assignment retargets every call site that consults project
      // default — without re-threading any APIs.
      backend = _newBackend;
      if (typeof opts.onSetProjectBackend === "function") {
        var _persistResult = opts.onSetProjectBackend(slug, _newBackend);
        if (_persistResult && _persistResult.error) {
          // Persistence failed (e.g., disk full). Roll back so memory and
          // disk don't drift; surface the error.
          backend = (_newBackend === "claude") ? "codex" : "claude";
          sendTo(ws, { type: "error", text: "Failed to persist backend: " + _persistResult.error });
          return;
        }
      }
      // Broadcast to every client: their `defaultBackend` UI element
      // (settings panel "Backend" toggle, "Add new session" affordances)
      // needs to update. Active sessions on each client are unaffected.
      send({ type: "project_backend_changed", defaultBackend: backend });
      // Iter 4 follow-up: re-broadcast the session list so the sidebar
      // re-renders the per-session backend badges. The badge rule (sidebar.js)
      // is "show iff session.backend !== project.defaultBackend" — flipping
      // the default changes which sessions diverge, but no session_list
      // frame would otherwise prompt the sidebar to reapply that rule.
      // Cheap: the list is small and the renderer is a single pass.
      sm.broadcastSessionList();
      return;
    }

    if (msg.type === "set_betas") {
      sm.currentBetas = msg.betas || [];
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas, thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return;
    }

    if (msg.type === "set_thinking") {
      sm.currentThinking = msg.thinking || "adaptive";
      if (msg.budgetTokens) sm.currentThinkingBudget = msg.budgetTokens;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return;
    }

    // Iter 3 step 3: Codex-only settings. Routed via the active session's
    // backend (iter 2) — the UI only surfaces these controls during a
    // Codex session, so a Claude session here means a stale frame and is
    // a safe no-op. Settings persist on the Codex SDK instance and apply
    // to its next thread/start.
    if (msg.type === "set_codex_sandbox" && msg.sandbox) {
      var session = getSessionForWs(ws);
      var _sandboxSdk = sdkForSession(session);
      if (typeof _sandboxSdk.setSandbox === "function") {
        _sandboxSdk.setSandbox(session, msg.sandbox);
      }
      return;
    }
    if (msg.type === "set_codex_approval_policy" && msg.approvalPolicy) {
      var session = getSessionForWs(ws);
      var _approvalSdk = sdkForSession(session);
      if (typeof _approvalSdk.setApprovalPolicy === "function") {
        _approvalSdk.setApprovalPolicy(session, msg.approvalPolicy);
      }
      return;
    }

    // Iter 6a: user-initiated skills refresh. Codex-specific ambient op;
    // we only ever want to talk to an already-instantiated Codex SDK.
    // Lazy-spinning a Codex SDK just to refresh skills would defeat the
    // iter 2 lazy-init policy.
    if (msg.type === "request_codex_skills") {
      if (hasBackend("codex")) {
        var _skillsCodex = _backendRegistry.getSdkFor("codex");
        if (typeof _skillsCodex.fetchSkills === "function") {
          _skillsCodex.fetchSkills(!!msg.forceReload).catch(function () { /* fetchSkills logs */ });
        }
      }
      return;
    }

    // Iter 4: codex_unavailable card actions. Retry re-runs warmup + clears
    // the banner; codex_logs_request fetches a fresh stderr/log tail. Both
    // require the Codex SDK to already exist — no-op otherwise.
    if (msg.type === "codex_retry") {
      if (hasBackend("codex")) {
        var _retryCodex = _backendRegistry.getSdkFor("codex");
        if (typeof _retryCodex.retry === "function") _retryCodex.retry();
      }
      return;
    }
    if (msg.type === "codex_logs_request") {
      if (hasBackend("codex") && ws.readyState === 1) {
        var _logsCodex = _backendRegistry.getSdkFor("codex");
        if (typeof _logsCodex.getLogs === "function") {
          var resp;
          try {
            var logs = _logsCodex.getLogs() || {};
            resp = {
              type: "codex_logs_response",
              stderrTail: logs.stderrTail || "",
              logFile: logs.logFile || null,
              logTail: logs.logTail || "",
            };
          } catch (e) {
            resp = {
              type: "codex_logs_response",
              stderrTail: "",
              logFile: null,
              logTail: "",
              error: e.message || String(e),
            };
          }
          ws.send(JSON.stringify(resp));
        }
      }
      return;
    }

    if (msg.type === "rewind_preview") {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId || !msg.uuid) return;

      (async function () {
        var result;
        try {
          result = await sdkForSession(session).getOrCreateRewindQuery(session);
          var preview = await result.query.rewindFiles(msg.uuid, { dryRun: true });
          var diffs = {};
          var changedFiles = preview.filesChanged || [];
          for (var f = 0; f < changedFiles.length; f++) {
            try {
              diffs[changedFiles[f]] = execFileSync(
                "git", ["diff", "HEAD", "--", changedFiles[f]],
                { cwd: cwd, encoding: "utf8", timeout: 5000 }
              ) || "";
            } catch (e) { diffs[changedFiles[f]] = ""; }
          }
          sendTo(ws, { type: "rewind_preview_result", preview: preview, diffs: diffs, uuid: msg.uuid });
        } catch (err) {
          sendTo(ws, { type: "rewind_error", text: "Failed to preview rewind: " + err.message });
        } finally {
          if (result && result.isTemp) result.cleanup();
        }
      })();
      return;
    }

    if (msg.type === "rewind_execute") {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId || !msg.uuid) return;
      var mode = msg.mode || "both";

      (async function () {
        var result;
        try {
          // File restoration (skip for chat-only mode)
          if (mode !== "chat") {
            result = await sdkForSession(session).getOrCreateRewindQuery(session);
            await result.query.rewindFiles(msg.uuid, { dryRun: false });
          }

          // Conversation rollback (skip for files-only mode)
          if (mode !== "files") {
            var targetIdx = -1;
            for (var i = 0; i < session.messageUUIDs.length; i++) {
              if (session.messageUUIDs[i].uuid === msg.uuid) {
                targetIdx = i;
                break;
              }
            }

            if (targetIdx >= 0) {
              var trimTo = session.messageUUIDs[targetIdx].historyIndex;
              for (var k = trimTo - 1; k >= 0; k--) {
                if (session.history[k].type === "user_message") {
                  trimTo = k;
                  break;
                }
              }
              session.history = session.history.slice(0, trimTo);
              session.messageUUIDs = session.messageUUIDs.slice(0, targetIdx);
            }

            // Fork the SDK session truncated at the rewind point so that
            // `claude resume` also sees the truncated history (not just Clay).
            // upToMessageId is inclusive, so pass the message BEFORE the target
            // user message to exclude it from the forked session.
            var sdkMod = await getSDK();
            var oldCliSessionId = session.cliSessionId;
            var forkUpTo = targetIdx > 0
              ? session.messageUUIDs[targetIdx - 1].uuid
              : undefined;
            var forkOpts = { dir: cwd };
            if (forkUpTo) forkOpts.upToMessageId = forkUpTo;
            var forkResult = await sdkMod.forkSession(oldCliSessionId, forkOpts);
            session.cliSessionId = forkResult.sessionId;

            // Remove old Clay session file (new one written by saveSessionFile below)
            var oldSessionPath = path.join(sm.sessionsDir, oldCliSessionId + ".jsonl");
            try { fs.unlinkSync(oldSessionPath); } catch (e) {}
          }

          if (session.abortController) {
            try { session.abortController.abort(); } catch (e) {}
          }
          if (session.messageQueue) {
            try { session.messageQueue.end(); } catch (e) {}
          }
          session.queryInstance = null;
          session.messageQueue = null;
          session.abortController = null;
          session.blocks = {};
          session.sentToolResults = {};
          session.pendingPermissions = {};
          session.pendingAskUser = {};
          session.isProcessing = false;
          onProcessingChanged();

          sm.saveSessionFile(session);
          sm.switchSession(session.localId, ws);
          sm.sendAndRecord(session, { type: "rewind_complete", mode: mode });
          sm.broadcastSessionList();
        } catch (err) {
          sendTo(ws, { type: "rewind_error", text: "Rewind failed: " + err.message });
        } finally {
          if (result && result.isTemp) result.cleanup();
        }
      })();
      return;
    }

    if (msg.type === "fork_session" && msg.uuid) {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId) {
        sendTo(ws, { type: "error", text: "Cannot fork: no CLI session" });
        return;
      }
      var forkCliId = session.cliSessionId;
      var forkTitle = (session.title || "New Session") + " (fork)";
      // Find the message before the clicked user message so the fork
      // excludes the clicked message (upToMessageId is inclusive).
      var forkIdx = -1;
      for (var fi = 0; fi < session.messageUUIDs.length; fi++) {
        if (session.messageUUIDs[fi].uuid === msg.uuid) { forkIdx = fi; break; }
      }
      var forkOpts = { dir: cwd };
      if (forkIdx > 0) {
        forkOpts.upToMessageId = session.messageUUIDs[forkIdx - 1].uuid;
      }
      getSDK().then(function(sdkMod) {
        return sdkMod.forkSession(forkCliId, forkOpts);
      }).then(function(result) {
        var cliSess = require("./cli-sessions");
        return cliSess.readCliSessionHistory(cwd, result.sessionId).then(function(history) {
          var forked = sm.resumeSession(result.sessionId, { history: history, title: forkTitle }, ws);
          if (forked) {
            ws._clayActiveSession = forked.localId;
            sendTo(ws, { type: "fork_complete", sessionId: forked.localId });
          }
        });
      }).catch(function(e) {
        sendTo(ws, { type: "error", text: "Fork failed: " + (e.message || e) });
      });
      return;
    }

    if (msg.type === "ask_user_response") {
      var session = getSessionForWs(ws);
      if (!session) return;
      var toolId = msg.toolId;
      var answers = msg.answers || {};
      var pending = session.pendingAskUser[toolId];
      if (!pending) return;
      delete session.pendingAskUser[toolId];
      sm.sendAndRecord(session, { type: "ask_user_answered", toolId: toolId });
      pending.resolve({
        behavior: "allow",
        updatedInput: Object.assign({}, pending.input, { answers: answers }),
      });
      return;
    }

    if (msg.type === "input_sync") {
      sendToSessionOthers(ws, ws._clayActiveSession, msg);
      return;
    }

    if (msg.type === "cursor_move" || msg.type === "cursor_leave" || msg.type === "text_select") {
      if (!usersModule.isMultiUser() || !ws._clayUser) return;
      var u = ws._clayUser;
      var p = u.profile || {};
      var cursorMsg = {
        type: msg.type,
        userId: u.id,
        displayName: p.name || u.displayName || u.username,
        avatarStyle: p.avatarStyle || "thumbs",
        avatarSeed: p.avatarSeed || u.username,
      };
      if (msg.type === "cursor_move") {
        cursorMsg.turn = msg.turn;
        if (msg.rx != null) cursorMsg.rx = msg.rx;
        if (msg.ry != null) cursorMsg.ry = msg.ry;
      }
      if (msg.type === "text_select") {
        cursorMsg.ranges = msg.ranges || [];
      }
      sendToSessionOthers(ws, ws._clayActiveSession, cursorMsg);
      return;
    }

    if (msg.type === "permission_response") {
      var session = getSessionForWs(ws);
      if (!session) return;
      var requestId = msg.requestId;
      var decision = msg.decision;
      var pending = session.pendingPermissions[requestId];
      if (!pending) return;
      delete session.pendingPermissions[requestId];

      // --- Plan approval: "allow_accept_edits" — approve + switch to acceptEdits mode ---
      if (decision === "allow_accept_edits") {
        sdkForSession(session).setPermissionMode(session, "acceptEdits");
        sm.currentPermissionMode = "acceptEdits";
        send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
        pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });
        return;
      }

      // --- Plan approval: "allow_clear_context" — new session + plan as first message + acceptEdits ---
      if (decision === "allow_clear_context") {
        // Deny current plan to end the turn
        pending.resolve({ behavior: "deny", message: "User chose to clear context and restart" });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });

        // Abort the old session's query — but defer to next tick so the SDK's
        // deny write (scheduled as microtask by pending.resolve) completes first.
        // Aborting synchronously would kill the subprocess before the write,
        // causing an "Operation aborted" crash in the SDK.
        session.isProcessing = false;
        onProcessingChanged();
        session.pendingPermissions = {};
        session.pendingAskUser = {};
        sm.broadcastSessionList();
        setImmediate(function () {
          if (session.abortController) {
            session.abortController.abort();
          }
        });

        // Update permission mode for the new session
        sm.currentPermissionMode = "acceptEdits";
        send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });

        // Build prompt from plan content (sent from client) or plan file path
        var clientPlanContent = msg.planContent || "";
        var planPrompt;
        if (clientPlanContent) {
          planPrompt = "Execute the following plan. Do NOT re-enter plan mode — just implement it step by step.\n\n" + clientPlanContent;
        } else {
          var planFilePath = (pending.toolInput && pending.toolInput.planFilePath) || "";
          planPrompt = "Execute the plan in " + planFilePath + ". Do NOT re-enter plan mode — read the plan file and implement it step by step.";
        }

        // Wait for old query stream to fully terminate, then create new session + send plan
        var oldStreamPromise = session.streamPromise || Promise.resolve();
        Promise.race([
          oldStreamPromise,
          new Promise(function (resolve) { setTimeout(resolve, 3000); }),
        ]).then(function () {
          try {
            var newSession = sm.createSession(null, ws);
            // Send the plan as the first user message (with planContent for UI rendering)
            var userMsg = { type: "user_message", text: planPrompt, planContent: clientPlanContent || null };
            newSession.history.push(userMsg);
            sm.appendToSessionFile(newSession, userMsg);
            newSession.title = "Plan execution (cleared context)";
            sm.saveSessionFile(newSession);
            sm.broadcastSessionList();
            sendToSession(newSession.localId, userMsg);

            newSession.isProcessing = true;
            onProcessingChanged();
            newSession.sentToolResults = {};
            sendToSession(newSession.localId, { type: "status", status: "processing" });
            newSession.acceptEditsAfterStart = true;
            sdkForSession(newSession).startQuery(newSession, planPrompt, undefined, getLinuxUserForSession(newSession));
          } catch (e) {
            console.error("[project] Error starting plan execution:", e);
            sendTo(ws, { type: "error", text: "Failed to start plan execution: " + (e.message || e) });
          }
        });
        return;
      }

      // --- Plan approval: "deny_with_feedback" — deny + send feedback as follow-up message ---
      if (decision === "deny_with_feedback") {
        var feedback = msg.feedback || "";
        pending.resolve({ behavior: "deny", message: feedback || "User provided feedback" });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });

        // Send feedback as next user message if there's text
        if (feedback) {
          setTimeout(function () {
            var userMsg = { type: "user_message", text: feedback };
            session.history.push(userMsg);
            sm.appendToSessionFile(session, userMsg);
            sendToSession(session.localId, userMsg);

            if (!session.isProcessing) {
              session.isProcessing = true;
              onProcessingChanged();
              session.sentToolResults = {};
              sendToSession(session.localId, { type: "status", status: "processing" });
              var _feedbackSdk = sdkForSession(session);
              if (!session.queryInstance && !session.worker) {
                _feedbackSdk.startQuery(session, feedback, undefined, getLinuxUserForSession(session));
              } else {
                _feedbackSdk.pushMessage(session, feedback);
              }
            } else {
              sdkForSession(session).pushMessage(session, feedback);
            }
          }, 200);
        }
        return;
      }

      if (decision === "allow" || decision === "allow_always") {
        if (decision === "allow_always") {
          if (!session.allowedTools) session.allowedTools = {};
          session.allowedTools[pending.toolName] = true;
        }
        pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
      } else {
        pending.resolve({ behavior: "deny", message: "User denied permission" });
      }

      sm.sendAndRecord(session, {
        type: "permission_resolved",
        requestId: requestId,
        decision: decision,
      });
      return;
    }

    // --- MCP elicitation response ---
    if (msg.type === "elicitation_response") {
      var session = getSessionForWs(ws);
      if (!session) return;
      var pending = session.pendingElicitations && session.pendingElicitations[msg.requestId];
      if (!pending) return;
      delete session.pendingElicitations[msg.requestId];
      if (msg.action === "accept") {
        pending.resolve({ action: "accept", content: msg.content || {} });
      } else {
        pending.resolve({ action: "reject" });
      }
      sm.sendAndRecord(session, {
        type: "elicitation_resolved",
        requestId: msg.requestId,
        action: msg.action,
      });
      return;
    }

    // --- Browse directories (for add-project autocomplete) ---
    if (msg.type === "browse_dir") {
      var rawPath = (msg.path || "").replace(/^~/, process.env.HOME || "/");
      var absTarget = path.resolve(rawPath);
      var parentDir, prefix;
      try {
        var stat = fs.statSync(absTarget);
        if (stat.isDirectory()) {
          // Input is an existing directory — list its children
          parentDir = absTarget;
          prefix = "";
        } else {
          parentDir = path.dirname(absTarget);
          prefix = path.basename(absTarget).toLowerCase();
        }
      } catch (e) {
        // Path doesn't exist — list parent and filter by typed prefix
        parentDir = path.dirname(absTarget);
        prefix = path.basename(absTarget).toLowerCase();
      }
      try {
        var dirItems = fs.readdirSync(parentDir, { withFileTypes: true });
        var dirEntries = [];
        for (var di = 0; di < dirItems.length; di++) {
          var d = dirItems[di];
          if (!d.isDirectory()) continue;
          if (d.name.charAt(0) === ".") continue;
          if (IGNORED_DIRS.has(d.name)) continue;
          if (prefix && !d.name.toLowerCase().startsWith(prefix)) continue;
          dirEntries.push({ name: d.name, path: path.join(parentDir, d.name) });
        }
        dirEntries.sort(function (a, b) { return a.name.localeCompare(b.name); });
        sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: dirEntries });
      } catch (e) {
        sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: [], error: e.message });
      }
      return;
    }

    // --- Add project from web UI ---
    if (msg.type === "add_project") {
      var addPath = (msg.path || "").replace(/^~/, process.env.HOME || "/");
      var addAbs = path.resolve(addPath);
      try {
        var addStat = fs.statSync(addAbs);
        if (!addStat.isDirectory()) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "Not a directory" });
          return;
        }
      } catch (e) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Directory not found" });
        return;
      }
      if (typeof opts.onAddProject === "function") {
        var addBackendChoice = (msg.backend === "codex") ? "codex" : "claude";
        var result = opts.onAddProject(addAbs, ws._clayUser, { backend: addBackendChoice });
        sendTo(ws, { type: "add_project_result", ok: result.ok, slug: result.slug, error: result.error, existing: result.existing });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return;
    }

    // --- Create new empty project ---
    if (msg.type === "create_project") {
      var createName = (msg.name || "").trim();
      if (!createName || !/^[a-zA-Z0-9_-]+$/.test(createName)) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Invalid name. Use only letters, numbers, dashes, and underscores." });
        return;
      }
      if (typeof opts.onCreateProject === "function") {
        var createBackendChoice = (msg.backend === "codex") ? "codex" : "claude";
        var createResult = opts.onCreateProject(createName, ws._clayUser, { backend: createBackendChoice });
        sendTo(ws, { type: "add_project_result", ok: createResult.ok, slug: createResult.slug, error: createResult.error });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return;
    }

    // --- Clone project from GitHub ---
    if (msg.type === "clone_project") {
      var cloneUrl = (msg.url || "").trim();
      if (!cloneUrl || (!/^https?:\/\//.test(cloneUrl) && !/^git@/.test(cloneUrl))) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Invalid URL. Use https:// or git@ format." });
        return;
      }
      sendTo(ws, { type: "clone_project_progress", status: "cloning" });
      if (typeof opts.onCloneProject === "function") {
        var cloneBackendChoice = (msg.backend === "codex") ? "codex" : "claude";
        opts.onCloneProject(cloneUrl, ws._clayUser, function (cloneResult) {
          sendTo(ws, { type: "add_project_result", ok: cloneResult.ok, slug: cloneResult.slug, error: cloneResult.error });
        }, { backend: cloneBackendChoice });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return;
    }

    // --- Create worktree from web UI ---
    if (msg.type === "create_worktree") {
      var wtBranch = (msg.branch || "").trim();
      var wtBase = (msg.baseBranch || "").trim() || null;
      if (!wtBranch || !/^[a-zA-Z0-9_\/.@-]+$/.test(wtBranch)) {
        sendTo(ws, { type: "create_worktree_result", ok: false, error: "Invalid branch name" });
        return;
      }
      if (typeof onCreateWorktree === "function") {
        var wtParentSlug = msg.parentSlug || slug;
        var wtResult = onCreateWorktree(wtParentSlug, wtBranch, wtBase);
        sendTo(ws, { type: "create_worktree_result", ok: wtResult.ok, slug: wtResult.slug, error: wtResult.error });
      } else {
        sendTo(ws, { type: "create_worktree_result", ok: false, error: "Not supported" });
      }
      return;
    }

    // --- Pre-check: does the project have tasks/schedules? ---
    if (msg.type === "remove_project_check") {
      var checkSlug = msg.slug;
      if (!checkSlug) {
        sendTo(ws, { type: "remove_project_check_result", slug: checkSlug, name: msg.name || checkSlug, count: 0 });
        return;
      }
      var schedCount = getScheduleCount(checkSlug);
      sendTo(ws, { type: "remove_project_check_result", slug: checkSlug, name: msg.name || checkSlug, count: schedCount });
      return;
    }

    // --- Remove project from web UI ---
    if (msg.type === "remove_project") {
      var removeSlug = msg.slug;
      if (!removeSlug) {
        sendTo(ws, { type: "remove_project_result", ok: false, error: "Missing slug" });
        return;
      }
      // If client chose to move tasks to another project before removing
      if (msg.moveTasksTo) {
        moveAllSchedulesToProject(removeSlug, msg.moveTasksTo);
      }
      if (typeof opts.onRemoveProject === "function") {
        // Send result before removing so the WS is still open
        sendTo(ws, { type: "remove_project_result", ok: true, slug: removeSlug });
        var removeUserId = ws._clayUser ? ws._clayUser.id : null;
        opts.onRemoveProject(removeSlug, removeUserId);
      } else {
        sendTo(ws, { type: "remove_project_result", ok: false, error: "Not supported" });
      }
      return;
    }

    // --- Move a single schedule to another project ---
    if (msg.type === "schedule_move") {
      var moveResult = moveScheduleToProject(msg.recordId, msg.fromSlug, msg.toSlug);
      if (moveResult.ok) {
        // Re-broadcast updated records to this project's clients
        send({ type: "loop_registry_updated", records: getHubSchedules() });
      }
      sendTo(ws, { type: "schedule_move_result", ok: moveResult.ok, error: moveResult.error });
      return;
    }

    // --- Reorder projects ---
    if (msg.type === "reorder_projects") {
      var slugs = msg.slugs;
      if (!Array.isArray(slugs) || slugs.length === 0) {
        sendTo(ws, { type: "reorder_projects_result", ok: false, error: "Missing slugs" });
        return;
      }
      if (typeof opts.onReorderProjects === "function") {
        var reorderResult = opts.onReorderProjects(slugs);
        sendTo(ws, { type: "reorder_projects_result", ok: reorderResult.ok, error: reorderResult.error });
      } else {
        sendTo(ws, { type: "reorder_projects_result", ok: false, error: "Not supported" });
      }
      return;
    }

    // --- Set project title (rename) ---
    if (msg.type === "set_project_title") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_title_result", ok: false, error: "Missing slug" });
        return;
      }
      if (typeof opts.onSetProjectTitle === "function") {
        var titleResult = opts.onSetProjectTitle(msg.slug, msg.title || null);
        sendTo(ws, { type: "set_project_title_result", ok: titleResult.ok, slug: msg.slug, error: titleResult.error });
      } else {
        sendTo(ws, { type: "set_project_title_result", ok: false, error: "Not supported" });
      }
      return;
    }

    // --- Set project icon (emoji) ---
    if (msg.type === "set_project_icon") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_icon_result", ok: false, error: "Missing slug" });
        return;
      }
      if (typeof opts.onSetProjectIcon === "function") {
        var iconResult = opts.onSetProjectIcon(msg.slug, msg.icon || null);
        sendTo(ws, { type: "set_project_icon_result", ok: iconResult.ok, slug: msg.slug, error: iconResult.error });
      } else {
        sendTo(ws, { type: "set_project_icon_result", ok: false, error: "Not supported" });
      }
      return;
    }

    // --- Daemon config / server management (admin-only in multi-user mode) ---
    if (msg.type === "get_daemon_config" || msg.type === "set_pin" || msg.type === "set_keep_awake" ||
        msg.type === "shutdown_server" || msg.type === "restart_server") {
      if (usersModule.isMultiUser()) {
        var _wsUser = ws._clayUser;
        if (!_wsUser || _wsUser.role !== "admin") {
          sendTo(ws, { type: "error", message: "Admin access required" });
          return;
        }
      }
    }

    if (msg.type === "get_daemon_config") {
      if (typeof opts.onGetDaemonConfig === "function") {
        var daemonConfig = opts.onGetDaemonConfig();
        sendTo(ws, { type: "daemon_config", config: daemonConfig });
      }
      return;
    }

    if (msg.type === "set_pin") {
      if (typeof opts.onSetPin === "function") {
        var pinResult = opts.onSetPin(msg.pin || null);
        sendTo(ws, { type: "set_pin_result", ok: pinResult.ok, pinEnabled: pinResult.pinEnabled });
      }
      return;
    }

    if (msg.type === "set_keep_awake") {
      if (typeof opts.onSetKeepAwake === "function") {
        var kaResult = opts.onSetKeepAwake(msg.value);
        sendTo(ws, { type: "set_keep_awake_result", ok: kaResult.ok, keepAwake: kaResult.keepAwake });
        send({ type: "keep_awake_changed", keepAwake: kaResult.keepAwake });
      }
      return;
    }

    if (msg.type === "shutdown_server") {
      if (typeof opts.onShutdown === "function") {
        sendTo(ws, { type: "shutdown_server_result", ok: true });
        send({ type: "toast", level: "warn", message: "Server is shutting down..." });
        // Small delay so the response has time to reach clients
        setTimeout(function () {
          opts.onShutdown();
        }, 500);
      } else {
        sendTo(ws, { type: "shutdown_server_result", ok: false, error: "Shutdown not supported" });
      }
      return;
    }

    if (msg.type === "restart_server") {
      if (typeof opts.onRestart === "function") {
        sendTo(ws, { type: "restart_server_result", ok: true });
        send({ type: "toast", level: "info", message: "Server is restarting..." });
        // Small delay so the response has time to reach clients
        setTimeout(function () {
          opts.onRestart();
        }, 500);
      } else {
        sendTo(ws, { type: "restart_server_result", ok: false, error: "Restart not supported" });
      }
      return;
    }

    // --- File browser ---
    if (msg.type === "fs_list") {
      var fsDir = safePath(cwd, msg.path || ".");
      if (!fsDir) {
        sendTo(ws, { type: "fs_list_result", path: msg.path, entries: [], error: "Access denied", source: msg.source });
        return;
      }
      try {
        var fsListUserInfo = getOsUserInfoForWs(ws);
        var entries = [];
        if (fsListUserInfo) {
          // Run as target OS user to respect Linux file permissions
          var rawEntries = fsAsUser("list", { dir: fsDir }, fsListUserInfo);
          for (var fi = 0; fi < rawEntries.length; fi++) {
            var re = rawEntries[fi];
            if (re.isDir && IGNORED_DIRS.has(re.name)) continue;
            entries.push({
              name: re.name,
              type: re.isDir ? "dir" : "file",
              path: path.relative(cwd, path.join(fsDir, re.name)).split(path.sep).join("/"),
            });
          }
        } else {
          var items = fs.readdirSync(fsDir, { withFileTypes: true });
          for (var fi = 0; fi < items.length; fi++) {
            var item = items[fi];
            if (item.isDirectory() && IGNORED_DIRS.has(item.name)) continue;
            entries.push({
              name: item.name,
              type: item.isDirectory() ? "dir" : "file",
              path: path.relative(cwd, path.join(fsDir, item.name)).split(path.sep).join("/"),
            });
          }
        }
        sendTo(ws, { type: "fs_list_result", path: msg.path || ".", entries: entries, source: msg.source });
        // Auto-watch the directory for changes
        startDirWatch(msg.path || ".");
      } catch (e) {
        sendTo(ws, { type: "fs_list_result", path: msg.path, entries: [], error: e.message, source: msg.source });
      }
      return;
    }

    if (msg.type === "fs_read") {
      var fsFile = safePath(cwd, msg.path);
      if (!fsFile) {
        sendTo(ws, { type: "fs_read_result", path: msg.path, error: "Access denied" });
        return;
      }
      try {
        var fsReadUserInfo = getOsUserInfoForWs(ws);
        var ext = path.extname(fsFile).toLowerCase();
        if (fsReadUserInfo) {
          // Run stat and read as target OS user
          var statResult = fsAsUser("stat", { file: fsFile }, fsReadUserInfo);
          if (statResult.size > FS_MAX_SIZE) {
            sendTo(ws, { type: "fs_read_result", path: msg.path, binary: true, size: statResult.size, error: "File too large (" + (statResult.size / 1024 / 1024).toFixed(1) + " MB)" });
            return;
          }
          if (BINARY_EXTS.has(ext)) {
            var result = { type: "fs_read_result", path: msg.path, binary: true, size: statResult.size };
            if (IMAGE_EXTS.has(ext)) result.imageUrl = "api/file?path=" + encodeURIComponent(msg.path);
            sendTo(ws, result);
            return;
          }
          var readResult = fsAsUser("read", { file: fsFile, readContent: true }, fsReadUserInfo);
          sendTo(ws, { type: "fs_read_result", path: msg.path, content: readResult.content, size: statResult.size });
        } else {
          var stat = fs.statSync(fsFile);
          if (stat.size > FS_MAX_SIZE) {
            sendTo(ws, { type: "fs_read_result", path: msg.path, binary: true, size: stat.size, error: "File too large (" + (stat.size / 1024 / 1024).toFixed(1) + " MB)" });
            return;
          }
          if (BINARY_EXTS.has(ext)) {
            var result = { type: "fs_read_result", path: msg.path, binary: true, size: stat.size };
            if (IMAGE_EXTS.has(ext)) result.imageUrl = "api/file?path=" + encodeURIComponent(msg.path);
            sendTo(ws, result);
            return;
          }
          var content = fs.readFileSync(fsFile, "utf8");
          sendTo(ws, { type: "fs_read_result", path: msg.path, content: content, size: stat.size });
        }
      } catch (e) {
        sendTo(ws, { type: "fs_read_result", path: msg.path, error: e.message });
      }
      return;
    }

    // --- File write ---
    if (msg.type === "fs_write") {
      var fsWriteFile = safePath(cwd, msg.path);
      if (!fsWriteFile) {
        sendTo(ws, { type: "fs_write_result", path: msg.path, ok: false, error: "Access denied" });
        return;
      }
      try {
        var fsWriteUserInfo = getOsUserInfoForWs(ws);
        if (fsWriteUserInfo) {
          fsAsUser("write", { file: fsWriteFile, content: msg.content || "" }, fsWriteUserInfo);
        } else {
          fs.writeFileSync(fsWriteFile, msg.content || "", "utf8");
        }
        sendTo(ws, { type: "fs_write_result", path: msg.path, ok: true });
      } catch (e) {
        sendTo(ws, { type: "fs_write_result", path: msg.path, ok: false, error: e.message });
      }
      return;
    }

    // --- Project environment variables ---
    if (msg.type === "get_project_env") {
      var envrc = "";
      var hasEnvrc = false;
      if (typeof opts.onGetProjectEnv === "function") {
        var envResult = opts.onGetProjectEnv(msg.slug);
        envrc = envResult.envrc || "";
      }
      try {
        var envrcPath = path.join(cwd, ".envrc");
        hasEnvrc = fs.existsSync(envrcPath);
      } catch (e) {}
      sendTo(ws, { type: "project_env_result", slug: msg.slug, envrc: envrc, hasEnvrc: hasEnvrc });
      return;
    }

    if (msg.type === "set_project_env") {
      if (typeof opts.onSetProjectEnv === "function") {
        var envError = validateEnvString(msg.envrc || "");
        if (envError) {
          sendTo(ws, { type: "set_project_env_result", ok: false, slug: msg.slug, error: envError });
          return;
        }
        var setResult = opts.onSetProjectEnv(msg.slug, msg.envrc || "");
        sendTo(ws, { type: "set_project_env_result", ok: setResult.ok, slug: msg.slug, error: setResult.error });
      } else {
        sendTo(ws, { type: "set_project_env_result", ok: false, error: "Not supported" });
      }
      return;
    }

    // --- Global CLAUDE.md ---
    if (msg.type === "read_global_claude_md") {
      var os = require("os");
      var globalMdPath = path.join(os.homedir(), ".claude", "CLAUDE.md");
      try {
        var globalMdContent = fs.readFileSync(globalMdPath, "utf8");
        sendTo(ws, { type: "global_claude_md_result", content: globalMdContent });
      } catch (e) {
        sendTo(ws, { type: "global_claude_md_result", error: e.message });
      }
      return;
    }

    if (msg.type === "write_global_claude_md") {
      var os2 = require("os");
      var globalMdDir = path.join(os2.homedir(), ".claude");
      var globalMdWritePath = path.join(globalMdDir, "CLAUDE.md");
      try {
        if (!fs.existsSync(globalMdDir)) {
          fs.mkdirSync(globalMdDir, { recursive: true });
        }
        fs.writeFileSync(globalMdWritePath, msg.content || "", "utf8");
        sendTo(ws, { type: "write_global_claude_md_result", ok: true });
      } catch (e) {
        sendTo(ws, { type: "write_global_claude_md_result", ok: false, error: e.message });
      }
      return;
    }

    // --- Shared environment variables ---
    if (msg.type === "get_shared_env") {
      var sharedEnvrc = "";
      if (typeof opts.onGetSharedEnv === "function") {
        var sharedResult = opts.onGetSharedEnv();
        sharedEnvrc = sharedResult.envrc || "";
      }
      sendTo(ws, { type: "shared_env_result", envrc: sharedEnvrc });
      return;
    }

    if (msg.type === "set_shared_env") {
      if (typeof opts.onSetSharedEnv === "function") {
        var sharedEnvError = validateEnvString(msg.envrc || "");
        if (sharedEnvError) {
          sendTo(ws, { type: "set_shared_env_result", ok: false, error: sharedEnvError });
          return;
        }
        var sharedSetResult = opts.onSetSharedEnv(msg.envrc || "");
        sendTo(ws, { type: "set_shared_env_result", ok: sharedSetResult.ok, error: sharedSetResult.error });
      } else {
        sendTo(ws, { type: "set_shared_env_result", ok: false, error: "Not supported" });
      }
      return;
    }

    // --- File watcher ---
    if (msg.type === "fs_watch") {
      if (msg.path) startFileWatch(msg.path);
      return;
    }

    if (msg.type === "fs_unwatch") {
      stopFileWatch();
      return;
    }

    // --- File edit history ---
    if (msg.type === "fs_file_history") {
      var histPath = msg.path;
      if (!histPath) {
        sendTo(ws, { type: "fs_file_history_result", path: histPath, entries: [] });
        return;
      }
      var absHistPath = path.resolve(cwd, histPath);
      var entries = [];

      // Collect session edits
      sm.sessions.forEach(function (session) {
        var sessionLocalId = session.localId;
        var sessionTitle = session.title || "Untitled";
        var histLen = session.history.length || 1;

        for (var hi = 0; hi < session.history.length; hi++) {
          var entry = session.history[hi];
          if (entry.type !== "tool_executing") continue;
          if (entry.name !== "Edit" && entry.name !== "Write") continue;
          if (!entry.input || !entry.input.file_path) continue;
          if (entry.input.file_path !== absHistPath) continue;

          // Find parent assistant UUID + message snippet by scanning backwards
          var assistantUuid = null;
          var uuidIndex = -1;
          for (var hj = hi - 1; hj >= 0; hj--) {
            if (session.history[hj].type === "message_uuid" && session.history[hj].messageType === "assistant") {
              assistantUuid = session.history[hj].uuid;
              uuidIndex = hj;
              break;
            }
          }

          // Find user prompt by scanning backwards from the assistant uuid
          var messageSnippet = "";
          var searchFrom = uuidIndex >= 0 ? uuidIndex : hi;
          for (var hk = searchFrom - 1; hk >= 0; hk--) {
            if (session.history[hk].type === "user_message" && session.history[hk].text) {
              messageSnippet = session.history[hk].text.trim().substring(0, 100);
              break;
            }
          }

          // Collect Claude's explanation: scan backwards from tool_executing
          // to find the nearest delta text block (skipping tool_start).
          // If no delta found immediately before this tool, scan past
          // intervening tool blocks to find the last delta text within
          // the same assistant turn.
          var assistantSnippet = "";
          var deltaChunks = [];
          for (var hd = hi - 1; hd >= 0; hd--) {
            var hEntry = session.history[hd];
            if (hEntry.type === "tool_start") continue;
            if (hEntry.type === "delta" && hEntry.text) {
              deltaChunks.unshift(hEntry.text);
            } else {
              break;
            }
          }
          if (deltaChunks.length === 0) {
            // No delta immediately before; scan past tool blocks
            // to find the nearest preceding delta in the same turn
            for (var hd2 = hi - 1; hd2 >= 0; hd2--) {
              var hEntry2 = session.history[hd2];
              if (hEntry2.type === "tool_start" || hEntry2.type === "tool_executing" || hEntry2.type === "tool_result") continue;
              if (hEntry2.type === "delta" && hEntry2.text) {
                // Found a delta before an earlier tool in the same turn.
                // Collect this contiguous block of deltas.
                for (var hd3 = hd2; hd3 >= 0; hd3--) {
                  var hEntry3 = session.history[hd3];
                  if (hEntry3.type === "tool_start") continue;
                  if (hEntry3.type === "delta" && hEntry3.text) {
                    deltaChunks.unshift(hEntry3.text);
                  } else {
                    break;
                  }
                }
                break;
              } else {
                // Hit message_uuid, user_message, etc. Stop.
                break;
              }
            }
          }
          assistantSnippet = deltaChunks.join("").trim().substring(0, 150);

          // Approximate timestamp: interpolate between session creation and last activity
          var tStart = session.createdAt || 0;
          var tEnd = session.lastActivity || tStart;
          var ts = tStart + Math.floor((hi / histLen) * (tEnd - tStart));

          var editRecord = {
            source: "session",
            timestamp: ts,
            sessionLocalId: sessionLocalId,
            sessionTitle: sessionTitle,
            assistantUuid: assistantUuid,
            toolId: entry.id,
            messageSnippet: messageSnippet,
            assistantSnippet: assistantSnippet,
            toolName: entry.name,
          };

          if (entry.name === "Edit") {
            editRecord.old_string = entry.input.old_string || "";
            editRecord.new_string = entry.input.new_string || "";
          } else {
            editRecord.isFullWrite = true;
          }

          entries.push(editRecord);
        }
      });

      // Collect git commits
      try {
        var gitLog = execFileSync(
          "git", ["log", "--format=%H|%at|%an|%s", "--follow", "--", histPath],
          { cwd: cwd, encoding: "utf8", timeout: 5000 }
        );
        var gitLines = gitLog.trim().split("\n");
        for (var gi = 0; gi < gitLines.length; gi++) {
          if (!gitLines[gi]) continue;
          var parts = gitLines[gi].split("|");
          if (parts.length < 4) continue;
          entries.push({
            source: "git",
            hash: parts[0],
            timestamp: parseInt(parts[1], 10) * 1000,
            author: parts[2],
            message: parts.slice(3).join("|"),
          });
        }
      } catch (e) {
        // Not a git repo or file not tracked, that's fine
      }

      // Sort by timestamp descending (newest first)
      entries.sort(function (a, b) { return b.timestamp - a.timestamp; });

      sendTo(ws, { type: "fs_file_history_result", path: histPath, entries: entries });
      return;
    }

    // --- Git diff for file history ---
    if (msg.type === "fs_git_diff") {
      var diffPath = msg.path;
      var hash = msg.hash;
      var hash2 = msg.hash2 || null;
      if (!diffPath || !hash) {
        sendTo(ws, { type: "fs_git_diff_result", hash: hash, path: diffPath, diff: "", error: "Missing params" });
        return;
      }
      try {
        var diff;
        if (hash2) {
          diff = execFileSync("git", ["diff", hash, hash2, "--", diffPath],
            { cwd: cwd, encoding: "utf8", timeout: 5000 });
        } else {
          diff = execFileSync("git", ["show", hash, "--format=", "--", diffPath],
            { cwd: cwd, encoding: "utf8", timeout: 5000 });
        }
        sendTo(ws, { type: "fs_git_diff_result", hash: hash, hash2: hash2, path: diffPath, diff: diff || "" });
      } catch (e) {
        sendTo(ws, { type: "fs_git_diff_result", hash: hash, hash2: hash2, path: diffPath, diff: "", error: e.message });
      }
      return;
    }

    // --- File content at a git commit ---
    if (msg.type === "fs_file_at") {
      var atPath = msg.path;
      var atHash = msg.hash;
      if (!atPath || !atHash) {
        sendTo(ws, { type: "fs_file_at_result", hash: atHash, path: atPath, content: "", error: "Missing params" });
        return;
      }
      try {
        // Convert to repo-relative path (git show requires hash:relative/path)
        var atAbsPath = path.resolve(cwd, atPath);
        var atRelPath = path.relative(cwd, atAbsPath);
        var content = execFileSync("git", ["show", atHash + ":" + atRelPath],
          { cwd: cwd, encoding: "utf8", timeout: 5000 });
        sendTo(ws, { type: "fs_file_at_result", hash: atHash, path: atPath, content: content });
      } catch (e) {
        sendTo(ws, { type: "fs_file_at_result", hash: atHash, path: atPath, content: "", error: e.message });
      }
      return;
    }

    // --- Sticky notes ---
    if (msg.type === "note_create") {
      var note = nm.create(msg);
      if (note) send({ type: "note_created", note: note });
      return;
    }

    if (msg.type === "note_update") {
      if (!msg.id) return;
      var updated = nm.update(msg.id, msg);
      if (updated) send({ type: "note_updated", note: updated });
      return;
    }

    if (msg.type === "note_delete") {
      if (!msg.id) return;
      if (nm.remove(msg.id)) send({ type: "note_deleted", id: msg.id });
      return;
    }

    if (msg.type === "note_bring_front") {
      if (!msg.id) return;
      var front = nm.bringToFront(msg.id);
      if (front) send({ type: "note_updated", note: front });
      return;
    }

    // --- Web terminal ---
    if (msg.type === "term_create") {
      var t = tm.create(msg.cols || 80, msg.rows || 24, getOsUserInfoForWs(ws));
      if (!t) {
        sendTo(ws, { type: "term_error", error: "Cannot create terminal (node-pty not available or limit reached)" });
        return;
      }
      tm.attach(t.id, ws);
      send({ type: "term_list", terminals: tm.list() });
      sendTo(ws, { type: "term_created", id: t.id });
      return;
    }

    if (msg.type === "term_attach") {
      if (msg.id) tm.attach(msg.id, ws);
      return;
    }

    if (msg.type === "term_detach") {
      if (msg.id) tm.detach(msg.id, ws);
      return;
    }

    if (msg.type === "term_input") {
      if (msg.id) tm.write(msg.id, msg.data);
      return;
    }

    if (msg.type === "term_resize") {
      if (msg.id && msg.cols > 0 && msg.rows > 0) {
        tm.resize(msg.id, msg.cols, msg.rows);
      }
      return;
    }

    if (msg.type === "term_close") {
      if (msg.id) {
        tm.close(msg.id);
        send({ type: "term_list", terminals: tm.list() });
      }
      return;
    }

    if (msg.type === "term_rename") {
      if (msg.id && msg.title) {
        tm.rename(msg.id, msg.title);
        send({ type: "term_list", terminals: tm.list() });
      }
      return;
    }

    if (msg.type === "loop_start") {
      // If this loop has a cron schedule, don't run immediately — just confirm registration
      if (loopState.wizardData && loopState.wizardData.cron) {
        loopState.active = false;
        loopState.phase = "done";
        saveLoopState();
        send({ type: "loop_finished", reason: "scheduled", iterations: 0, results: [] });
        send({ type: "ralph_phase", phase: "idle", wizardData: null });
        send({ type: "loop_scheduled", recordId: loopState.loopId, cron: loopState.wizardData.cron });
        return;
      }
      startLoop();
      return;
    }

    if (msg.type === "loop_stop") {
      stopLoop();
      return;
    }

    if (msg.type === "ralph_wizard_complete") {
      var wData = msg.data || {};
      var maxIter = wData.maxIterations || 3;
      var wizardCron = wData.cron || null;
      var newLoopId = generateLoopId();
      loopState.loopId = newLoopId;
      loopState.wizardData = {
        name: wData.name || wData.task || "Untitled",
        task: wData.task || "",
        maxIterations: maxIter,
        cron: wizardCron,
      };
      loopState.phase = "crafting";
      loopState.startedAt = Date.now();
      saveLoopState();

      // Register in loop registry
      var recordSource = wData.source === "task" ? null : "ralph";
      loopRegistry.register({
        id: newLoopId,
        name: loopState.wizardData.name,
        task: wData.task || "",
        cron: wizardCron,
        enabled: wizardCron ? true : false,
        maxIterations: maxIter,
        source: recordSource,
      });

      // Create loop directory and write LOOP.json
      var lDir = loopDir();
      try { fs.mkdirSync(lDir, { recursive: true }); } catch (e) {}
      var loopJsonPath = path.join(lDir, "LOOP.json");
      var tmpLoopJson = loopJsonPath + ".tmp";
      fs.writeFileSync(tmpLoopJson, JSON.stringify({ maxIterations: maxIter }, null, 2));
      fs.renameSync(tmpLoopJson, loopJsonPath);

      // Assemble prompt for clay-ralph skill (include loop dir path so skill knows where to write)
      var craftingPrompt = "Use the /clay-ralph skill to design a Ralph Loop for the following task. " +
        "You MUST invoke the clay-ralph skill — do NOT execute the task yourself. " +
        "Your job is to interview me, then create PROMPT.md and JUDGE.md files " +
        "that a future autonomous session will execute.\n\n" +
        "## Task\n" + (wData.task || "") +
        "\n\n## Loop Directory\n" + lDir;

      // Create a new session for crafting
      var craftingSession = sm.createSession();
      var craftName = (loopState.wizardData && loopState.wizardData.name) || "";
      var isRalphCraft = recordSource === "ralph";
      craftingSession.title = (isRalphCraft ? "Ralph" : "Task") + (craftName ? " " + craftName : "") + " Crafting";
      craftingSession.ralphCraftingMode = true;
      craftingSession.loop = { active: true, iteration: 0, role: "crafting", loopId: newLoopId, name: craftName, source: recordSource };
      sm.saveSessionFile(craftingSession);
      sm.switchSession(craftingSession.localId);
      loopState.craftingSessionId = craftingSession.localId;

      // Store crafting session ID in the registry record
      loopRegistry.updateRecord(newLoopId, { craftingSessionId: craftingSession.localId });

      // Start .claude/ directory watcher
      startClaudeDirWatch();

      // Send crafting prompt and start the conversation with Claude.
      craftingSession.history.push({ type: "user_message", text: craftingPrompt });
      sm.appendToSessionFile(craftingSession, { type: "user_message", text: craftingPrompt });
      sendToSession(craftingSession.localId, { type: "user_message", text: craftingPrompt });
      craftingSession.isProcessing = true;
      onProcessingChanged();
      craftingSession.sentToolResults = {};
      sendToSession(craftingSession.localId, { type: "status", status: "processing" });
      sdkForSession(craftingSession).startQuery(craftingSession, craftingPrompt, undefined, getLinuxUserForSession(craftingSession));

      send({ type: "ralph_crafting_started", sessionId: craftingSession.localId, taskId: newLoopId, source: recordSource });
      send({ type: "ralph_phase", phase: "crafting", wizardData: loopState.wizardData, craftingSessionId: craftingSession.localId });
      return;
    }

    if (msg.type === "loop_registry_files") {
      var recId = msg.id;
      var lDir = path.join(cwd, ".claude", "loops", recId);
      var promptContent = "";
      var judgeContent = "";
      try { promptContent = fs.readFileSync(path.join(lDir, "PROMPT.md"), "utf8"); } catch (e) {}
      try { judgeContent = fs.readFileSync(path.join(lDir, "JUDGE.md"), "utf8"); } catch (e) {}
      send({
        type: "loop_registry_files_content",
        id: recId,
        prompt: promptContent,
        judge: judgeContent,
      });
      return;
    }

    if (msg.type === "ralph_preview_files") {
      var promptContent = "";
      var judgeContent = "";
      var previewDir = loopDir();
      if (previewDir) {
        try { promptContent = fs.readFileSync(path.join(previewDir, "PROMPT.md"), "utf8"); } catch (e) {}
        try { judgeContent = fs.readFileSync(path.join(previewDir, "JUDGE.md"), "utf8"); } catch (e) {}
      }
      sendTo(ws, {
        type: "ralph_files_content",
        prompt: promptContent,
        judge: judgeContent,
      });
      return;
    }

    if (msg.type === "ralph_wizard_cancel") {
      stopClaudeDirWatch();
      // Clean up loop directory
      var cancelDir = loopDir();
      if (cancelDir) {
        try { fs.rmSync(cancelDir, { recursive: true, force: true }); } catch (e) {}
      }
      clearLoopState();
      send({ type: "ralph_phase", phase: "idle", wizardData: null });
      return;
    }

    if (msg.type === "ralph_cancel_crafting") {
      // Abort the crafting session if running
      if (loopState.craftingSessionId != null) {
        var craftSession = sm.sessions.get(loopState.craftingSessionId) || null;
        if (craftSession && craftSession.abortController) {
          craftSession.abortController.abort();
        }
      }
      stopClaudeDirWatch();
      // Clean up loop directory
      var craftCancelDir = loopDir();
      if (craftCancelDir) {
        try { fs.rmSync(craftCancelDir, { recursive: true, force: true }); } catch (e) {}
      }
      clearLoopState();
      send({ type: "ralph_phase", phase: "idle", wizardData: null });
      return;
    }

    // --- Schedule create (from calendar click) ---
    if (msg.type === "schedule_create") {
      var sData = msg.data || {};
      var newRec = loopRegistry.register({
        name: sData.name || "Untitled",
        task: sData.name || "",
        description: sData.description || "",
        date: sData.date || null,
        time: sData.time || null,
        allDay: sData.allDay !== undefined ? sData.allDay : true,
        linkedTaskId: sData.taskId || null,
        cron: sData.cron || null,
        enabled: sData.cron ? (sData.enabled !== false) : false,
        maxIterations: sData.maxIterations || 3,
        source: "schedule",
        color: sData.color || null,
        recurrenceEnd: sData.recurrenceEnd || null,
      });
      return;
    }

    // --- Hub: cross-project schedule aggregation ---
    if (msg.type === "hub_schedules_list") {
      sendTo(ws, { type: "hub_schedules", schedules: getHubSchedules() });
      return;
    }

    // --- Loop Registry messages ---
    if (msg.type === "loop_registry_list") {
      sendTo(ws, { type: "loop_registry_updated", records: getHubSchedules() });
      return;
    }

    if (msg.type === "loop_registry_update") {
      var updatedRec = loopRegistry.update(msg.id, msg.data || {});
      if (!updatedRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
      }
      return;
    }

    if (msg.type === "loop_registry_rename") {
      if (msg.id && msg.name) {
        loopRegistry.updateRecord(msg.id, { name: String(msg.name).substring(0, 100) });
        sm.broadcastSessionList();
      }
      return;
    }

    if (msg.type === "loop_registry_remove") {
      var removedRec = loopRegistry.remove(msg.id);
      if (!removedRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
      }
      return;
    }

    if (msg.type === "loop_registry_convert") {
      // Convert ralph source to regular task (remove source tag)
      if (msg.id) {
        loopRegistry.updateRecord(msg.id, { source: null });
        sm.broadcastSessionList();
      }
      return;
    }

    if (msg.type === "delete_loop_group") {
      // Delete all sessions belonging to this loopId, then remove registry record
      var loopIdToDel = msg.loopId;
      if (!loopIdToDel) return;
      var sessionIds = [];
      sm.sessions.forEach(function (s, lid) {
        if (s.loop && s.loop.loopId === loopIdToDel) sessionIds.push(lid);
      });
      for (var di = 0; di < sessionIds.length; di++) {
        sm.deleteSessionQuiet(sessionIds[di]);
      }
      loopRegistry.remove(loopIdToDel);
      sm.broadcastSessionList();
      return;
    }

    if (msg.type === "loop_registry_toggle") {
      var toggledRec = loopRegistry.toggleEnabled(msg.id);
      if (!toggledRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found or not scheduled" });
      }
      return;
    }

    if (msg.type === "loop_registry_rerun") {
      // Re-run an existing job (one-off from library)
      if (loopState.active || loopState.phase === "executing") {
        sendTo(ws, { type: "loop_registry_error", text: "A loop is already running" });
        return;
      }
      var rerunRec = loopRegistry.getById(msg.id);
      if (!rerunRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
        return;
      }
      var rerunDir = path.join(cwd, ".claude", "loops", rerunRec.id);
      try {
        fs.accessSync(path.join(rerunDir, "PROMPT.md"));
        fs.accessSync(path.join(rerunDir, "JUDGE.md"));
      } catch (e) {
        sendTo(ws, { type: "loop_registry_error", text: "Loop files missing for " + rerunRec.id });
        return;
      }
      loopState.loopId = rerunRec.id;
      activeRegistryId = null; // not a scheduled trigger
      send({ type: "loop_rerun_started", recordId: rerunRec.id });
      startLoop();
      return;
    }

    if (msg.type !== "message") return;
    if (!msg.text && (!msg.images || msg.images.length === 0) && (!msg.pastes || msg.pastes.length === 0)) return;

    var session = getSessionForWs(ws);
    if (!session) return;

    // Backfill ownerId for legacy sessions restored without one
    if (!session.ownerId && ws._clayUser) {
      session.ownerId = ws._clayUser.id;
      sm.saveSessionFile(session);
    }

    var userMsg = { type: "user_message", text: msg.text || "" };
    if (msg.images && msg.images.length > 0) {
      userMsg.imageCount = msg.images.length;
    }
    if (msg.pastes && msg.pastes.length > 0) {
      userMsg.pastes = msg.pastes;
    }
    if (msg.clientMsgId) {
      userMsg.clientMsgId = msg.clientMsgId;
    }
    userMsg.seq = session.history.length;
    session.history.push(userMsg);
    sm.appendToSessionFile(session, userMsg);
    sendToSession(session.localId, userMsg);

    if (!session.title) {
      session.title = (msg.text || "Image").substring(0, 50);
      sm.saveSessionFile(session);
      sm.broadcastSessionList();
      // Sync auto-title to SDK
      if (session.cliSessionId) {
        getSDK().then(function(sdk) {
          sdk.renameSession(session.cliSessionId, session.title, { dir: cwd }).catch(function(e) {
            console.error("[project] SDK renameSession failed:", e.message);
          });
        }).catch(function() {});
      }
    }

    var fullText = msg.text || "";
    if (msg.pastes && msg.pastes.length > 0) {
      for (var pi = 0; pi < msg.pastes.length; pi++) {
        if (fullText) fullText += "\n\n";
        fullText += msg.pastes[pi];
      }
    }

    if (!session.isProcessing) {
      session.isProcessing = true;
      onProcessingChanged();
      session.sentToolResults = {};
      sendToSession(session.localId, { type: "status", status: "processing" });
      var _msgSdk = sdkForSession(session);
      if (!session.queryInstance && !session.worker) {
        _msgSdk.startQuery(session, fullText, msg.images, getLinuxUserForSession(session));
      } else {
        _msgSdk.pushMessage(session, fullText, msg.images);
      }
    } else {
      sdkForSession(session).pushMessage(session, fullText, msg.images);
    }
    sm.broadcastSessionList();
  }

  // --- Session presence (who is viewing which session) ---
  function broadcastPresence() {
    if (!usersModule.isMultiUser()) return;
    var presence = {};
    for (var c of clients) {
      if (!c._clayUser || !c._clayActiveSession) continue;
      var sid = c._clayActiveSession;
      if (!presence[sid]) presence[sid] = [];
      var u = c._clayUser;
      var p = u.profile || {};
      // Deduplicate: skip if this user is already listed for this session
      var dominated = false;
      for (var di = 0; di < presence[sid].length; di++) {
        if (presence[sid][di].id === u.id) { dominated = true; break; }
      }
      if (dominated) continue;
      presence[sid].push({
        id: u.id,
        displayName: p.name || u.displayName || u.username,
        username: u.username,
        avatarStyle: p.avatarStyle || "thumbs",
        avatarSeed: p.avatarSeed || u.username,
      });
    }
    send({ type: "session_presence", presence: presence });
  }

  // --- WS disconnection handler ---
  function handleDisconnection(ws) {
    tm.detachAll(ws);
    clients.delete(ws);
    if (clients.size === 0) {
      stopFileWatch();
      stopAllDirWatches();
    }
    broadcastClientCount();
    broadcastPresence();
  }

  // --- Handle project-scoped HTTP requests ---
  function handleHTTP(req, res, urlPath) {
    // File upload
    if (req.method === "POST" && urlPath === "/api/upload") {
      parseJsonBody(req).then(function (body) {
        var fileName = body.name;
        var fileData = body.data; // base64
        if (!fileName || !fileData) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing name or data"}');
          return;
        }
        // Sanitize filename — strip path separators
        var safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._\-\(\)\[\] ]/g, "_");
        if (!safeName) safeName = "upload";

        // Check size
        var estimatedBytes = fileData.length * 0.75;
        if (estimatedBytes > MAX_UPLOAD_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end('{"error":"file too large (max 50MB)"}');
          return;
        }

        // Create tmp dir: os.tmpdir()/clay-{hash}/
        var cwdHash = crypto.createHash("sha256").update(cwd).digest("hex").substring(0, 12);
        var tmpDir = path.join(os.tmpdir(), "clay-" + cwdHash);
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}

        // Add timestamp prefix to avoid collisions
        var ts = Date.now();
        var destName = ts + "-" + safeName;
        var destPath = path.join(tmpDir, destName);

        try {
          var buf = Buffer.from(fileData, "base64");
          fs.writeFileSync(destPath, buf);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ path: destPath, name: safeName }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "failed to save: " + (e.message || e) }));
        }
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // Push subscribe
    if (req.method === "POST" && urlPath === "/api/push-subscribe") {
      parseJsonBody(req).then(function (body) {
        var sub = body.subscription || body;
        if (pushModule) pushModule.addSubscription(sub, body.replaceEndpoint);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // Permission response from push notification
    if (req.method === "POST" && urlPath === "/api/permission-response") {
      parseJsonBody(req).then(function (data) {
        var requestId = data.requestId;
        var decision = data.decision;
        if (!requestId || !decision) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing requestId or decision"}');
          return;
        }
        var found = false;
        sm.sessions.forEach(function (session) {
          var pending = session.pendingPermissions[requestId];
          if (!pending) return;
          found = true;
          delete session.pendingPermissions[requestId];
          if (decision === "allow") {
            pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
          } else {
            pending.resolve({ behavior: "deny", message: "Denied via push notification" });
          }
          sm.sendAndRecord(session, {
            type: "permission_resolved",
            requestId: requestId,
            decision: decision,
          });
        });
        if (found) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end('{"error":"permission request not found"}');
        }
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // VAPID public key
    if (req.method === "GET" && urlPath === "/api/vapid-public-key") {
      if (pushModule) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache, no-store" });
        res.end(JSON.stringify({ publicKey: pushModule.publicKey }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"push not available"}');
      }
      return true;
    }

    // File browser: serve project images
    if (req.method === "GET" && urlPath.startsWith("/api/file?")) {
      var qIdx = urlPath.indexOf("?");
      var params = new URLSearchParams(urlPath.substring(qIdx));
      var reqFilePath = params.get("path");
      if (!reqFilePath) { res.writeHead(400); res.end("Missing path"); return true; }
      var absFile = safePath(cwd, reqFilePath);
      if (!absFile) { res.writeHead(403); res.end("Access denied"); return true; }
      var fileExt = path.extname(absFile).toLowerCase();
      if (!IMAGE_EXTS.has(fileExt)) { res.writeHead(403); res.end("Only image files"); return true; }
      try {
        var fileServeUserInfo = getOsUserInfoForReq(req);
        var fileContent;
        if (fileServeUserInfo) {
          var binResult = fsAsUser("read_binary", { file: absFile }, fileServeUserInfo);
          fileContent = binResult.buffer;
        } else {
          fileContent = fs.readFileSync(absFile);
        }
        var fileMime = MIME_TYPES[fileExt] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": fileMime, "Cache-Control": "no-cache" });
        res.end(fileContent);
      } catch (e) {
        res.writeHead(404); res.end("Not found");
      }
      return true;
    }

    // Install a skill (background spawn)
    if (req.method === "POST" && urlPath === "/api/install-skill") {
      parseJsonBody(req).then(function (body) {
        var url = body.url;
        var skill = body.skill;
        var scope = body.scope; // "global" or "project"
        if (!url || !skill || !scope) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing url, skill, or scope"}');
          return;
        }
        // Validate skill name: alphanumeric, hyphens, underscores only
        if (!/^[a-zA-Z0-9_-]+$/.test(skill)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"invalid skill name"}');
          return;
        }
        // Validate URL: must be https://
        if (!/^https:\/\//i.test(url)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"only https:// URLs are allowed"}');
          return;
        }
        var skillUserInfo = getOsUserInfoForReq(req);
        var spawnCwd = scope === "global" ? (skillUserInfo ? skillUserInfo.home : os.homedir()) : cwd;
        var scopeFlag = scope === "global" ? "--global" : "--project";
        var skillSpawnOpts = {
          cwd: spawnCwd,
          stdio: "ignore",
          detached: false,
        };
        if (skillUserInfo) {
          skillSpawnOpts.uid = skillUserInfo.uid;
          skillSpawnOpts.gid = skillUserInfo.gid;
        }
        var child = spawn("npx", ["skills", "add", url, "--skill", skill, "--yes", scopeFlag], skillSpawnOpts);
        child.on("close", function (code) {
          var success = code === 0;
          send({
            type: "skill_installed",
            skill: skill,
            scope: scope,
            success: success,
            error: success ? null : "Process exited with code " + code,
          });
        });
        child.on("error", function (err) {
          send({
            type: "skill_installed",
            skill: skill,
            scope: scope,
            success: false,
            error: err.message,
          });
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // Uninstall a skill (remove directory)
    if (req.method === "POST" && urlPath === "/api/uninstall-skill") {
      parseJsonBody(req).then(function (body) {
        var skill = body.skill;
        var scope = body.scope; // "global" or "project"
        if (!skill || !scope) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing skill or scope"}');
          return;
        }
        // Validate skill name
        if (!/^[a-zA-Z0-9_-]+$/.test(skill)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"invalid skill name"}');
          return;
        }
        var uninstallUserInfo = getOsUserInfoForReq(req);
        var baseDir = scope === "global" ? (uninstallUserInfo ? uninstallUserInfo.home : os.homedir()) : cwd;
        var skillDir = path.join(baseDir, ".claude", "skills", skill);
        // Safety: ensure skillDir is inside the expected .claude/skills directory
        var expectedParent = path.join(baseDir, ".claude", "skills");
        var resolved = path.resolve(skillDir);
        if (!resolved.startsWith(expectedParent + path.sep)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end('{"error":"invalid skill path"}');
          return;
        }
        try {
          if (uninstallUserInfo) {
            // Run rm as target user to respect permissions
            var rmScript = "var fs = require('fs'); fs.rmSync(" + JSON.stringify(resolved) + ", { recursive: true, force: true });";
            execFileSync(process.execPath, ["-e", rmScript], {
              uid: uninstallUserInfo.uid,
              gid: uninstallUserInfo.gid,
              timeout: 10000,
            });
          } else {
            fs.rmSync(resolved, { recursive: true, force: true });
          }
          send({
            type: "skill_uninstalled",
            skill: skill,
            scope: scope,
            success: true,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (err) {
          send({
            type: "skill_uninstalled",
            skill: skill,
            scope: scope,
            success: false,
            error: err.message,
          });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // Installed skills (global + project)
    if (req.method === "GET" && urlPath === "/api/installed-skills") {
      var installed = {};
      var globalDir = path.join(os.homedir(), ".claude", "skills");
      var projectDir = path.join(cwd, ".claude", "skills");
      var scanDirs = [
        { dir: globalDir, scope: "global" },
        { dir: projectDir, scope: "project" },
      ];
      for (var sd = 0; sd < scanDirs.length; sd++) {
        var entries;
        try { entries = fs.readdirSync(scanDirs[sd].dir, { withFileTypes: true }); } catch (e) { continue; }
        for (var si = 0; si < entries.length; si++) {
          var ent = entries[si];
          if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
          var mdPath = path.join(scanDirs[sd].dir, ent.name, "SKILL.md");
          try {
            var mdContent = fs.readFileSync(mdPath, "utf8");
            var desc = "";
            // Parse YAML frontmatter for description
            if (mdContent.startsWith("---")) {
              var endIdx = mdContent.indexOf("---", 3);
              if (endIdx !== -1) {
                var frontmatter = mdContent.substring(3, endIdx);
                var descMatch = frontmatter.match(/^description:\s*(.+)/m);
                if (descMatch) desc = descMatch[1].trim();
              }
            }
            if (!installed[ent.name]) {
              installed[ent.name] = { scope: scanDirs[sd].scope, description: desc, path: path.join(scanDirs[sd].dir, ent.name) };
            } else {
              // project-level adds to existing global entry
              installed[ent.name].scope = "both";
              if (desc && !installed[ent.name].description) installed[ent.name].description = desc;
            }
          } catch (e) {}
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ installed: installed }));
      return true;
    }

    // Git dirty check
    if (req.method === "GET" && urlPath === "/api/git-dirty") {
      var execSync = require("child_process").execSync;
      try {
        var out = execSync("git status --porcelain", { cwd: cwd, encoding: "utf8", timeout: 5000 });
        var dirty = out.trim().length > 0;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dirty: dirty }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dirty: false }));
      }
      return true;
    }

    // List branches for worktree modal
    if (req.method === "GET" && urlPath === "/api/branches") {
      try {
        var brRaw = execFileSync("git", ["branch", "-a", "--format=%(refname:short)"], {
          cwd: cwd, timeout: 5000, encoding: "utf8"
        });
        var brList = brRaw.trim().split("\n").filter(Boolean);
        var defBr = "main";
        try {
          var hrRef = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
            cwd: cwd, timeout: 3000, encoding: "utf8"
          }).trim();
          defBr = hrRef.replace(/^origin\//, "");
        } catch (e) {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ branches: brList, defaultBranch: defBr }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ branches: ["main"], defaultBranch: "main" }));
      }
      return true;
    }

    // Info endpoint
    if (req.method === "GET" && urlPath === "/info") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ cwd: cwd, project: project, slug: slug }));
      return true;
    }

    return false; // not handled
  }

  // --- Destroy ---
  function destroy() {
    loopRegistry.stopTimer();
    stopFileWatch();
    stopAllDirWatches();
    // Abort all active sessions
    sm.sessions.forEach(function (session) {
      session.destroying = true;
      if (session.abortController) {
        try { session.abortController.abort(); } catch (e) {}
      }
      if (session.messageQueue) {
        try { session.messageQueue.end(); } catch (e) {}
      }
    });
    // Kill all terminals
    tm.destroyAll();
    for (var ws of clients) {
      try { ws.close(); } catch (e) {}
    }
    clients.clear();
    // Cleanup tmp upload directory
    try {
      var cwdHash = crypto.createHash("sha256").update(cwd).digest("hex").substring(0, 12);
      var tmpDir = path.join(os.tmpdir(), "clay-" + cwdHash);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }

  // --- Status info ---
  function getStatus() {
    var sessionCount = sm.sessions.size;
    var hasProcessing = false;
    sm.sessions.forEach(function (s) {
      if (s.isProcessing) hasProcessing = true;
    });
    var status = {
      slug: slug,
      path: cwd,
      project: project,
      title: title,
      icon: icon,
      clients: clients.size,
      sessions: sessionCount,
      isProcessing: hasProcessing,
      projectOwnerId: projectOwnerId,
      backend: backend,
    };
    if (worktreeMeta) {
      status.isWorktree = true;
      status.parentSlug = worktreeMeta.parentSlug;
      status.branch = worktreeMeta.branch;
      status.worktreeAccessible = worktreeMeta.accessible;
    }
    if (usersModule.isMultiUser()) {
      var seen = {};
      var onlineUsers = [];
      for (var c of clients) {
        if (!c._clayUser) continue;
        var u = c._clayUser;
        if (seen[u.id]) continue;
        seen[u.id] = true;
        var p = u.profile || {};
        onlineUsers.push({
          id: u.id,
          displayName: p.name || u.displayName || u.username,
          username: u.username,
          avatarStyle: p.avatarStyle || "thumbs",
          avatarSeed: p.avatarSeed || u.username,
        });
      }
      status.onlineUsers = onlineUsers;
    }
    return status;
  }

  function setTitle(newTitle) {
    title = newTitle || null;
    // Iter 3: setTitle is a project-wide broadcast — it has no per-client
    // active session in scope. Omit `backend` and `capabilities` so a
    // client whose active session differs from the project default does
    // NOT have its UI clobbered to the default. `defaultBackend` is fine
    // to broadcast because it IS project-wide. The frontend treats a
    // missing `backend` field as "don't touch my active-session UI state."
    send({ type: "info", cwd: cwd, slug: slug, project: title || project, version: currentVersion, debug: !!debug, osUsers: osUsers, lanHost: lanHost, projectCount: getProjectCount(), projects: getProjectList(), projectOwnerId: projectOwnerId, defaultBackend: backend, codex: computeCodexAvailability() });
  }

  function setIcon(newIcon) {
    icon = newIcon || null;
  }

  return {
    cwd: cwd,
    slug: slug,
    project: project,
    clients: clients,
    sm: sm,
    // Iter 2: expose the lazy backend resolver instead of a single SDK.
    // No external caller currently reads this — it's documented as the
    // contract, used by tests, and a stable seam for future helpers
    // (e.g., a multi-backend status panel) without forcing them to
    // re-discover the routing rule.
    sdkForSession: sdkForSession,
    defaultSdk: defaultSdk,
    send: send,
    sendTo: sendTo,
    forEachClient: function (fn) {
      for (var ws of clients) {
        if (ws.readyState === 1) fn(ws);
      }
    },
    handleConnection: handleConnection,
    handleMessage: handleMessage,
    handleDisconnection: handleDisconnection,
    handleHTTP: handleHTTP,
    getStatus: getStatus,
    getSchedules: function () { return loopRegistry.getAll(); },
    importSchedule: function (data) { return loopRegistry.register(data); },
    removeSchedule: function (id) { return loopRegistry.remove(id); },
    setTitle: setTitle,
    setIcon: setIcon,
    setProjectOwner: function (ownerId) { projectOwnerId = ownerId; },
    getProjectOwner: function () { return projectOwnerId; },
    refreshUserProfile: function (userId) {
      var user = usersModule.findUserById(userId);
      if (!user) return;
      for (var ws of clients) {
        if (ws._clayUser && ws._clayUser.id === userId) {
          ws._clayUser = user;
        }
      }
      broadcastClientCount();
      broadcastPresence();
    },
    warmup: function () {
      // Iter 2: warm up ONLY the project default backend. The non-default
      // backend (if any sessions of it exist) boots lazily on first send.
      // This matches today's behavior exactly while keeping the lazy-init
      // policy honest — no resource cost for backends that aren't in use.
      defaultSdk().warmup();
      // Migrate existing relay session titles to SDK format (one-time, async)
      sm.migrateSessionTitles(getSDK, cwd);
    },
    destroy: destroy,
  };
}

function parseJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var body = "";
    req.on("data", function (chunk) { body += chunk; });
    req.on("end", function () {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

module.exports = { createProjectContext: createProjectContext, safePath: safePath, validateEnvString: validateEnvString };
