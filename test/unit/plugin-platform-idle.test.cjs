"use strict";

// DRAFT plugin platform (contingent on https://github.com/haxtheweb/haxcms-plugins/pull/15).
//
// A HAXcms with no plugin enabled, which is every HAXcms until someone enables one:
//   - core's save points do no engine work and read no page
//   - a plugin in _plugins/ changes nothing until it is enabled
//   - the deployment target (HAXCMS_TARGET, spec/14) decides what an enabled plugin can do
//
// Constraints honored: CommonJS (.cjs), require(), node:test + node:assert/strict, no optional chaining.

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-idle-"));
process.env.HAXCMS_ROOT = testRoot + "/";
delete process.env.HAXCMS_PLUGIN_DIRS;
delete process.env.HAXCMS_TARGET;
const spec = path.dirname(
  require.resolve("@haxtheweb/haxcms-plugin-spec/package.json"),
);

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const pluginSystem = require("../../src/lib/plugins/pluginSystem.js");

test.after(() => {
  delete process.env.HAXCMS_TARGET;
  fs.removeSync(testRoot);
});

let site;
before(async () => {
  site = await HAXCMS.loadSite("idle-demo", true);
  assert.ok(
    site && site.manifest && site.manifest.items.length,
    "site with a page",
  );
});

describe("no plugin enabled", () => {
  test("save points hand the record back and the engine never reads the site's pages", async () => {
    const record = {
      id: site.manifest.items[0].id,
      title: "T",
      content: "<p>x</p>",
    };
    const pre = await pluginSystem.before(site, "page", record, {
      id: record.id,
    });
    assert.equal(pre.record, record);
    assert.equal(pre.veto, null);
    assert.deepEqual(
      (await pluginSystem.after(site, "page", record, null)).warnings,
      [],
    );
    assert.equal(await pluginSystem.rebuild(site, "save"), null);
    const h = await pluginSystem.host(site, { user: null });
    assert.deepEqual(
      Object.keys(h.records.page),
      [],
      "pages were hydrated with nothing listening",
    );
  });

  test("a plugin in _plugins is listed as available and still nothing listens", async () => {
    fs.copySync(
      path.join(spec, "conformance", "fixtures", "fx-backend"),
      path.join(testRoot, "_plugins", "fx-backend"),
    );
    pluginSystem.reset();
    const list = await pluginSystem.registry(null, {});
    assert.equal(list.find((e) => e.id === "fx-backend").status, "available");
    const record = {
      id: site.manifest.items[0].id,
      title: "T",
      content: "<p>one two</p>",
    };
    const pre = await pluginSystem.before(site, "page", record, {
      id: record.id,
    });
    assert.equal(pre.record, record, "an available plugin's hook ran");
  });
});

describe("the deployment target decides what an enabled plugin can do (spec/14)", () => {
  test("server by default; an unknown HAXCMS_TARGET is a server", () => {
    assert.equal(pluginSystem.target(), "server");
    process.env.HAXCMS_TARGET = "mainframe";
    assert.equal(pluginSystem.target(), "server");
    delete process.env.HAXCMS_TARGET;
  });

  test("in the browser a plugin that runs commands is inactive with the reason; one with a visitor route is limited", async () => {
    for (const id of ["fx-exec", "fx-optional"]) {
      fs.copySync(
        path.join(spec, "conformance", "fixtures", id),
        path.join(testRoot, "_plugins", id),
      );
    }
    fs.mkdirpSync(path.join(testRoot, "_config", "plugins"));
    fs.writeFileSync(
      path.join(testRoot, "_config", "plugins", "plugins.yaml"),
      "version: 1\nenabled: [fx-exec, fx-optional]\n",
    );
    process.env.HAXCMS_TARGET = "browser";
    pluginSystem.reset();
    const list = await pluginSystem.registry(site, {});
    const exec = list.find((e) => e.id === "fx-exec");
    assert.equal(exec.status, "inactive");
    assert.equal(exec.unmet[0].key, "backend.process");
    const optional = list.find((e) => e.id === "fx-optional");
    assert.equal(optional.status, "active");
    assert.deepEqual(
      optional.limited.map((l) => l.key),
      ["backend.visitors"],
    );
    process.env.HAXCMS_TARGET = "desktop";
    pluginSystem.reset();
    const desktop = await pluginSystem.registry(site, {});
    assert.equal(desktop.find((e) => e.id === "fx-exec").status, "active");
    delete process.env.HAXCMS_TARGET;
    pluginSystem.reset();
  });
});
