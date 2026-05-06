var test = require("node:test");
var assert = require("node:assert");

var { createCodexClient } = require("../lib/codex-jsonrpc");

// We drive the client by spawning `node -e "<script>"` as a fake JSON-RPC peer.
// This exercises real stdio framing — same code path codex would use — without
// pulling in the codex binary.
var NODE = process.execPath;

// Helper: wait until predicate() returns truthy or timeout fires.
function waitFor(predicate, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var deadline = Date.now() + (timeoutMs || 2000);
    (function tick() {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 5);
    })();
  });
}

test("request resolves with result when peer responds", async function () {
  // Peer reads one line, parses {id}, replies {id, result:{ok:true}}.
  var script =
    "process.stdin.setEncoding('utf8');" +
    "var buf='';" +
    "process.stdin.on('data', function(c){" +
    "  buf+=c;" +
    "  var lines=buf.split('\\n'); buf=lines.pop();" +
    "  for (var i=0;i<lines.length;i++){" +
    "    var m=JSON.parse(lines[i]);" +
    "    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:true,echo:m.method}})+'\\n');" +
    "  }" +
    "});";

  var client = createCodexClient({ command: NODE, args: ["-e", script] });
  try {
    var result = await client.request("ping", { x: 1 });
    assert.deepStrictEqual(result, { ok: true, echo: "ping" });
  } finally {
    client.close();
  }
});

test("request rejects with code/message when peer returns error", async function () {
  var script =
    "process.stdin.setEncoding('utf8');" +
    "var buf='';" +
    "process.stdin.on('data', function(c){" +
    "  buf+=c;" +
    "  var lines=buf.split('\\n'); buf=lines.pop();" +
    "  for (var i=0;i<lines.length;i++){" +
    "    var m=JSON.parse(lines[i]);" +
    "    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'no such method'}})+'\\n');" +
    "  }" +
    "});";

  var client = createCodexClient({ command: NODE, args: ["-e", script] });
  try {
    await client.request("nope");
    assert.fail("expected rejection");
  } catch (err) {
    assert.strictEqual(err.code, -32601);
    assert.match(err.message, /no such method/);
  } finally {
    client.close();
  }
});

test("notifications are dispatched to onNotification, not onServerRequest", async function () {
  // Peer immediately emits two notifications and one server-initiated request.
  var script =
    "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'thread/started',params:{t:1}})+'\\n');" +
    "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'turn/started',params:{t:2}})+'\\n');" +
    "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:99,method:'execCommandApproval',params:{cmd:'ls'}})+'\\n');" +
    "setInterval(function(){}, 1000);"; // keep peer alive

  var notifications = [];
  var serverReqs = [];
  var client = createCodexClient({
    command: NODE,
    args: ["-e", script],
    onNotification: function (m) { notifications.push(m); },
    onServerRequest: function (m) { serverReqs.push(m); },
  });
  try {
    await waitFor(function () { return notifications.length >= 2 && serverReqs.length >= 1; });
    assert.strictEqual(notifications.length, 2);
    assert.strictEqual(notifications[0].method, "thread/started");
    assert.strictEqual(notifications[1].method, "turn/started");
    assert.strictEqual(serverReqs.length, 1);
    assert.strictEqual(serverReqs[0].id, 99);
    assert.strictEqual(serverReqs[0].method, "execCommandApproval");
  } finally {
    client.close();
  }
});

test("pending requests reject when child exits unexpectedly", async function () {
  // Peer reads but never replies, then exits 1.
  var script =
    "process.stdin.setEncoding('utf8');" +
    "process.stdin.on('data', function(){ process.exit(1); });";

  var exitInfo = null;
  var client = createCodexClient({
    command: NODE,
    args: ["-e", script],
    onExit: function (code, signal, err) { exitInfo = { code: code, signal: signal, err: err }; },
  });

  var p = client.request("hello");
  await assert.rejects(p, /exited/);
  await waitFor(function () { return exitInfo !== null; });
  assert.strictEqual(exitInfo.code, 1);
});

test("request after close rejects synchronously (returned Promise)", async function () {
  // Peer that stays alive; we close from our side and verify subsequent calls reject.
  var script = "setInterval(function(){}, 1000);";
  var client = createCodexClient({ command: NODE, args: ["-e", script], gracePeriodMs: 50 });
  client.close();
  // Wait for the child exit to propagate, otherwise isExited() may still be false.
  await waitFor(function () { return client.isExited(); }, 1500);
  await assert.rejects(client.request("anything"), /closed|exited/);
});

test("multiple in-flight requests resolve to the right callers", async function () {
  // Peer echoes id+method but responds in REVERSE order to verify id matching.
  var script =
    "process.stdin.setEncoding('utf8');" +
    "var buf=''; var pending=[];" +
    "process.stdin.on('data', function(c){" +
    "  buf+=c;" +
    "  var lines=buf.split('\\n'); buf=lines.pop();" +
    "  for (var i=0;i<lines.length;i++){ pending.push(JSON.parse(lines[i])); }" +
    "  if (pending.length>=2){" +
    "    for (var j=pending.length-1;j>=0;j--){" +
    "      var m=pending[j];" +
    "      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{m:m.method}})+'\\n');" +
    "    }" +
    "    pending=[];" +
    "  }" +
    "});";

  var client = createCodexClient({ command: NODE, args: ["-e", script] });
  try {
    var p1 = client.request("first");
    var p2 = client.request("second");
    var results = await Promise.all([p1, p2]);
    assert.deepStrictEqual(results[0], { m: "first" });
    assert.deepStrictEqual(results[1], { m: "second" });
  } finally {
    client.close();
  }
});

test("malformed JSON lines are dropped without killing the client", async function () {
  // Peer: emits one garbage line, then a valid response.
  var script =
    "process.stdin.setEncoding('utf8');" +
    "var buf='';" +
    "process.stdin.on('data', function(c){" +
    "  buf+=c;" +
    "  var lines=buf.split('\\n'); buf=lines.pop();" +
    "  for (var i=0;i<lines.length;i++){" +
    "    var m=JSON.parse(lines[i]);" +
    "    process.stdout.write('not json at all\\n');" +
    "    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ok:1}})+'\\n');" +
    "  }" +
    "});";

  var stderrCalls = 0;
  var client = createCodexClient({
    command: NODE,
    args: ["-e", script],
    onStderr: function (chunk) {
      if (typeof chunk === "string" && chunk.indexOf("invalid JSON") !== -1) stderrCalls++;
    },
  });
  try {
    var r = await client.request("ping");
    assert.deepStrictEqual(r, { ok: 1 });
    assert.ok(stderrCalls >= 1, "expected onStderr to be notified about invalid JSON");
  } finally {
    client.close();
  }
});
