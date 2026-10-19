"use strict";

// Security (SEC-DEPLOY): unit tests for the server listen-host selection
// (src/lib/listenHost.js). No server is started here; the real bind in
// no-login mode is covered by local-server-open.test.cjs.
//
// Constraints honored: CommonJS (.cjs), require(), node:test +
// node:assert/strict, NO optional chaining.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  LOOPBACK_HOST,
  selectListenHost,
  isLoopbackHost,
  getBypassExposureWarning,
  getBrowserHost,
  shouldEmbedBypassJwt,
} = require(path.join(__dirname, "..", "..", "src", "lib", "listenHost.js"));

test("default (auth on, no HAXCMS_HOST) keeps binding all interfaces", () => {
  assert.equal(
    selectListenHost({ env: {}, jwtChecksDisabled: false }),
    undefined,
  );
  assert.equal(
    selectListenHost({ env: { HAXCMS_HOST: "" }, jwtChecksDisabled: false }),
    undefined,
  );
  assert.equal(
    selectListenHost({ env: { HAXCMS_HOST: "   " }, jwtChecksDisabled: false }),
    undefined,
  );
});

test("no-login bypass without HAXCMS_HOST binds 127.0.0.1", () => {
  assert.equal(LOOPBACK_HOST, "127.0.0.1");
  assert.equal(
    selectListenHost({ env: {}, jwtChecksDisabled: true }),
    "127.0.0.1",
  );
  assert.equal(
    selectListenHost({ env: { HAXCMS_HOST: "" }, jwtChecksDisabled: true }),
    "127.0.0.1",
  );
});

test("HAXCMS_HOST always wins (escape hatch and general use)", () => {
  assert.equal(
    selectListenHost({
      env: { HAXCMS_HOST: "0.0.0.0" },
      jwtChecksDisabled: true,
    }),
    "0.0.0.0",
  );
  assert.equal(
    selectListenHost({
      env: { HAXCMS_HOST: " 10.0.0.5 " },
      jwtChecksDisabled: true,
    }),
    "10.0.0.5",
  );
  assert.equal(
    selectListenHost({
      env: { HAXCMS_HOST: "127.0.0.1" },
      jwtChecksDisabled: false,
    }),
    "127.0.0.1",
  );
  assert.equal(
    selectListenHost({ env: { HAXCMS_HOST: "::" }, jwtChecksDisabled: false }),
    "::",
  );
  assert.equal(
    selectListenHost({
      env: { HAXCMS_HOST: "[::1]" },
      jwtChecksDisabled: true,
    }),
    "::1",
  );
});

test("selectListenHost reads process.env when no env is passed", () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, "HAXCMS_HOST");
  const prev = process.env.HAXCMS_HOST;
  try {
    process.env.HAXCMS_HOST = "192.168.1.20";
    assert.equal(selectListenHost({ jwtChecksDisabled: true }), "192.168.1.20");
    delete process.env.HAXCMS_HOST;
    assert.equal(selectListenHost({ jwtChecksDisabled: true }), "127.0.0.1");
    assert.equal(selectListenHost(), undefined);
  } finally {
    if (had) process.env.HAXCMS_HOST = prev;
    else delete process.env.HAXCMS_HOST;
  }
});

test("isLoopbackHost recognises loopback forms only", () => {
  for (const h of [
    "127.0.0.1",
    "127.1.2.3",
    "localhost",
    "LOCALHOST",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of [
    undefined,
    null,
    "",
    "0.0.0.0",
    "::",
    "10.0.0.1",
    "192.168.0.2",
    "128.0.0.1",
    "example.com",
  ]) {
    assert.equal(isLoopbackHost(h), false, String(h));
  }
});

test("bypass on a non-loopback bind produces a loud warning", () => {
  assert.equal(getBypassExposureWarning("127.0.0.1", true), null);
  assert.equal(getBypassExposureWarning("0.0.0.0", false), null);
  assert.equal(getBypassExposureWarning(undefined, false), null);
  const wildcard = getBypassExposureWarning("0.0.0.0", true);
  assert.ok(wildcard && wildcard.indexOf("SECURITY WARNING") !== -1);
  assert.ok(wildcard.indexOf("0.0.0.0") !== -1);
  const all = getBypassExposureWarning(undefined, true);
  assert.ok(all && all.indexOf("all interfaces") !== -1);
});

test("getBrowserHost: localhost for wildcard binds, exact address otherwise", () => {
  assert.equal(getBrowserHost(undefined), "localhost");
  assert.equal(getBrowserHost("0.0.0.0"), "localhost");
  assert.equal(getBrowserHost("::"), "localhost");
  assert.equal(getBrowserHost("[::]"), "localhost");
  assert.equal(getBrowserHost("localhost"), "localhost");
  // loopback bind: open exactly what we listen on (localhost may be ::1)
  assert.equal(getBrowserHost("127.0.0.1"), "127.0.0.1");
  assert.equal(getBrowserHost("::1"), "[::1]");
  assert.equal(getBrowserHost("[::1]"), "[::1]");
  assert.equal(getBrowserHost("10.0.0.5"), "10.0.0.5");
  assert.equal(getBrowserHost("fd00::5"), "[fd00::5]");
});

// Security (SEC-DEPLOY / PHP SEC-03 parity): superuser JWT embedding gate
function fakeReq(remoteAddress, headers) {
  return {
    socket: { remoteAddress },
    headers: headers || {},
    ip: remoteAddress,
  };
}

test("shouldEmbedBypassJwt: only with the bypass on and never in production", () => {
  assert.equal(
    shouldEmbedBypassJwt(fakeReq("127.0.0.1"), {
      env: {},
      jwtChecksDisabled: false,
    }),
    false,
  );
  assert.equal(
    shouldEmbedBypassJwt(fakeReq("127.0.0.1"), {
      env: {},
      jwtChecksDisabled: true,
      isProduction: true,
    }),
    false,
  );
  assert.equal(
    shouldEmbedBypassJwt(fakeReq("10.0.0.9"), {
      env: { HAXCMS_HOST: "0.0.0.0" },
      jwtChecksDisabled: true,
      isProduction: true,
    }),
    false,
  );
  assert.equal(
    shouldEmbedBypassJwt(fakeReq("127.0.0.1"), {
      env: {},
      jwtChecksDisabled: true,
    }),
    true,
  );
});

test("shouldEmbedBypassJwt: loopback clients only unless HAXCMS_HOST is non-loopback", () => {
  const on = { env: {}, jwtChecksDisabled: true };
  for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(shouldEmbedBypassJwt(fakeReq(addr), on), true, addr);
  }
  for (const addr of [
    "10.0.0.9",
    "192.168.1.4",
    "::ffff:10.0.0.9",
    "fe80::1",
    "",
    undefined,
  ]) {
    assert.equal(shouldEmbedBypassJwt(fakeReq(addr), on), false, String(addr));
  }
  assert.equal(shouldEmbedBypassJwt(null, on), false);
  // spoofed proxy headers / req.ip do not count — only the socket peer
  const spoof = {
    socket: { remoteAddress: "10.0.0.9" },
    ip: "127.0.0.1",
    headers: { "x-forwarded-for": "127.0.0.1" },
  };
  assert.equal(shouldEmbedBypassJwt(spoof, on), false);
  // explicit loopback HAXCMS_HOST keeps the loopback-client requirement
  assert.equal(
    shouldEmbedBypassJwt(fakeReq("10.0.0.9"), {
      env: { HAXCMS_HOST: "127.0.0.1" },
      jwtChecksDisabled: true,
    }),
    false,
  );
  // operator deliberately exposed the bypass beyond loopback
  assert.equal(
    shouldEmbedBypassJwt(fakeReq("10.0.0.9"), {
      env: { HAXCMS_HOST: "0.0.0.0" },
      jwtChecksDisabled: true,
    }),
    true,
  );
});

// Security (SEC-DEPLOY / DNS rebinding): Host header guard for the no-login
// loopback server.
const listenHostLib = require(
  path.join(__dirname, "..", "..", "src", "lib", "listenHost.js"),
);

test("isLoopbackHostHeader accepts loopback names with or without port", () => {
  const ok = [
    "localhost",
    "localhost:3000",
    "LOCALHOST:8080",
    "127.0.0.1",
    "127.0.0.1:3000",
    "127.1.2.3:9",
    "[::1]",
    "[::1]:3000",
    "app.localhost:3000",
  ];
  ok.forEach((h) =>
    assert.equal(listenHostLib.isLoopbackHostHeader(h), true, h),
  );
});

test("isLoopbackHostHeader rejects foreign / rebinding hosts", () => {
  const bad = [
    undefined,
    null,
    "",
    "   ",
    "evil.example",
    "evil.example:3000",
    "127.0.0.1.evil.example",
    "localhost.evil.example",
    "10.0.0.5:3000",
    "[::]:3000",
    "[::1",
    "0.0.0.0:3000",
  ];
  bad.forEach((h) =>
    assert.equal(listenHostLib.isLoopbackHostHeader(h), false, String(h)),
  );
});

test("shouldEnforceLoopbackHostHeader only in bypass mode on a loopback bind", () => {
  assert.equal(
    listenHostLib.shouldEnforceLoopbackHostHeader("127.0.0.1", true),
    true,
  );
  assert.equal(
    listenHostLib.shouldEnforceLoopbackHostHeader("::1", true),
    true,
  );
  // auth on: normal deployments keep any Host
  assert.equal(
    listenHostLib.shouldEnforceLoopbackHostHeader("127.0.0.1", false),
    false,
  );
  // explicit LAN opt-in via HAXCMS_HOST is left alone (warned at startup)
  assert.equal(
    listenHostLib.shouldEnforceLoopbackHostHeader("0.0.0.0", true),
    false,
  );
  assert.equal(
    listenHostLib.shouldEnforceLoopbackHostHeader(undefined, true),
    false,
  );
});
