"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var parseCodexModelList = require("../lib/yoke/adapters/codex").__test.parseCodexModelList;

var FALLBACK_MODELS = ["gpt-5.4", "gpt-5.4-mini"];
var FALLBACK_DEFAULT = "gpt-5.4";

test("parseCodexModelList: picks isDefault model and shapes entries", function () {
  var rpc = {
    data: [
      { id: "gpt-5.4", displayName: "GPT-5.4", description: "Flagship", hidden: false, isDefault: false },
      { id: "gpt-5.5", displayName: "GPT-5.5", description: "Latest", hidden: false, isDefault: true },
      { id: "gpt-5.3-codex", displayName: "Codex", description: "", hidden: false, isDefault: false },
    ],
  };
  var out = parseCodexModelList(rpc, FALLBACK_MODELS, FALLBACK_DEFAULT);
  assert.equal(out.source, "rpc");
  assert.equal(out.defaultModelId, "gpt-5.5");
  assert.equal(out.models.length, 3);
  assert.deepEqual(out.models[0], { value: "gpt-5.4", displayName: "GPT-5.4", description: "Flagship" });
  assert.deepEqual(out.models[1], { value: "gpt-5.5", displayName: "GPT-5.5", description: "Latest" });
  assert.deepEqual(out.models[2], { value: "gpt-5.3-codex", displayName: "Codex", description: "" });
});

test("parseCodexModelList: filters hidden models", function () {
  var rpc = {
    data: [
      { id: "visible", displayName: "Visible", hidden: false, isDefault: true },
      { id: "internal", displayName: "Internal", hidden: true, isDefault: false },
    ],
  };
  var out = parseCodexModelList(rpc, FALLBACK_MODELS, FALLBACK_DEFAULT);
  assert.equal(out.source, "rpc");
  assert.equal(out.models.length, 1);
  assert.equal(out.models[0].value, "visible");
  assert.equal(out.defaultModelId, "visible");
});

test("parseCodexModelList: when no isDefault is set, falls back to first visible", function () {
  var rpc = {
    data: [
      { id: "a", displayName: "A", hidden: false },
      { id: "b", displayName: "B", hidden: false },
    ],
  };
  var out = parseCodexModelList(rpc, FALLBACK_MODELS, FALLBACK_DEFAULT);
  assert.equal(out.source, "rpc");
  assert.equal(out.defaultModelId, "a");
});

test("parseCodexModelList: only one default is honored even if multiple flagged", function () {
  // Protocol says "Only one model should be marked as default" but defend
  // anyway — first wins.
  var rpc = {
    data: [
      { id: "a", displayName: "A", hidden: false, isDefault: true },
      { id: "b", displayName: "B", hidden: false, isDefault: true },
    ],
  };
  var out = parseCodexModelList(rpc, FALLBACK_MODELS, FALLBACK_DEFAULT);
  assert.equal(out.defaultModelId, "a");
});

test("parseCodexModelList: missing displayName falls back to id", function () {
  var rpc = {
    data: [
      { id: "raw-id", hidden: false, isDefault: true },
    ],
  };
  var out = parseCodexModelList(rpc, FALLBACK_MODELS, FALLBACK_DEFAULT);
  assert.equal(out.models[0].displayName, "raw-id");
  assert.equal(out.models[0].description, "");
});

test("parseCodexModelList: skips entries missing id", function () {
  var rpc = {
    data: [
      { displayName: "no id", hidden: false },
      { id: "valid", displayName: "Valid", hidden: false, isDefault: true },
      null,
    ],
  };
  var out = parseCodexModelList(rpc, FALLBACK_MODELS, FALLBACK_DEFAULT);
  assert.equal(out.models.length, 1);
  assert.equal(out.models[0].value, "valid");
});

test("parseCodexModelList: null RPC result returns fallback", function () {
  var out = parseCodexModelList(null, FALLBACK_MODELS, FALLBACK_DEFAULT);
  assert.equal(out.source, "fallback");
  assert.deepEqual(out.models, FALLBACK_MODELS);
  assert.equal(out.defaultModelId, FALLBACK_DEFAULT);
  // Returned array must be a copy — mutating it must not affect FALLBACK_MODELS.
  out.models.push("mutated");
  assert.equal(FALLBACK_MODELS.length, 2);
});

test("parseCodexModelList: empty data returns fallback", function () {
  var out = parseCodexModelList({ data: [] }, FALLBACK_MODELS, FALLBACK_DEFAULT);
  assert.equal(out.source, "fallback");
  assert.deepEqual(out.models, FALLBACK_MODELS);
});

test("parseCodexModelList: data with only hidden entries returns fallback", function () {
  var rpc = {
    data: [
      { id: "h1", hidden: true },
      { id: "h2", hidden: true },
    ],
  };
  var out = parseCodexModelList(rpc, FALLBACK_MODELS, FALLBACK_DEFAULT);
  assert.equal(out.source, "fallback");
  assert.deepEqual(out.models, FALLBACK_MODELS);
  assert.equal(out.defaultModelId, FALLBACK_DEFAULT);
});

test("parseCodexModelList: malformed RPC (no data array) returns fallback", function () {
  var out = parseCodexModelList({ unexpected: 1 }, FALLBACK_MODELS, FALLBACK_DEFAULT);
  assert.equal(out.source, "fallback");
});
