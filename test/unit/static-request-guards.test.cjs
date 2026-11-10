"use strict";

// Unit tests for src/lib/staticRequestGuards.js (SEC-STATIC-DOTFILES,
// SEC-LOCAL-ORIGIN): decoded-path dotfile decisions, ".." refusal, strict
// bypass flag parsing, and the local-mode cross-site write guard.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const guards = require(
  path.join(__dirname, "..", "..", "src", "lib", "staticRequestGuards.js"),
);

test("hasParentDirectorySegment catches raw and encoded traversal", () => {
  assert.equal(
    guards.hasParentDirectorySegment("/_sites/a/.well-known/../.git/config"),
    true,
  );
  assert.equal(
    guards.hasParentDirectorySegment(
      "/_sites/a/.well-known/%2e%2e/.git/config",
    ),
    true,
  );
  assert.equal(
    guards.hasParentDirectorySegment(
      "/_sites/a/.well-known/%2E%2E%2F.git/config",
    ),
    true,
  );
  assert.equal(
    guards.hasParentDirectorySegment("/_sites/a/.well-known/..%5C.git/config"),
    true,
  );
  assert.equal(
    guards.hasParentDirectorySegment("/_sites/a/files/x..y.png"),
    false,
  );
  assert.equal(guards.hasParentDirectorySegment("/_sites/a/files/..."), false);
  assert.equal(guards.hasParentDirectorySegment("/x/api/thing?q=../.."), false);
});

test("shouldAllowWellKnownDotfiles only allows .well-known", () => {
  assert.equal(
    guards.shouldAllowWellKnownDotfiles("/_sites/a/.well-known/security.txt"),
    true,
  );
  assert.equal(
    guards.shouldAllowWellKnownDotfiles("/.well-known/agent-skills/index.json"),
    true,
  );
  assert.equal(
    guards.shouldAllowWellKnownDotfiles("/.well-known/api-catalog?x=1"),
    true,
  );
  assert.equal(
    guards.shouldAllowWellKnownDotfiles("/_sites/a/.well-known/../.git/config"),
    false,
  );
  assert.equal(
    guards.shouldAllowWellKnownDotfiles(
      "/_sites/a/.well-known/%2e%2e/.git/config",
    ),
    false,
  );
  assert.equal(
    guards.shouldAllowWellKnownDotfiles("/_sites/a/.well-known/.git/config"),
    false,
  );
  assert.equal(
    guards.shouldAllowWellKnownDotfiles("/_sites/a/.git/.well-known/x"),
    false,
  );
  assert.equal(
    guards.shouldAllowWellKnownDotfiles("/_sites/a/files/x.png"),
    false,
  );
});

test("isEnabledFlagValue only accepts explicit truthy values", () => {
  assert.equal(guards.isEnabledFlagValue("true"), true);
  assert.equal(guards.isEnabledFlagValue("TRUE"), true);
  assert.equal(guards.isEnabledFlagValue(" 1 "), true);
  assert.equal(guards.isEnabledFlagValue(true), true);
  assert.equal(guards.isEnabledFlagValue("false"), false);
  assert.equal(guards.isEnabledFlagValue("0"), false);
  assert.equal(guards.isEnabledFlagValue(""), false);
  assert.equal(guards.isEnabledFlagValue("no"), false);
  assert.equal(guards.isEnabledFlagValue(undefined), false);
});

function req(method, headers) {
  return { method: method, headers: headers || {} };
}

test("isCrossSiteLocalModeWrite allows same-origin and header-less writes", () => {
  assert.equal(
    guards.isCrossSiteLocalModeWrite(
      req("POST", {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        "sec-fetch-site": "same-origin",
      }),
    ),
    false,
  );
  assert.equal(
    guards.isCrossSiteLocalModeWrite(
      req("POST", { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }),
    ),
    false,
  );
  assert.equal(
    guards.isCrossSiteLocalModeWrite(req("POST", { host: "localhost:3000" })),
    false,
  );
  assert.equal(
    guards.isCrossSiteLocalModeWrite(
      req("GET", { host: "localhost:3000", origin: "https://evil.example" }),
    ),
    false,
  );
  assert.equal(
    guards.isCrossSiteLocalModeWrite(
      req("POST", { host: "localhost:3000", origin: "http://localhost:8000" }),
      ["http://localhost:8000"],
    ),
    false,
  );
});

test("isCrossSiteLocalModeWrite refuses cross-site writes", () => {
  assert.equal(
    guards.isCrossSiteLocalModeWrite(
      req("POST", { host: "localhost:3000", origin: "https://evil.example" }),
    ),
    true,
  );
  assert.equal(
    guards.isCrossSiteLocalModeWrite(
      req("DELETE", { host: "localhost:3000", "sec-fetch-site": "cross-site" }),
    ),
    true,
  );
  assert.equal(
    guards.isCrossSiteLocalModeWrite(
      req("POST", { host: "localhost:3000", origin: "null" }),
    ),
    true,
  );
  assert.equal(
    guards.isCrossSiteLocalModeWrite(
      req("PUT", { host: "localhost:3000", origin: "http://localhost:4000" }),
    ),
    true,
  );
});
