"use strict";

/**
 * Update awareness for the system status report (haxtheweb/issues#1768).
 * Vectors in test/fixtures/platform-update-vectors.json are shared verbatim
 * with haxcms-php system/backend/php/tests/fixtures/platform-update-vectors.json
 * (PlatformUpdateServiceTest.php), so both backends report the same thing.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  buildUpdateInfo,
  compareVersions,
  detectInstallMethod,
  findSecurityAdvisories,
  getUpdateCheckPolicy,
  normalizeAdvisoryPackage,
} = require("../../src/lib/platformUpdates.js");
const { buildVersionRow } = require("../../src/lib/systemStatus.js");

const vectors = require("../fixtures/platform-update-vectors.json");

test("compareVersions matches the shared vectors", () => {
  for (const c of vectors.compareVersions) {
    assert.equal(compareVersions(c.a, c.b), c.expected, `${c.a} vs ${c.b}`);
  }
});

test("normalizeAdvisoryPackage matches the shared vectors", () => {
  for (const c of vectors.normalizeAdvisoryPackage) {
    assert.equal(normalizeAdvisoryPackage(c.name), c.expected, c.name);
  }
});

test("findSecurityAdvisories matches the shared vectors", () => {
  for (const c of vectors.findSecurityAdvisories) {
    const found = findSecurityAdvisories(
      vectors.advisories,
      c.current,
      c.packageKey,
    );
    assert.deepEqual(
      found.map((a) => a.id),
      c.expectedIds,
      `${c.packageKey}@${c.current}`,
    );
  }
});

test("findSecurityAdvisories drops links outside the haxtheweb org", () => {
  const found = findSecurityAdvisories(
    vectors.advisories,
    "26.8.0",
    "haxcms-nodejs",
  );
  const untrusted = found.find((a) => a.id === "GHSA-0000-0000-untr");
  assert.equal(untrusted.url, "");
  assert.equal(untrusted.patched, "26.8.1");
});

test("buildUpdateInfo matches the shared vectors", () => {
  for (const c of vectors.buildUpdateInfo) {
    const info = buildUpdateInfo({
      currentVersion: c.input.currentVersion,
      managed: c.input.managed,
      checkEnabled: c.input.checkEnabled,
      installMethod: c.input.installMethod,
      packageKey: c.input.packageKey,
      release: c.input.useRelease ? vectors.release : null,
      advisories: c.input.useAdvisories ? vectors.advisories : null,
    });
    const e = c.expected;
    assert.equal(info.checkEnabled, e.checkEnabled, c.name);
    assert.equal(info.managed, e.managed, c.name);
    assert.equal(info.current, e.current, c.name);
    assert.equal(info.latest, e.latest, c.name);
    assert.equal(info.updateAvailable, e.updateAvailable, c.name);
    assert.equal(info.security, e.security, c.name);
    assert.equal(info.advisories.length, e.advisoryCount, c.name);
    assert.equal(info.installMethod, e.installMethod, c.name);
    assert.equal(info.assets.length, e.assetCount, c.name);
    for (const asset of info.assets) {
      assert.ok(asset.url.startsWith("https://github.com/haxtheweb/"), c.name);
    }
  }
});

test("getUpdateCheckPolicy: managed and config switch", () => {
  const make = (profile, updates) => ({
    config: updates === undefined ? {} : { updates },
    getDeploymentProfile: () => profile,
  });
  assert.deepEqual(getUpdateCheckPolicy(make("single-site")), {
    managed: false,
    checkEnabled: true,
  });
  assert.deepEqual(
    getUpdateCheckPolicy(make("self-hosted-multi-site", { check: false })),
    { managed: false, checkEnabled: false },
  );
  assert.deepEqual(
    getUpdateCheckPolicy(make("haxiam-managed", { check: true })),
    { managed: true, checkEnabled: false },
  );
});

test("detectInstallMethod", () => {
  const none = () => false;
  const root = path.join(
    path.sep,
    "srv",
    "node_modules",
    "@haxtheweb",
    "haxcms-nodejs",
  );
  assert.equal(
    detectInstallMethod({
      versions: { electron: "33.0.0" },
      env: {},
      exists: none,
      packageRoot: root,
    }),
    "desktop",
  );
  assert.equal(
    detectInstallMethod({
      versions: {},
      env: { HAXCMS_CONTAINER: "1" },
      exists: none,
      packageRoot: root,
    }),
    "node-docker",
  );
  assert.equal(
    detectInstallMethod({
      versions: {},
      env: {},
      exists: (p) => p === "/.dockerenv",
      packageRoot: root,
    }),
    "node-docker",
  );
  assert.equal(
    detectInstallMethod({
      versions: {},
      env: {},
      exists: (p) => p === path.join("/src/haxcms", ".git"),
      packageRoot: "/src/haxcms",
    }),
    "node-source",
  );
  assert.equal(
    detectInstallMethod({
      versions: {},
      env: {},
      exists: none,
      packageRoot: root,
    }),
    "node-npm",
  );
  assert.equal(
    detectInstallMethod({
      versions: {},
      env: {},
      exists: none,
      packageRoot: "/opt/haxcms",
    }),
    "unknown",
  );
});

test("buildVersionRow keeps the existing row without update info", () => {
  const row = buildVersionRow("26.8.1", "26.8.1", "https://x", undefined);
  assert.equal(row.tone, "ok");
  assert.equal(row.description, "Current: 26.8.1 · Latest: 26.8.1");
});

test("buildVersionRow: managed, checks off, security", () => {
  const managed = buildVersionRow("26.8.1", "unknown", "https://x", {
    managed: true,
    checkEnabled: false,
  });
  assert.equal(managed.tone, "info");
  assert.match(managed.description, /managed by your host/);
  const off = buildVersionRow("26.8.1", "unknown", "https://x", {
    managed: false,
    checkEnabled: false,
  });
  assert.equal(off.tone, "info");
  assert.match(off.description, /turned off/);
  const info = buildUpdateInfo({
    currentVersion: "26.8.1",
    checkEnabled: true,
    release: vectors.release,
    advisories: vectors.advisories,
    installMethod: "node-npm",
    packageKey: "haxcms-nodejs",
  });
  const security = buildVersionRow("26.8.1", info.latest, "https://x", info);
  assert.equal(security.tone, "error");
  assert.match(
    security.description,
    /Security update available: GHSA-6w22-ghxf-x2pv/,
  );
  assert.equal(security.links[0].label, "GHSA-6w22-ghxf-x2pv (high)");
});
