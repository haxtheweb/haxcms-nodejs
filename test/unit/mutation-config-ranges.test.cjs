"use strict";

// stryker.config.json: every line-ranged `mutate` entry still covers a whole
// function
//
// The weekly mutation run (.github/workflows/mutation-testing.yml) mutates
// only the parts of HAXCMS.js / JSONOutlineSchema*.js that saveOutline
// calls, by line range. Lines move whenever those files change, and a stale
// range silently mutates some other function (it happened: the HAXCMS.js
// ranges had drifted onto getNodeFields). Each range must start on a method
// definition and end on the closing brace at the same indentation, so an
// edit above it fails here instead of skewing the weekly score.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..", "..");
const config = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "stryker.config.json"), "utf8"),
);

const RANGED = /^(.+):(\d+)-(\d+)$/;
const METHOD_START =
  /^(\s*)(?:async\s+)?(?:static\s+)?[A-Za-z_$][\w$]*\(.*\)\s*\{$/;

const ranged = config.mutate
  .map((entry) => RANGED.exec(entry))
  .filter((match) => match !== null);

test("stryker.config.json has line-ranged mutate entries to check", () => {
  assert.ok(ranged.length > 0);
});

for (const match of ranged) {
  const file = match[1];
  const start = parseInt(match[2], 10);
  const end = parseInt(match[3], 10);
  test(file + ":" + start + "-" + end + " covers one whole function", () => {
    const lines = fs
      .readFileSync(path.join(repoRoot, file), "utf8")
      .split("\n");
    assert.ok(end > start && end <= lines.length, "the range is in the file");
    const first = METHOD_START.exec(lines[start - 1]);
    assert.ok(
      first,
      "line " + start + " starts a method, found: " + lines[start - 1],
    );
    assert.equal(
      lines[end - 1],
      first[1] + "}",
      "line " + end + " closes it at the same indentation",
    );
  });
}
