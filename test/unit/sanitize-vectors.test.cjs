"use strict";

// Runs the shared storage sanitizer vectors (test/fixtures/
// sanitize-vectors.json, haxtheweb/issues#3273). haxcms-php runs the same
// file; both backends must store exactly this HTML.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const { sanitizeHTMLForStorage } = require("../../src/lib/sanitizeContent.js");
const vectors = require(
  path.join(__dirname, "..", "fixtures", "sanitize-vectors.json"),
);

test("vectors file has cases", () => {
  assert.ok(vectors.cases.length > 1000);
});

test("every vector stores the expected HTML", () => {
  const failures = [];
  for (const c of vectors.cases) {
    const html = c.page ? vectors.pages[c.page] : c.html;
    const out = sanitizeHTMLForStorage(html, c.options || {});
    if (typeof c.expect === "string") {
      if (out !== c.expect)
        failures.push(
          `${c.name}\n  got:  ${JSON.stringify(out)}\n  want: ${JSON.stringify(c.expect)}`,
        );
    } else if (
      crypto.createHash("sha256").update(out, "utf8").digest("hex") !==
      c.expect.sha256
    ) {
      failures.push(`${c.name}: sha256 differs`);
    }
  }
  assert.equal(failures.length, 0, failures.slice(0, 10).join("\n"));
});
