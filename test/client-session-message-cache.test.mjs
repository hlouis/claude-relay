import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

var importCounter = 0;
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var cacheModulePath = path.join(__dirname, "../lib/public/modules/session-message-cache.js");

async function freshCacheModule() {
  importCounter++;
  var source = fs.readFileSync(cacheModulePath, "utf8");
  var url = "data:text/javascript;charset=utf-8," +
    encodeURIComponent(source + "\n//# sourceURL=session-message-cache-test-" + importCounter + ".js");
  return import(url);
}

test("client message cache evicts least recently used sessions after 100 records", async function () {
  var cache = await freshCacheModule();
  for (var i = 0; i < 101; i++) {
    cache.replaceWithHistory("proj", i, { from: 0, to: 1, total: 1 }, [
      { type: "user_message", text: "message " + i, _ts: i + 1 },
    ], {});
  }

  assert.strictEqual(cache.getRecord("proj", 0), null);
  assert.strictEqual(cache.getRecord("proj", 1).items[0].text, "message 1");
  assert.strictEqual(cache.getRecord("proj", 100).items[0].text, "message 100");
});

test("client message cache collects replayed history and done metadata", async function () {
  var cache = await freshCacheModule();
  cache.beginHistoryCollect("proj", 7, { from: 2, total: 4 });
  cache.collectHistoryMessage({ type: "user_message", text: "hello", _ts: 10 });
  cache.collectHistoryMessage({ type: "done", code: 0, _ts: 11 });
  cache.finishHistoryCollect({ lastCost: 0.25, contextUsage: { pct: 50 } });

  var rec = cache.getRecord("proj", 7);
  assert.strictEqual(rec.from, 2);
  assert.strictEqual(rec.to, 4);
  assert.strictEqual(rec.total, 4);
  assert.strictEqual(rec.items.length, 2);
  assert.strictEqual(rec.doneMeta.lastCost, 0.25);
  assert.strictEqual(rec.tailFingerprint, cache.messageFingerprint(rec.items[1]));
});

test("client message cache prepends older history when ranges touch", async function () {
  var cache = await freshCacheModule();
  cache.replaceWithHistory("proj", 8, { from: 10, to: 12, total: 12 }, [
    { type: "user_message", text: "newer", _ts: 12 },
  ], {});

  cache.mergePrepend("proj", 8, [
    { type: "user_message", text: "older", _ts: 3 },
  ], { from: 0, to: 10 });

  var rec = cache.getRecord("proj", 8);
  assert.strictEqual(rec.from, 0);
  assert.strictEqual(rec.items[0].text, "older");
  assert.strictEqual(rec.items[1].text, "newer");
});

test("client message cache appends server delta and updates range", async function () {
  var cache = await freshCacheModule();
  cache.replaceWithHistory("proj", 9, { from: 0, to: 2, total: 2 }, [
    { type: "user_message", text: "one", _ts: 1 },
    { type: "done", code: 0, _ts: 2 },
  ], {});

  cache.mergeAppend("proj", 9, [
    { type: "user_message", text: "two", _ts: 3 },
  ], { from: 2, to: 3, total: 3 }, { lastCost: 1.5 });

  var rec = cache.getRecord("proj", 9);
  assert.strictEqual(rec.to, 3);
  assert.strictEqual(rec.total, 3);
  assert.strictEqual(rec.items[2].text, "two");
  assert.strictEqual(rec.doneMeta.lastCost, 1.5);
});

test("client message cache replaces optimistic user message by clientMessageId", async function () {
  var cache = await freshCacheModule();
  cache.replaceWithHistory("proj", 10, { from: 0, to: 1, total: 1 }, [
    { type: "done", code: 0, _ts: 1 },
  ], {});
  cache.appendOptimisticUserMessage("proj", 10, {
    type: "user_message",
    text: "send",
    clientMessageId: "cm_1",
    _ts: 2,
  });

  cache.mergeAppend("proj", 10, [
    { type: "user_message", text: "send", clientMessageId: "cm_1", _ts: 3, from: "u1" },
  ], { from: 2, to: 3, total: 3 }, {});

  var rec = cache.getRecord("proj", 10);
  assert.strictEqual(rec.items.length, 2);
  assert.strictEqual(rec.items[1]._pendingLocal, undefined);
  assert.strictEqual(rec.items[1].from, "u1");
});

test("client message cache fingerprints prefer clientMessageId then uuid", async function () {
  var cache = await freshCacheModule();
  assert.strictEqual(
    cache.messageFingerprint({ type: "user_message", clientMessageId: "cm_x", uuid: "u_x" }),
    "user_message|client:cm_x"
  );
  assert.strictEqual(
    cache.messageFingerprint({ type: "message_uuid", uuid: "u_x" }),
    "message_uuid|uuid:u_x"
  );
  assert.strictEqual(
    cache.messageFingerprint({ type: "delta", text: "abcdef", _ts: 123 }),
    "delta|123|abcdef||"
  );
});
