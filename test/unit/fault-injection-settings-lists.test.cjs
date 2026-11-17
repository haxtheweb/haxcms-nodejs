"use strict";

// Fault injection for the theme and skeleton list routes. Listing fills newly
// detected themes / skeletons into the enabled map and saves it to
// <configDirectory>/settings/. That save is housekeeping: when it fails
// (full disk, read-only or wrongly owned config folder) the list is still
// answered from the map in memory, and the failure is only logged. Without
// this, a full disk turned the new-site dashboard's theme and skeleton lists
// into 500s (no themes, no screenshots, no templates).
//
// Faults are injected at the filesystem boundary: fs-extra methods are
// mocked with node:test mocks so the settings write throws the errno a full
// disk / read-only mount would. No production seam is added.
//
// Scenario ids (FI-SET-*) are shared with haxcms-php
// (tests/Unit/FaultInjectionSettingsListsTest.php).
//
// CommonJS, no optional chaining, node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const themesList = require("../../src/systemRoutes/v1/routes/themesList.js");
const skeletonsList = require("../../src/systemRoutes/v1/routes/skeletonsList.js");
const {
  persistDetectedThemeDefaults,
} = require("../../src/lib/themeSettings.js");
const {
  persistDetectedSkeletonDefaults,
} = require("../../src/lib/skeletonSettings.js");

function stubRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

function makeReq(query) {
  return { headers: {}, query: query || {}, body: {} };
}

function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fi-settings-lists-"));
  const originalConfigDirectory = HAXCMS.configDirectory;
  HAXCMS.configDirectory = tmpDir;
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory;
    fs.removeSync(tmpDir);
  });
  return tmpDir;
}

function errnoError(code) {
  const err = new Error(code + ": injected settings write failure");
  err.code = code;
  return err;
}

// every way the settings save can fail: the folder cannot be made, or the
// file cannot be written
function failSettingsWrites(t, code) {
  const fired = [];
  t.mock.method(fs, "ensureDir", async (dir) => {
    fired.push(["ensureDir", dir]);
    throw errnoError(code);
  });
  t.mock.method(fs, "writeFile", async (file) => {
    fired.push(["writeFile", file]);
    throw errnoError(code);
  });
  // keep the expected warning out of the test output
  t.mock.method(console, "warn", () => {});
  return fired;
}

function mockThemes(t) {
  t.mock.method(HAXCMS, "getThemes", () => ({
    "theme-a": { element: "theme-a", name: "Theme A" },
    "theme-b": { element: "theme-b", name: "Theme B" },
  }));
}

function writeSkeleton(configDir, name) {
  const dir = path.join(configDir, "skeletons");
  fs.ensureDirSync(dir);
  fs.writeFileSync(
    path.join(dir, name + ".json"),
    JSON.stringify({
      meta: { name: name, useCaseTitle: name },
      site: { name: name },
      build: { items: [] },
      theme: {},
    }),
  );
}

// FI-SET-01 GET /system/api/v1/themes, ENOSPC on settings/enabledThemes.json
test("FI-SET-01 themes list answers 200 from memory when the enabled map cannot be saved", async (t) => {
  const configDir = useTempConfigDirectory(t);
  mockThemes(t);
  const fired = failSettingsWrites(t, "ENOSPC");
  const res = stubRes();
  await themesList(makeReq({ includeDisabled: "true" }), res);
  assert.ok(fired.length > 0, "fault fired");
  assert.equal(res.statusCode, null);
  assert.equal(res.body.status, 200);
  assert.deepEqual(
    res.body.data.map((item) => item.machineName),
    ["theme-a", "theme-b"],
  );
  // newly detected themes default to enabled, as when the save works
  assert.ok(res.body.data.every((item) => item.enabled === true));
  assert.equal(
    fs.existsSync(path.join(configDir, "settings", "enabledThemes.json")),
    false,
  );
});

// FI-SET-02 GET /system/api/v1/skeletons, EACCES on settings/enabledSkeletons.json
test("FI-SET-02 skeletons list answers 200 from memory when the enabled map cannot be saved", async (t) => {
  const configDir = useTempConfigDirectory(t);
  writeSkeleton(configDir, "fi-set-skeleton");
  const fired = failSettingsWrites(t, "EACCES");
  const res = stubRes();
  await skeletonsList(makeReq({ includeDisabled: "true" }), res);
  assert.ok(fired.length > 0, "fault fired");
  assert.equal(res.statusCode, null);
  assert.equal(res.body.status, 200);
  const item = res.body.data.find(
    (entry) => entry.machineName === "fi-set-skeleton",
  );
  assert.ok(item, "the skeleton is listed");
  assert.equal(item.enabled, true);
  assert.equal(
    fs.existsSync(path.join(configDir, "settings", "enabledSkeletons.json")),
    false,
  );
});

// FI-SET-03 the shared save helpers (also used by GET /x/api/v1/themes) report
// a failed save instead of throwing, and save normally otherwise
test("FI-SET-03 settings save helpers return false on a failed write and true otherwise", async (t) => {
  const configDir = useTempConfigDirectory(t);
  assert.equal(
    await persistDetectedThemeDefaults(HAXCMS, { "theme-a": true }),
    true,
  );
  assert.equal(
    await persistDetectedSkeletonDefaults(HAXCMS, { "skel-a": true }),
    true,
  );
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(configDir, "settings", "enabledThemes.json"),
        "utf8",
      ),
    ).enabledThemes,
    { "theme-a": true },
  );
  failSettingsWrites(t, "EROFS");
  assert.equal(
    await persistDetectedThemeDefaults(HAXCMS, { "theme-b": true }),
    false,
  );
  assert.equal(
    await persistDetectedSkeletonDefaults(HAXCMS, { "skel-b": true }),
    false,
  );
});
