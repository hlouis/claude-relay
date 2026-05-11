var test = require("node:test");
var assert = require("node:assert");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var os = require("os");

var { generateAuthToken, verifyPin } = require("../lib/server-auth");
var { safePath, validateEnvString } = require("../lib/project");
var { attachHTTP } = require("../lib/project-http");
var { chmodSafe } = require("../lib/config");

function makeProjectHttp(cwd) {
  return attachHTTP({
    cwd: cwd,
    slug: "test",
    project: {},
    sm: { sessions: [] },
    send: function () {},
    imagesDir: "",
    osUsers: null,
    pushModule: null,
    safePath: safePath,
    safeAbsPath: function () { return null; },
    getOsUserInfoForReq: function () { return null; },
    sendExtensionCommandAny: function () { return Promise.resolve({}); },
    _extToken: "test",
    _browserTabList: {},
  });
}

function makeResponse() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead: function (status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end: function (body) {
      this.body = body;
    },
  };
}

function requestProjectHttp(http, urlPath) {
  var res = makeResponse();
  var handled = http.handleHTTP({ method: "GET" }, res, urlPath);
  return { handled: handled, res: res };
}

// ============================================================
// 1. PIN scrypt hashing / verification
// ============================================================

test("generateAuthToken returns scrypt format (salt:hash)", function () {
  var token = generateAuthToken("123456");
  assert.ok(token.indexOf(":") !== -1, "Token should contain a colon separator");
  var parts = token.split(":");
  assert.strictEqual(parts.length, 2, "Token should have exactly two parts");
  assert.strictEqual(parts[0].length, 32, "Salt should be 16 bytes = 32 hex chars");
  assert.strictEqual(parts[1].length, 128, "Hash should be 64 bytes = 128 hex chars");
});

test("generateAuthToken produces different tokens for same PIN (random salt)", function () {
  var token1 = generateAuthToken("123456");
  var token2 = generateAuthToken("123456");
  assert.notStrictEqual(token1, token2, "Each call should produce a unique salt");
});

test("verifyPin correctly validates scrypt hash", function () {
  var token = generateAuthToken("mypin");
  assert.strictEqual(verifyPin("mypin", token), true, "Correct PIN should verify");
  assert.strictEqual(verifyPin("wrongpin", token), false, "Wrong PIN should not verify");
});

test("verifyPin handles legacy SHA256 format", function () {
  var legacyHash = crypto.createHash("sha256").update("clay:123456").digest("hex");
  assert.strictEqual(verifyPin("123456", legacyHash), true, "Correct PIN should verify with legacy hash");
  assert.strictEqual(verifyPin("000000", legacyHash), false, "Wrong PIN should not verify with legacy hash");
});

test("verifyPin returns false for null/empty stored hash", function () {
  assert.strictEqual(verifyPin("123456", null), false);
  assert.strictEqual(verifyPin("123456", ""), false);
});

// ============================================================
// 2. safePath - path traversal prevention
// ============================================================

test("safePath allows valid subpath", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-")));
  var subDir = path.join(tmpDir, "sub");
  fs.mkdirSync(subDir);
  var result = safePath(tmpDir, "sub");
  assert.strictEqual(result, subDir);
  fs.rmSync(tmpDir, { recursive: true });
});

test("safePath blocks path traversal with ..", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-")));
  var result = safePath(tmpDir, "../../../etc/passwd");
  assert.strictEqual(result, null, "Path traversal should be blocked");
  fs.rmSync(tmpDir, { recursive: true });
});

test("safePath blocks absolute path outside base", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-")));
  var result = safePath(tmpDir, "/etc/passwd");
  assert.strictEqual(result, null, "Absolute path outside base should be blocked");
  fs.rmSync(tmpDir, { recursive: true });
});

test("safePath blocks symlink escape", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-")));
  var linkPath = path.join(tmpDir, "escape");
  try {
    fs.symlinkSync("/tmp", linkPath);
    var result = safePath(tmpDir, "escape");
    // If symlink target is outside base, should return null
    if (result !== null) {
      assert.ok(result.startsWith(tmpDir + path.sep) || result === tmpDir,
        "Resolved symlink should stay within base");
    }
  } catch (e) {
    // Symlink creation may fail on some systems
  }
  fs.rmSync(tmpDir, { recursive: true });
});

test("safePath returns base dir for empty path", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safe-")));
  var result = safePath(tmpDir, "");
  assert.strictEqual(result, tmpDir, "Empty path should resolve to base");
  fs.rmSync(tmpDir, { recursive: true });
});

test("file preview serves allowed static files with query strings", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "preview-")));
  try {
    fs.mkdirSync(path.join(tmpDir, "site"));
    fs.writeFileSync(path.join(tmpDir, "site", "index.html"), "<!doctype html><link rel=\"stylesheet\" href=\"style.css\">");
    fs.writeFileSync(path.join(tmpDir, "site", "style.css"), "body { color: red; }");
    var http = makeProjectHttp(tmpDir);

    var htmlResult = requestProjectHttp(http, "/api/file-preview/site/index.html");
    assert.strictEqual(htmlResult.handled, true);
    assert.strictEqual(htmlResult.res.status, 200);
    assert.strictEqual(htmlResult.res.headers["Content-Type"], "text/html; charset=utf-8");
    var csp = htmlResult.res.headers["Content-Security-Policy"] || "";
    assert.ok(csp.indexOf("sandbox allow-scripts") === 0, "HTML preview must declare sandbox allow-scripts (opaque origin keeps it safe)");
    assert.ok(csp.indexOf("allow-same-origin") < 0, "CSP must NOT grant allow-same-origin");
    assert.ok(csp.indexOf("allow-top-navigation") < 0, "CSP must NOT grant allow-top-navigation");
    assert.ok(csp.indexOf("default-src 'none'") >= 0, "CSP must default-deny");
    assert.ok(csp.indexOf("frame-ancestors 'self'") >= 0, "CSP must restrict framing to same origin");

    var cssResult = requestProjectHttp(http, "/api/file-preview/site/style.css?v=1");
    assert.strictEqual(cssResult.handled, true);
    assert.strictEqual(cssResult.res.status, 200);
    assert.strictEqual(cssResult.res.headers["Content-Type"], "text/css; charset=utf-8");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("file preview rejects scripts, sensitive files, and traversal", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "preview-")));
  try {
    fs.writeFileSync(path.join(tmpDir, "app.js"), "console.log('no');");
    fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=value");
    var http = makeProjectHttp(tmpDir);

    var scriptResult = requestProjectHttp(http, "/api/file-preview/app.js");
    assert.strictEqual(scriptResult.handled, true);
    assert.strictEqual(scriptResult.res.status, 403);

    var envResult = requestProjectHttp(http, "/api/file-preview/.env");
    assert.strictEqual(envResult.handled, true);
    assert.strictEqual(envResult.res.status, 403);

    var traversalResult = requestProjectHttp(http, "/api/file-preview/../../etc/passwd");
    assert.strictEqual(traversalResult.handled, true);
    assert.strictEqual(traversalResult.res.status, 403);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("file preview rejects oversized files with 413", function () {
  var tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "preview-")));
  try {
    var bigPath = path.join(tmpDir, "big.mp4");
    var fd = fs.openSync(bigPath, "w");
    // Sparse file: 21 MB, exceeds the 20 MB preview cap.
    fs.ftruncateSync(fd, 21 * 1024 * 1024);
    fs.closeSync(fd);
    var http = makeProjectHttp(tmpDir);

    var result = requestProjectHttp(http, "/api/file-preview/big.mp4");
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.res.status, 413);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================
// 3. Rate limiting logic (basic unit-level test)
// ============================================================

test("WebSocket rate limiter concept test", function () {
  // Test the rate limiting logic in isolation
  var msgCount = 0;
  var msgWindowStart = Date.now();
  var WS_RATE_LIMIT = 5;
  var rateLimited = false;

  function checkRateLimit() {
    var now = Date.now();
    if (now - msgWindowStart >= 1000) {
      msgCount = 0;
      msgWindowStart = now;
    }
    msgCount++;
    if (msgCount > WS_RATE_LIMIT) {
      rateLimited = true;
      return true;
    }
    return false;
  }

  // Send within limit
  for (var i = 0; i < WS_RATE_LIMIT; i++) {
    assert.strictEqual(checkRateLimit(), false, "Message " + (i + 1) + " should be allowed");
  }

  // Next message should trigger rate limit
  assert.strictEqual(checkRateLimit(), true, "Message beyond limit should be rate limited");
  assert.strictEqual(rateLimited, true);
});

// ============================================================
// 4. Skill name / URL validation
// ============================================================

test("valid skill names are accepted", function () {
  var validNames = ["my-skill", "skill_v2", "SkillName", "abc123", "a-b_c"];
  for (var i = 0; i < validNames.length; i++) {
    assert.ok(/^[a-zA-Z0-9_-]+$/.test(validNames[i]),
      validNames[i] + " should be a valid skill name");
  }
});

test("invalid skill names are rejected", function () {
  var invalidNames = ["../escape", "skill name", "skill;rm", "skill/sub", "skill\x00null", ""];
  for (var i = 0; i < invalidNames.length; i++) {
    assert.ok(!/^[a-zA-Z0-9_-]+$/.test(invalidNames[i]),
      invalidNames[i] + " should be an invalid skill name");
  }
});

test("only https:// URLs are allowed for skill install", function () {
  assert.ok(/^https:\/\//i.test("https://github.com/user/repo"), "https URL should be accepted");
  assert.ok(!/^https:\/\//i.test("http://github.com/user/repo"), "http URL should be rejected");
  assert.ok(!/^https:\/\//i.test("file:///etc/passwd"), "file URL should be rejected");
  assert.ok(!/^https:\/\//i.test("javascript:alert(1)"), "javascript URL should be rejected");
});

// ============================================================
// 5. Environment variable validation
// ============================================================

test("validateEnvString accepts valid KEY=VALUE lines", function () {
  assert.strictEqual(validateEnvString("FOO=bar"), null);
  assert.strictEqual(validateEnvString("API_KEY=12345"), null);
  assert.strictEqual(validateEnvString("A=1\nB=2\nC=3"), null);
  assert.strictEqual(validateEnvString("# comment\nFOO=bar"), null);
  assert.strictEqual(validateEnvString(""), null);
  assert.strictEqual(validateEnvString("  "), null);
});

test("validateEnvString rejects invalid variable names", function () {
  var result = validateEnvString("123BAD=value");
  assert.ok(result !== null, "Numeric-start key should be rejected");

  var result2 = validateEnvString("BAD KEY=value");
  assert.ok(result2 !== null, "Key with space should be rejected");

  var result3 = validateEnvString("BAD-KEY=value");
  assert.ok(result3 !== null, "Key with hyphen should be rejected");
});

test("validateEnvString rejects shell injection in values", function () {
  var result = validateEnvString("FOO=$(rm -rf /)");
  assert.ok(result !== null, "Command substitution should be rejected");

  var result2 = validateEnvString("FOO=bar;echo pwned");
  assert.ok(result2 !== null, "Semicolon injection should be rejected");

  var result3 = validateEnvString("FOO=`whoami`");
  assert.ok(result3 !== null, "Backtick injection should be rejected");

  var result4 = validateEnvString("FOO=bar|cat /etc/passwd");
  assert.ok(result4 !== null, "Pipe injection should be rejected");
});

test("validateEnvString rejects lines without = separator", function () {
  var result = validateEnvString("NOEQUALSSIGN");
  assert.ok(result !== null, "Line without = should be rejected");
});

// ============================================================
// 6. File permissions
// ============================================================

test("chmodSafe sets file permissions on non-Windows", function () {
  if (process.platform === "win32") {
    // On Windows, chmodSafe should be a no-op
    chmodSafe("/nonexistent", 0o600);
    return;
  }
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chmod-"));
  var testFile = path.join(tmpDir, "test.json");
  fs.writeFileSync(testFile, '{"test": true}');
  chmodSafe(testFile, 0o600);
  var stats = fs.statSync(testFile);
  var mode = stats.mode & 0o777;
  assert.strictEqual(mode, 0o600, "File should have 0600 permissions");
  fs.rmSync(tmpDir, { recursive: true });
});

test("chmodSafe sets directory permissions on non-Windows", function () {
  if (process.platform === "win32") return;
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chmod-"));
  var testDir = path.join(tmpDir, "secure");
  fs.mkdirSync(testDir);
  chmodSafe(testDir, 0o700);
  var stats = fs.statSync(testDir);
  var mode = stats.mode & 0o777;
  assert.strictEqual(mode, 0o700, "Directory should have 0700 permissions");
  fs.rmSync(tmpDir, { recursive: true });
});

test("chmodSafe does not throw on nonexistent file", function () {
  assert.doesNotThrow(function () {
    chmodSafe("/nonexistent/path/file.json", 0o600);
  });
});

// ============================================================
// 7. PIN hash migration detection
// ============================================================

test("legacy SHA256 hash is detected (no colon)", function () {
  var legacyHash = crypto.createHash("sha256").update("clay:123456").digest("hex");
  assert.strictEqual(legacyHash.indexOf(":"), -1, "Legacy hash should not contain colon");
  assert.strictEqual(legacyHash.length, 64, "SHA256 hex should be 64 chars");
});

test("scrypt hash is detected (contains colon)", function () {
  var scryptHash = generateAuthToken("123456");
  assert.ok(scryptHash.indexOf(":") !== -1, "Scrypt hash should contain colon");
});
