// Iter 6a unit tests — Codex skills RPC + `$<name>` injection.
//
// Protocol contract was verified live by
// scripts/codex-skills-protocol-probe.js (8 steps, all green on codex-cli
// 0.128.0). These tests cover the translation layer between the codex
// JSON-RPC client and Clay's WS surface using a fake client, so we never
// pay an API call per assertion.
//
// Scope:
//   - fetchSkills() issues `skills/list { cwds: [cwd] }` and broadcasts
//     `codex_skills` with the resulting `data[0]` flattened.
//   - skills/changed notification triggers a re-fetch (no forceReload).
//   - In-flight dedupe so a burst of skills/changed doesn't queue parallel
//     RPCs.
//   - findSkillMention parses `$<name>` only at start-of-text.
//   - applySkillInjection appends a `{type:"skill",name,path}` input item
//     when the prefix matches a cached skill, leaves text alone otherwise.
//   - skills/list with -32601 surfaces an explicit method_not_found error
//     frame so the UI can render an upgrade hint.
//
// Out of scope (live verify covers): real codex turn/start consuming the
// skill input item and respecting the SKILL.md content.

var test = require("node:test");
var assert = require("node:assert");
var { createCodexBackend } = require("../lib/codex-backend");

function makeFakeClient(responders) {
  var calls = [];
  var pendingPromises = [];
  return {
    isExited: function () { return false; },
    request: function (method, params) {
      calls.push({ method: method, params: params });
      var responder = responders && responders[method];
      var p;
      if (typeof responder === "function") p = Promise.resolve(responder(params, calls));
      else if (responder && responder.error) p = Promise.reject(responder.error);
      else if (responder !== undefined) p = Promise.resolve(responder);
      else p = Promise.resolve({});
      pendingPromises.push(p);
      return p;
    },
    respond: function () {},
    respondError: function () {},
    close: function () {},
    _calls: calls,
    _settle: function () { return Promise.allSettled(pendingPromises); },
  };
}

function makeBackend(cwd) {
  var sent = [];
  var sm = {
    sendAndRecord: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    getActiveSession: function () { return null; },
    createSession: function () { return {}; },
    currentModel: "",
    currentEffort: "medium",
    currentPermissionMode: "default",
    availableModels: [],
  };
  var be = createCodexBackend({
    cwd: cwd || "/tmp/proj",
    slug: "test",
    sessionManager: sm,
    send: function (obj) { sent.push(obj); },
    pushModule: null,
    onProcessingChanged: function () {},
  });
  return { backend: be, sent: sent, sm: sm };
}

// --- fetchSkills ---

test("fetchSkills issues skills/list with project cwd and broadcasts the flattened data entry", async function () {
  var ctx = makeBackend("/tmp/probe-cwd");
  var fake = makeFakeClient({
    "skills/list": function (params) {
      assert.deepStrictEqual(params.cwds, ["/tmp/probe-cwd"], "fetch passes project cwd");
      assert.strictEqual(params.forceReload, undefined, "no forceReload by default");
      return {
        data: [{
          cwd: "/tmp/probe-cwd",
          skills: [
            { name: "imagegen", description: "Generate images", scope: "system", enabled: true, path: "/x/imagegen/SKILL.md" },
            { name: "myskill",  description: "Custom",         scope: "user",   enabled: true, path: "/x/myskill/SKILL.md" },
          ],
          errors: [],
        }],
      };
    },
  });
  ctx.backend._setClientForTest(fake);

  await ctx.backend.fetchSkills(false);

  var skillsFrames = ctx.sent.filter(function (m) { return m.type === "codex_skills"; });
  assert.strictEqual(skillsFrames.length, 1, "exactly one codex_skills frame emitted");
  assert.strictEqual(skillsFrames[0].skills.length, 2);
  assert.strictEqual(skillsFrames[0].skills[0].name, "imagegen");
  assert.strictEqual(skillsFrames[0].errors.length, 0);
  assert.strictEqual(skillsFrames[0].cwd, "/tmp/probe-cwd");
});

test("fetchSkills(true) sets forceReload on the RPC", async function () {
  var ctx = makeBackend();
  var fake = makeFakeClient({
    "skills/list": function (params) {
      assert.strictEqual(params.forceReload, true);
      return { data: [{ cwd: "/tmp/proj", skills: [], errors: [] }] };
    },
  });
  ctx.backend._setClientForTest(fake);
  await ctx.backend.fetchSkills(true);
  assert.strictEqual(fake._calls.length, 1);
});

test("fetchSkills dedupes parallel calls (in-flight reuse)", async function () {
  var ctx = makeBackend();
  var resolveFn = null;
  var fake = makeFakeClient({
    "skills/list": function () {
      return new Promise(function (resolve) { resolveFn = resolve; });
    },
  });
  ctx.backend._setClientForTest(fake);
  var p1 = ctx.backend.fetchSkills(false);
  var p2 = ctx.backend.fetchSkills(false);
  // Same promise — the in-flight cache returns the existing one rather
  // than firing a second RPC.
  assert.strictEqual(p1, p2, "second call returns the in-flight promise");
  resolveFn({ data: [{ cwd: "/tmp/proj", skills: [], errors: [] }] });
  await p1;
  assert.strictEqual(fake._calls.length, 1, "only one skills/list RPC issued");
});

test("skills/list -32601 emits method_not_found error frame for the UI", async function () {
  var ctx = makeBackend();
  var err = new Error("Method not found");
  err.code = -32601;
  var fake = makeFakeClient({ "skills/list": { error: err } });
  ctx.backend._setClientForTest(fake);

  try { await ctx.backend.fetchSkills(false); } catch (_) { /* expected */ }

  var frame = ctx.sent.filter(function (m) { return m.type === "codex_skills"; })[0];
  assert.ok(frame, "frame still emitted");
  assert.strictEqual(frame.skills.length, 0);
  assert.strictEqual(frame.errors.length, 1);
  assert.strictEqual(frame.errors[0].code, "method_not_found");
});

// --- skills/changed notification ---

test("skills/changed notification triggers a fresh fetchSkills", async function () {
  var ctx = makeBackend();
  var calls = 0;
  var fake = makeFakeClient({
    "skills/list": function () {
      calls++;
      return { data: [{ cwd: "/tmp/proj", skills: [], errors: [] }] };
    },
  });
  ctx.backend._setClientForTest(fake);

  // Drive the notification handler directly; backend should call fetchSkills.
  ctx.backend._handleNotification({ method: "skills/changed", params: {} });
  // Wait a microtask so the inner promise resolves.
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.strictEqual(calls, 1, "skills/changed → one new skills/list");
});

// --- $name parser ---

test("findSkillMention matches `$name` at start, returns null for invalid prefix", function () {
  var ctx = makeBackend();
  ctx.backend._setSkillsCacheForTest({
    skills: [
      { name: "imagegen", path: "/x/SKILL.md", scope: "system", enabled: true },
      { name: "plugin-creator", path: "/y/SKILL.md", scope: "system", enabled: true },
    ],
    errors: [], fetchedAt: 1,
  });
  var b = ctx.backend;
  assert.deepStrictEqual(b._findSkillMentionForTest("$imagegen draw a cat").name, "imagegen");
  assert.deepStrictEqual(b._findSkillMentionForTest("$imagegen").name, "imagegen", "no trailing space ok");
  assert.deepStrictEqual(b._findSkillMentionForTest("$plugin-creator help").name, "plugin-creator", "kebab names match");
  assert.strictEqual(b._findSkillMentionForTest("$unknown thing"), null, "unknown skill returns null");
  assert.strictEqual(b._findSkillMentionForTest("hi $imagegen draw"), null, "not at start");
  assert.strictEqual(b._findSkillMentionForTest("$"), null, "bare dollar");
  assert.strictEqual(b._findSkillMentionForTest(""), null, "empty");
  assert.strictEqual(b._findSkillMentionForTest(null), null, "null");
});

test("findSkillMention returns null when cache is empty (warmup race)", function () {
  var ctx = makeBackend();
  // Cache never seeded — simulate startQuery firing before warmup's fetch.
  assert.strictEqual(ctx.backend._findSkillMentionForTest("$imagegen draw"), null);
});

// --- applySkillInjection ---

test("applySkillInjection passes plain text through unchanged", function () {
  var ctx = makeBackend();
  ctx.backend._setSkillsCacheForTest({ skills: [], errors: [], fetchedAt: 1 });
  var items = ctx.backend._applySkillInjectionForTest("hello world");
  assert.deepStrictEqual(items, [{ type: "text", text: "hello world" }]);
});

test("applySkillInjection appends a skill input item for matching $name", function () {
  var ctx = makeBackend();
  ctx.backend._setSkillsCacheForTest({
    skills: [{ name: "imagegen", path: "/abs/SKILL.md", scope: "system", enabled: true }],
    errors: [], fetchedAt: 1,
  });
  var items = ctx.backend._applySkillInjectionForTest("$imagegen draw a cat");
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].type, "text");
  assert.strictEqual(items[0].text, "$imagegen draw a cat", "original text preserved verbatim");
  assert.deepStrictEqual(items[1], {
    type: "skill",
    name: "imagegen",
    path: "/abs/SKILL.md",
  });
});

test("applySkillInjection unwraps AbsolutePathBuf object form when codex returns nested path", function () {
  var ctx = makeBackend();
  ctx.backend._setSkillsCacheForTest({
    skills: [{ name: "imagegen", path: { path: "/nested/SKILL.md" }, scope: "system", enabled: true }],
    errors: [], fetchedAt: 1,
  });
  var items = ctx.backend._applySkillInjectionForTest("$imagegen test");
  assert.strictEqual(items[1].path, "/nested/SKILL.md");
});

test("applySkillInjection skips injection when skill name does not match cache", function () {
  var ctx = makeBackend();
  ctx.backend._setSkillsCacheForTest({
    skills: [{ name: "imagegen", path: "/x/SKILL.md", scope: "system", enabled: true }],
    errors: [], fetchedAt: 1,
  });
  var items = ctx.backend._applySkillInjectionForTest("$bogus do something");
  assert.strictEqual(items.length, 1, "no skill item appended");
  assert.strictEqual(items[0].text, "$bogus do something");
});

// --- getSkills snapshot for first-connection echo ---

test("getSkills returns null before any fetch, snapshot afterwards", async function () {
  var ctx = makeBackend("/tmp/snap");
  assert.strictEqual(ctx.backend.getSkills(), null);
  ctx.backend._setSkillsCacheForTest({
    skills: [{ name: "x", path: "/p", scope: "user", enabled: true }],
    errors: [],
    fetchedAt: 999,
  });
  var snap = ctx.backend.getSkills();
  assert.strictEqual(snap.skills.length, 1);
  assert.strictEqual(snap.cwd, "/tmp/snap");
  assert.strictEqual(snap.fetchedAt, 999);
  // Mutating the returned slice must not affect the cache.
  snap.skills.push({ name: "intruder" });
  var snap2 = ctx.backend.getSkills();
  assert.strictEqual(snap2.skills.length, 1, "snapshot is defensive copy");
});
