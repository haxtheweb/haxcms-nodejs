"use strict";

// toPlainText decodes character references the way PHP html_entity_decode
// does (named and numeric, one pass) before it strips markup, so a title
// that arrives attribute-escaped is stored as the text the author typed.

const test = require("node:test");
const assert = require("node:assert/strict");
const { toPlainText } = require("../../src/lib/sanitizePageMetadata.js");

test("numeric character references in a title are decoded", () => {
  assert.equal(toPlainText("It&#x27;s a &quot;quote&quot;"), 'It\'s a "quote"');
  assert.equal(toPlainText("It&#39;s"), "It's");
  assert.equal(toPlainText("caf&#233; &#x1F680; &eacute;"), "café 🚀 é");
});

test("references are decoded once, then markup is stripped", () => {
  assert.equal(toPlainText("&amp;#x27;"), "&#x27;");
  assert.equal(toPlainText("&#60;img src=x onerror=1&#62;hi"), "hi");
});

test("references that are not characters are left as written", () => {
  assert.equal(
    toPlainText("&#0;&#xD800;&#x110000;&bogus;"),
    "&#0;&#xD800;&#x110000;&bogus;",
  );
});
