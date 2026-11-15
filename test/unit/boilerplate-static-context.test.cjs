"use strict";

// index.html serves the live site, where HAXcms asks the backend for its
// connection settings ("php" context: the request a live site answers).
// ghpages.html is the static copy (the HAX CLI swaps it in as index.html
// for surge / netlify / vercel, and it is what GitHub Pages publishing
// uses), where no backend exists: it says "published", so HAXcms neither
// asks for one (a request that can only 404) nor loads the editor.
// haxcms-php keeps the same rule (BoilerplateStaticContextTest.php).
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SITE = path.join(__dirname, "..", "..", "src", "boilerplate", "site");

function contexts(file) {
  const html = fs.readFileSync(path.join(SITE, file), "utf8");
  const found = [];
  const re = /globalThis\.HAXCMSContext\s*=\s*"([^"]*)"/g;
  let m = re.exec(html);
  while (m) {
    found.push(m[1]);
    m = re.exec(html);
  }
  return found;
}

test("the live page asks the backend: index.html is php", () => {
  assert.deepEqual(contexts("index.html"), ["php"]);
});

test("the static copy never asks for a backend: ghpages.html is published", () => {
  assert.deepEqual(contexts("ghpages.html"), ["published"]);
});
