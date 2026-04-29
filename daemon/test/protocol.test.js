var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

// Round-trip test for the shared WebSocket protocol fixtures at
// repo-root protocol/. Catches drift between the fixture set and types.ts,
// and verifies every fixture is JSON that survives a parse → stringify cycle.

var PROTOCOL_DIR = path.resolve(__dirname, "..", "..", "protocol");
var FIXTURES_DIR = path.join(PROTOCOL_DIR, "fixtures");
var TYPES_FILE = path.join(PROTOCOL_DIR, "types.ts");

function listFixtures(dir) {
  var out = [];
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.isDirectory()) {
      out = out.concat(listFixtures(path.join(dir, e.name)));
    } else if (e.isFile() && e.name.endsWith(".json")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function parseTypeLiteralsFromTs(src) {
  // Picks up `type: "foo"` literal discriminators from interface declarations.
  var re = /\btype:\s*"([a-zA-Z0-9_]+)"/g;
  var seen = {};
  var m;
  while ((m = re.exec(src)) !== null) {
    seen[m[1]] = true;
  }
  return Object.keys(seen);
}

var fixtureFiles = fs.existsSync(FIXTURES_DIR) ? listFixtures(FIXTURES_DIR) : [];
var typesSrc = fs.existsSync(TYPES_FILE) ? fs.readFileSync(TYPES_FILE, "utf8") : "";
var declaredTypes = parseTypeLiteralsFromTs(typesSrc);

test("protocol fixtures directory is non-empty", function () {
  assert.ok(fixtureFiles.length > 0, "expected at least one fixture under protocol/fixtures/");
});

test("types.ts declares at least one message", function () {
  assert.ok(declaredTypes.length > 0, "expected at least one `type: \"...\"` literal in protocol/types.ts");
});

fixtureFiles.forEach(function (file) {
  var rel = path.relative(PROTOCOL_DIR, file);

  test("fixture parses and round-trips: " + rel, function () {
    var raw = fs.readFileSync(file, "utf8");

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      assert.fail("invalid JSON in " + rel + ": " + e.message);
    }

    assert.strictEqual(typeof parsed, "object", rel + " must be a JSON object");
    assert.ok(parsed !== null, rel + " must not be null");
    assert.strictEqual(typeof parsed.type, "string", rel + " must have a string `type` field");

    // Filename must match the discriminator. e.g. fixtures/s2c/delta.json → type "delta".
    var basename = path.basename(file, ".json");
    assert.strictEqual(parsed.type, basename,
      rel + " has type \"" + parsed.type + "\" but filename implies \"" + basename + "\"");

    // Round-trip: re-stringify and re-parse, deep equal.
    var redoubled = JSON.parse(JSON.stringify(parsed));
    assert.deepStrictEqual(redoubled, parsed, rel + " did not survive a JSON round-trip");
  });

  test("fixture type is declared in types.ts: " + rel, function () {
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(declaredTypes.indexOf(parsed.type) !== -1,
      "fixture " + rel + " has type \"" + parsed.type + "\" but it is not declared in protocol/types.ts");
  });
});

test("every type declared in types.ts has at least one fixture", function () {
  var fixtureTypes = {};
  fixtureFiles.forEach(function (file) {
    try {
      var t = JSON.parse(fs.readFileSync(file, "utf8")).type;
      if (typeof t === "string") fixtureTypes[t] = true;
    } catch (e) {}
  });
  var missing = declaredTypes.filter(function (t) { return !fixtureTypes[t]; });
  assert.deepStrictEqual(missing, [],
    "types declared in types.ts but missing fixtures: " + missing.join(", "));
});
