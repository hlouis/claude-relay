// Iter 2 — backend-registry contract tests.
//
// Verify the routing/lazy-init invariants that project.js depends on:
//   1. Lazy: factory(name) is invoked at most once per name, and only on
//      first access. A registry that's never asked for "codex" must NOT
//      spawn a Codex SDK.
//   2. Same-name → same instance. Repeated getSdkFor returns the cached
//      object so settings written through it persist.
//   3. sdkForSession routes by session.backend (frozen identity from
//      iter 1). Project default is the fallback only when the session
//      lacks a backend field — which after iter 1 should never happen
//      in practice but the registry guards anyway.
//   4. defaultSdk always resolves the project default backend.
//   5. hasBackend is a non-instantiating peek — used by kill_process and
//      ambient-codex handlers to avoid forcing a spawn.

var test = require("node:test");
var assert = require("node:assert");

var { createBackendRegistry } = require("../lib/backend-registry");

// Factory stub: builds a tagged object so tests can assert which backend
// the registry returned. Counts invocations to verify laziness.
function makeFactory() {
  var calls = [];
  function factory(name) {
    calls.push(name);
    return { tag: name, calls: 0 };
  }
  factory.callList = calls;
  return factory;
}

test("factory is required", function () {
  assert.throws(
    function () { createBackendRegistry({}); },
    /factory function is required/
  );
  assert.throws(
    function () { createBackendRegistry(); },
    /factory function is required/
  );
});

test("getSdkFor invokes factory exactly once per backend name (lazy + cached)", function () {
  var f = makeFactory();
  var reg = createBackendRegistry({ factory: f, defaultBackend: "claude" });

  // No access yet → factory must NOT have been called.
  assert.deepStrictEqual(f.callList, [], "construction must not invoke factory");

  var first = reg.getSdkFor("claude");
  assert.deepStrictEqual(f.callList, ["claude"]);
  var second = reg.getSdkFor("claude");
  assert.strictEqual(first, second, "same name returns the cached instance");
  assert.deepStrictEqual(f.callList, ["claude"], "factory NOT called again on cache hit");

  var codex = reg.getSdkFor("codex");
  assert.notStrictEqual(codex, first, "different name returns a different instance");
  assert.deepStrictEqual(f.callList, ["claude", "codex"]);
});

test("getSdkFor falls back to defaultBackend when name is omitted/falsy", function () {
  var f = makeFactory();
  var reg = createBackendRegistry({ factory: f, defaultBackend: "claude" });
  assert.strictEqual(reg.getSdkFor().tag, "claude");
  assert.strictEqual(reg.getSdkFor(null).tag, "claude");
  assert.strictEqual(reg.getSdkFor(undefined).tag, "claude");
  assert.strictEqual(reg.getSdkFor("").tag, "claude");
  // Only one factory invocation for all of those.
  assert.deepStrictEqual(f.callList, ["claude"]);
});

test("defaultSdk always resolves the configured default backend", function () {
  var f = makeFactory();
  var reg = createBackendRegistry({ factory: f, defaultBackend: "codex" });
  var d = reg.defaultSdk();
  assert.strictEqual(d.tag, "codex");
  // Calling defaultSdk multiple times must NOT re-instantiate.
  reg.defaultSdk();
  reg.defaultSdk();
  assert.deepStrictEqual(f.callList, ["codex"]);
});

test("sdkForSession routes by session.backend, not by project default", function () {
  // The whole point of iter 1's frozen-backend invariant — verify it.
  var f = makeFactory();
  var reg = createBackendRegistry({ factory: f, defaultBackend: "claude" });

  var claudeSession = { localId: 1, backend: "claude" };
  var codexSession = { localId: 2, backend: "codex" };

  assert.strictEqual(reg.sdkForSession(claudeSession).tag, "claude");
  assert.strictEqual(reg.sdkForSession(codexSession).tag, "codex");
  // Repeated calls return the same cached instances.
  assert.strictEqual(reg.sdkForSession(claudeSession), reg.sdkForSession(claudeSession));
  assert.strictEqual(reg.sdkForSession(codexSession), reg.sdkForSession(codexSession));
});

test("sdkForSession with no session falls back to defaultBackend", function () {
  // Defensive: degraded session object shouldn't crash the registry.
  var f = makeFactory();
  var reg = createBackendRegistry({ factory: f, defaultBackend: "claude" });
  assert.strictEqual(reg.sdkForSession(null).tag, "claude");
  assert.strictEqual(reg.sdkForSession(undefined).tag, "claude");
  assert.strictEqual(reg.sdkForSession({}).tag, "claude", "missing .backend → default");
});

test("hasBackend reports without instantiating", function () {
  var f = makeFactory();
  var reg = createBackendRegistry({ factory: f, defaultBackend: "claude" });

  // Brand-new registry: nothing exists, but checking must NOT spawn anything.
  assert.strictEqual(reg.hasBackend("claude"), false);
  assert.strictEqual(reg.hasBackend("codex"), false);
  assert.deepStrictEqual(f.callList, [], "hasBackend must not invoke factory");

  // Touch one backend — only that one becomes present.
  reg.getSdkFor("codex");
  assert.strictEqual(reg.hasBackend("claude"), false);
  assert.strictEqual(reg.hasBackend("codex"), true);
  // Still no factory call for claude.
  assert.deepStrictEqual(f.callList, ["codex"]);
});

test("hasBackend defaults the name to defaultBackend when omitted", function () {
  var f = makeFactory();
  var reg = createBackendRegistry({ factory: f, defaultBackend: "claude" });
  assert.strictEqual(reg.hasBackend(), false);
  reg.defaultSdk();
  assert.strictEqual(reg.hasBackend(), true);
});

test("project default 'codex' with claude session: claude SDK gets lazily spawned", function () {
  // Iter-4 future scenario: project flips default to claude after a codex
  // session was already running. A previously-frozen codex session must
  // still route to codex; a freshly-spawned claude session triggers claude
  // SDK instantiation. This proves the registry doesn't tie instance
  // lifecycle to project default.
  var f = makeFactory();
  var reg = createBackendRegistry({ factory: f, defaultBackend: "codex" });

  // First operation: a codex session sends a message → codex spawned.
  reg.sdkForSession({ backend: "codex" });
  assert.deepStrictEqual(f.callList, ["codex"]);
  assert.strictEqual(reg.hasBackend("claude"), false);

  // Now project default is irrelevant; a brand-new claude session arrives.
  reg.sdkForSession({ backend: "claude" });
  assert.deepStrictEqual(f.callList, ["codex", "claude"]);
  assert.strictEqual(reg.hasBackend("claude"), true);
});

test("factory throw propagates and does NOT cache the failure", function () {
  // If factory throws (e.g., codex CLI missing), a retry should call
  // factory again. Caching a thrown value would freeze the project in
  // a broken state until restart.
  var attempts = 0;
  var reg = createBackendRegistry({
    factory: function (name) {
      attempts++;
      if (attempts === 1) throw new Error("first attempt fails");
      return { tag: name };
    },
    defaultBackend: "codex",
  });

  assert.throws(function () { reg.getSdkFor("codex"); }, /first attempt fails/);
  assert.strictEqual(reg.hasBackend("codex"), false, "failed factory must not register");

  // Second attempt succeeds.
  var sdk = reg.getSdkFor("codex");
  assert.strictEqual(sdk.tag, "codex");
  assert.strictEqual(reg.hasBackend("codex"), true);
  assert.strictEqual(attempts, 2);
});
