"use strict";

// A site created without a build starts with the default-starter skeleton's
// pages. The skeleton is looked up like every other one: user, then config,
// then core, so a deployment can replace it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  readDefaultStarterItems,
} = require("../../src/lib/skeletonSettings.js");

function fakeHaxcms() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starter-"));
  const haxcms = {
    configDirectory: path.join(root, "config"),
    coreConfigPath: path.join(root, "core"),
  };
  for (const dir of [
    "config/user/skeletons",
    "config/skeletons",
    "core/skeletons",
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  return { root, haxcms };
}

function writeStarter(dir, items) {
  fs.writeFileSync(
    path.join(dir, "default-starter.json"),
    JSON.stringify({ build: { structure: "from-skeleton", items } }),
  );
}

test("the core default-starter gives the pages", () => {
  const { root, haxcms } = fakeHaxcms();
  writeStarter(path.join(root, "core/skeletons"), [{ id: "a", title: "Home" }]);
  assert.deepEqual(readDefaultStarterItems(haxcms), [
    { id: "a", title: "Home" },
  ]);
});

test("a deployment's default-starter wins over the core one", () => {
  const { root, haxcms } = fakeHaxcms();
  writeStarter(path.join(root, "core/skeletons"), [{ id: "a", title: "Home" }]);
  writeStarter(path.join(root, "config/skeletons"), [
    { id: "b", title: "Start" },
  ]);
  assert.equal(readDefaultStarterItems(haxcms)[0].title, "Start");
});

test("no usable default-starter gives null, so the site falls back to Welcome", () => {
  const { root, haxcms } = fakeHaxcms();
  assert.equal(readDefaultStarterItems(haxcms), null);
  writeStarter(path.join(root, "core/skeletons"), []);
  assert.equal(readDefaultStarterItems(haxcms), null);
  fs.writeFileSync(
    path.join(root, "config/skeletons/default-starter.json"),
    "{not json",
  );
  assert.equal(readDefaultStarterItems(haxcms), null);
});
