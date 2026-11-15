"use strict";

// Runs the shared block operation vectors (test/fixtures/
// block-operations-vectors.json, haxtheweb/issues#3270). haxcms-php runs the
// same file; both backends must give the same bytes and refusal codes.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const bo = require("../../src/lib/blockOperations.js");
const { sanitizeHTMLForStorage } = require("../../src/lib/sanitizeContent.js");
const vectors = require(
  path.join(__dirname, "..", "fixtures", "block-operations-vectors.json"),
);

test("vectors file has cases", () => {
  assert.ok(vectors.cases.length > 50);
});

for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    const html = c.page ? vectors.pages[c.page] : c.html;
    const r = bo.runBlockOperations(html, c.ops, {
      sanitize: sanitizeHTMLForStorage,
    });
    assert.equal(
      r.ok,
      c.expect.ok,
      r.ok ? "accepted" : `${r.code}: ${r.message}`,
    );
    if (c.expect.ok) {
      assert.equal(
        crypto.createHash("sha256").update(r.content, "utf8").digest("hex"),
        c.expect.sha256,
      );
      assert.deepEqual(
        r.results.map((x) => r.content.slice(x.start, x.end)),
        c.expect.blocks,
      );
      assert.deepEqual(
        r.results.map((x) => x.index),
        c.expect.indexes,
      );
      assert.deepEqual(
        r.results.map((x) => x.relocated),
        c.expect.relocated,
      );
      if (typeof c.expect.content === "string") {
        assert.equal(r.content, c.expect.content);
      }
    } else {
      assert.equal(r.code, c.expect.code);
      if (c.expect.op !== null) {
        assert.equal(r.op, c.expect.op);
      }
    }
  });
}
