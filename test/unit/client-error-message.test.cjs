"use strict";

// Security (L1, 2026-10-19 audit) unit tests for src/lib/clientErrorMessage.js:
// caught exceptions must never reach API clients with absolute server paths,
// file:// URLs or multi-line stack internals, while intentional status
// errors and short library messages stay useful.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  clientSafeErrorDetail,
  resolveClientFacingErrorMessage,
} = require("../../src/lib/clientErrorMessage.js");

test("intentional status errors pass through unchanged", () => {
  const err = new Error("Invalid file path");
  err.status = 400;
  assert.equal(clientSafeErrorDetail(err), "Invalid file path");
  assert.equal(
    resolveClientFacingErrorMessage(err, "fallback"),
    "Invalid file path",
  );
});

test("short library messages are kept", () => {
  assert.equal(
    clientSafeErrorDetail(new Error("Unsupported ZIP file")),
    "Unsupported ZIP file",
  );
  assert.equal(
    clientSafeErrorDetail(new Error("network down")),
    "network down",
  );
});

test("absolute POSIX paths are redacted", () => {
  const err = new Error(
    "EACCES: permission denied, open '/var/lib/haxcms/_config/.pk'",
  );
  assert.equal(
    clientSafeErrorDetail(err),
    "EACCES: permission denied, open '[path]'",
  );
  const spaced = new Error(
    "ENOENT: no such file or directory, stat /tmp/haxcms-x/file.pdf",
  );
  assert.equal(
    clientSafeErrorDetail(spaced),
    "ENOENT: no such file or directory, stat [path]",
  );
});

test("windows paths and file urls are redacted", () => {
  assert.equal(
    clientSafeErrorDetail(
      new Error("open 'C:\\Users\\me\\haxcms\\site.json' failed"),
    ),
    "open '[path]' failed",
  );
  assert.equal(
    clientSafeErrorDetail(new Error("cannot load file:///home/me/x.png")),
    "cannot load [path]",
  );
});

test("http(s) URLs are not treated as paths", () => {
  assert.equal(
    clientSafeErrorDetail(
      new Error("fetch failed for https://example.com/a/b"),
    ),
    "fetch failed for https://example.com/a/b",
  );
});

test("only the first line is kept and long messages are truncated", () => {
  const err = new Error(
    "first line\n    at Object.<anonymous> (/srv/app.js:1:1)",
  );
  assert.equal(clientSafeErrorDetail(err), "first line");
  const long = clientSafeErrorDetail(new Error("x".repeat(500)));
  assert.equal(long.length, 201);
});

test("missing messages use the fallback", () => {
  assert.equal(clientSafeErrorDetail(null), "Unexpected error");
  assert.equal(
    clientSafeErrorDetail({}, "Unable to export"),
    "Unable to export",
  );
  assert.equal(
    clientSafeErrorDetail(new Error(""), "Unable to export"),
    "Unable to export",
  );
  assert.equal(
    resolveClientFacingErrorMessage(new Error("raw internals"), "Unable"),
    "Unable",
  );
});
