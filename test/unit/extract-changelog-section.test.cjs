"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractSection } = require("../../scripts/extract-changelog-section");

const SAMPLE = [
  "# Changelog",
  "",
  "## [26.8.1](https://example.test/compare/a...b) (2026-08-14)",
  "",
  "### Bug Fixes",
  "",
  "* **x:** fixed x ([abc](https://example.test/c/abc))",
  "",
  "## [26.0.1](https://example.test/compare/c...d) (2026-05-21)",
  "",
  "## [26.0.0](https://example.test/compare/e...f) (2026-05-12)",
  "",
  "### Features",
  "",
  "- y",
].join("\n");

test("extracts a section by tag with or without v prefix", () => {
  const a = extractSection(SAMPLE, "v26.8.1");
  assert.match(a, /fixed x/);
  assert.doesNotMatch(a, /26\.0\.1/);
  assert.equal(extractSection(SAMPLE, "26.8.1"), a);
});

test("returns empty for a section with no entries", () => {
  assert.equal(extractSection(SAMPLE, "v26.0.1"), "");
});

test("returns empty for an unknown version and does not prefix-match", () => {
  assert.equal(extractSection(SAMPLE, "26.8.2"), "");
  assert.equal(extractSection(SAMPLE, "26.8"), "");
  assert.match(extractSection(SAMPLE, "26.0.0"), /- y/);
});
