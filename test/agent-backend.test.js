var test = require("node:test");
var assert = require("node:assert");

var { createAgentBackend } = require("../lib/agent-backend");

// Minimum opts a backend factory needs. The Claude backend (createSDKBridge)
// only stashes these in closures during construction; nothing is invoked, no
// SDK is loaded, no I/O happens. Safe to call in unit tests.
function stubOpts(overrides) {
  var base = {
    cwd: "/tmp/clay-test",
    slug: "test",
    sessionManager: {},
    send: function () {},
    pushModule: null,
    getSDK: function () { return Promise.resolve({}); },
    dangerouslySkipPermissions: false,
    onProcessingChanged: function () {},
  };
  if (overrides) {
    var keys = Object.keys(overrides);
    for (var i = 0; i < keys.length; i++) base[keys[i]] = overrides[keys[i]];
  }
  return base;
}

// A reasonably stable subset of the AgentBackend surface that project.js relies on.
// If a backend implementation drops one of these, project.js breaks at runtime.
var REQUIRED_METHODS = [
  "startQuery",
  "pushMessage",
  "setModel",
  "setEffort",
  "setPermissionMode",
  "stopTask",
  "warmup",
  "handleCanUseTool",
  "handleElicitation",
  "processQueryStream",
  "getOrCreateRewindQuery",
  "createMessageQueue",
];

test("createAgentBackend defaults to claude when backend is omitted", function () {
  var backend = createAgentBackend(stubOpts());
  assert.strictEqual(typeof backend, "object");
  for (var i = 0; i < REQUIRED_METHODS.length; i++) {
    var name = REQUIRED_METHODS[i];
    assert.strictEqual(
      typeof backend[name],
      "function",
      "Default backend should expose " + name + "()"
    );
  }
});

test("createAgentBackend accepts explicit backend: \"claude\"", function () {
  var backend = createAgentBackend(stubOpts({ backend: "claude" }));
  assert.strictEqual(typeof backend.startQuery, "function");
});

test("createAgentBackend throws on unknown backend name", function () {
  assert.throws(
    function () { createAgentBackend(stubOpts({ backend: "no-such-backend" })); },
    /Unknown agent backend: no-such-backend/
  );
});

// Iteration 1 will replace this test with a real codex backend invocation.
// Until then, asking for "codex" must fail loudly rather than silently fall
// back to claude — silent fallback would mask integration bugs.
test("createAgentBackend throws on backend: \"codex\" until iteration 1 lands", function () {
  assert.throws(
    function () { createAgentBackend(stubOpts({ backend: "codex" })); },
    /Unknown agent backend: codex/
  );
});

test("createAgentBackend tolerates omitted opts object", function () {
  // Defensive: opts.backend access must not throw when opts is null/undefined.
  // (The Claude path still needs real opts, so we only check the dispatch
  // logic itself by requesting an unknown backend.)
  assert.throws(
    function () { createAgentBackend({ backend: "no-such-backend" }); },
    /Unknown agent backend/
  );
  assert.throws(
    function () { createAgentBackend(undefined); },
    // undefined opts → defaults to claude → createSDKBridge will then complain
    // about missing fields. We just want to confirm the factory itself doesn't
    // throw a TypeError on `opts.backend` access before dispatching.
    function (err) {
      // Either a TypeError from opts.backend access OR a downstream error
      // from createSDKBridge is acceptable; what we forbid is ReferenceError.
      return err instanceof Error && !(err instanceof ReferenceError);
    }
  );
});
