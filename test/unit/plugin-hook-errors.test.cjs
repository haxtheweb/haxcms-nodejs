"use strict";

// DRAFT plugin platform (contingent on https://github.com/haxtheweb/haxcms-plugins/pull/15).
//
// A plugin whose hooks throw never changes or breaks the save it hooks (spec/06: "A hook error is logged and does
// not crash the operation, except an explicit veto"; spec/13: "the chain continues with the previous subject"):
//   - saveNode, createNode, deleteNode and a file operation answer as they would with no plugin, and what is on
//     disk is what they would have written
//   - every throw is in the engine log, so the hooks really ran
// A veto is the one way a hook stops a write; those cases are in plugin-platform.test.cjs. The create golden suite
// runs the same plugin (golden-throw) across every hooked route on both backends (--throwing-plugin).
//
// Constraints honored: CommonJS (.cjs), require(), node:test + node:assert/strict, no optional chaining.

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-hook-errors-"));
process.env.HAXCMS_ROOT = testRoot + "/";
delete process.env.HAXCMS_PLUGINS;

// a plugin that throws from every hook these routes fire
const HOOKS = [
  "page.before.save",
  "page.after.save",
  "page.before.delete",
  "page.after.delete",
  "file.before.save",
  "file.after.save",
  "file.before.delete",
  "file.after.delete",
  "manifest.before.save",
  "manifest.after.save",
  "git.before.commit",
  "git.after.commit",
];
const pluginDir = path.join(testRoot, "fixtures", "fx-thrower");
fs.ensureDirSync(path.join(pluginDir, "src", "nodejs"));
fs.writeFileSync(
  path.join(pluginDir, "plugin.yaml"),
  [
    'specVersion: "0.1.0"',
    "id: fx-thrower",
    "uuid: 0d6b9e2a-5c41-4f8e-b3a7-1e9c2d4f6a85",
    "title: fx-thrower (test fixture)",
    "description: Throws from every hook it subscribes to.",
    "version: 0.1.0",
    "runtimes: [nodejs]",
    "entry:",
    "  nodejs: src/nodejs/index.js",
    "hooks:",
  ]
    .concat(HOOKS.map((h) => "  - name: " + h))
    .join("\n") + "\n",
);
fs.writeFileSync(
  path.join(pluginDir, "src", "nodejs", "index.js"),
  "const boom = (name) => () => { throw new Error('boom ' + name); };\n" +
    "export default { hooks: {\n" +
    HOOKS.map((h) => `  "${h}": boom("${h}"),`).join("\n") +
    "\n} };\n",
);
process.env.HAXCMS_PLUGIN_DIRS = pluginDir;

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const saveNode = require("../../src/siteRoutes/v1/routes/saveNode.js");
const createNode = require("../../src/siteRoutes/v1/routes/createNode.js");
const deleteNode = require("../../src/siteRoutes/v1/routes/deleteNode.js");
const files = require("../../src/siteRoutes/v1/files.js");
const pluginSystem = require("../../src/lib/plugins/pluginSystem.js");

test.after(() => {
  delete process.env.HAXCMS_PLUGIN_DIRS;
  fs.removeSync(testRoot);
});

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    send(obj) {
      this.sent = obj;
      return this;
    },
    set() {
      return this;
    },
  };
}

function siteReq(site, body) {
  return {
    headers: { "x-haxcms-site-token": "token" },
    query: {},
    params: {},
    body: Object.assign(
      { site: { name: site.manifest.metadata.site.name } },
      body,
    ),
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "admin",
      siteName: site.manifest.metadata.site.name,
    },
  };
}

const SITE = "hook-errors";
const site = () => HAXCMS.loadSite(SITE);
const logOf = async (s) => (await pluginSystem.host(s, { user: null })).log;
// the hooks whose throw was logged, in order
const thrown = (entries) =>
  entries
    .filter(
      (l) =>
        l.level === "error" &&
        l.plugin === "fx-thrower" &&
        /: boom /.test(l.message),
    )
    .map((l) => l.message.split(":")[0]);

before(async () => {
  assert.ok(await HAXCMS.loadSite(SITE, true), "site created");
  pluginSystem.reset();
  const h = await pluginSystem.host(await site(), { user: null });
  assert.equal(h.get("fx-thrower").status, "active");
});

describe("a plugin whose hooks throw changes nothing", () => {
  test("saveNode writes the page and its title; the throws are logged", async (t) => {
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    const s = await site();
    const page = s.manifest.items[0];
    const from = (await logOf(s)).length;
    const res = stubRes();
    await saveNode(
      siteReq(s, {
        node: {
          id: page.id,
          body: `<page-break title="Still saved" item-id="${page.id}" published></page-break><p>written anyway</p>`,
        },
      }),
      res,
    );
    assert.equal(res.statusCode, null, JSON.stringify(res.body));
    assert.equal(res.sent.status, 200);
    const after = await site();
    const stored = after.loadNode(page.id);
    assert.equal(stored.title, "Still saved");
    assert.match(
      fs.readFileSync(path.join(after.siteDirectory, stored.location), "utf8"),
      /written anyway/,
    );
    const log = thrown((await logOf(after)).slice(from));
    assert.ok(log.includes("page.before.save"), JSON.stringify(log));
    assert.ok(log.includes("page.after.save"), JSON.stringify(log));
  });

  test("createNode adds the page; deleteNode removes it; the throws are logged", async (t) => {
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    let s = await site();
    const count = s.manifest.items.length;
    const from = (await logOf(s)).length;
    const made = stubRes();
    await createNode(siteReq(s, { node: { title: "Made anyway" } }), made);
    assert.equal(made.sent && made.sent.status, 200, JSON.stringify(made.body));
    s = await site();
    assert.equal(s.manifest.items.length, count + 1);
    const created = s.manifest.items.find((i) => i.title === "Made anyway");
    assert.ok(created, "the page is in site.json");
    const gone = stubRes();
    await deleteNode(siteReq(s, { node: { id: created.id } }), gone);
    assert.equal(gone.sent && gone.sent.status, 200, JSON.stringify(gone.body));
    s = await site();
    assert.equal(s.manifest.items.length, count);
    assert.ok(!s.loadNode(created.id), "the page is gone");
    const log = thrown((await logOf(s)).slice(from));
    for (const hook of [
      "page.before.save",
      "page.after.save",
      "page.before.delete",
      "page.after.delete",
    ])
      assert.ok(log.includes(hook), hook + " " + JSON.stringify(log));
  });

  test("a file rename and delete happen; the throws are logged", async () => {
    const s = await site();
    const dir = path.join(s.siteDirectory, "files");
    fs.ensureDirSync(dir);
    fs.writeFileSync(path.join(dir, "kept.txt"), "data");
    const from = (await logOf(s)).length;
    await files.performFileOperation(
      s,
      "files/kept.txt",
      { operation: "rename", newName: "renamed" },
      90,
    );
    assert.ok(fs.existsSync(path.join(dir, "renamed.txt")));
    assert.ok(!fs.existsSync(path.join(dir, "kept.txt")));
    const result = await files.performFileOperation(
      s,
      "files/renamed.txt",
      { operation: "delete" },
      90,
    );
    assert.equal(result.data.deleted, true);
    assert.ok(!fs.existsSync(path.join(dir, "renamed.txt")));
    const log = thrown((await logOf(await site())).slice(from));
    for (const hook of [
      "file.before.save",
      "file.after.save",
      "file.before.delete",
      "file.after.delete",
    ])
      assert.ok(log.includes(hook), hook + " " + JSON.stringify(log));
  });
});
