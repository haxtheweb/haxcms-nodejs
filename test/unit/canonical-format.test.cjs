"use strict";

// The canonical text formats (haxtheweb/issues#3394) are the same byte for
// byte in haxcms-nodejs and haxcms-php. test/fixtures/canonical-format-vectors.json
// is a copy of haxcms-php tests/Unit/fixtures/canonical-format-vectors.json:
// both suites check their implementation against it, so the two files must
// stay identical.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const YAML = require("yaml");
const canonicalFormat = require("../../src/lib/canonicalFormat.js");

const vectors = require(
  path.join(__dirname, "..", "fixtures", "canonical-format-vectors.json"),
).vectors;

test("canonical formats match the shared vectors", () => {
  assert.ok(vectors.length > 50);
  for (const vector of vectors) {
    const value = JSON.parse(vector.input);
    assert.equal(canonicalFormat.json(value), vector.json, vector.input);
    assert.equal(
      canonicalFormat.prettyJson(value),
      vector.prettyJson,
      vector.input,
    );
    assert.equal(canonicalFormat.yaml(value), vector.yaml, vector.input);
  }
});

test("the canonical YAML reads back as the same data", () => {
  for (const vector of vectors) {
    assert.deepEqual(
      YAML.parse(vector.yaml),
      JSON.parse(vector.input),
      vector.input,
    );
  }
});

test("values JSON cannot hold are written as JSON.stringify drops them", () => {
  assert.equal(canonicalFormat.yaml(undefined), "null\n");
  assert.equal(canonicalFormat.yaml({ a: undefined, b: 1 }), "b: 1\n");
  assert.equal(
    canonicalFormat.yaml({ when: new Date(1500) }),
    'when: "1970-01-01T00:00:01.500Z"\n',
  );
});
