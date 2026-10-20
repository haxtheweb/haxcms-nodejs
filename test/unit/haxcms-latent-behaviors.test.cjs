"use strict";

// Latent-behavior + coverage tests for the HAXCMS core + HAXCMSSite surface of
// src/lib/HAXCMS.js, extending the haxcms-site-operations.test.cjs harness
// (temp runtime with a seeded _config created and cwd moved into it BEFORE
// the first require, so config discovery and all site writes stay inside the
// temp tree; real site creation through HAXCMS.createSite). No production
// behavior is fixed here — current behavior is asserted with characterization
// comments where it is latent.
//
// Documented latent behaviors:
//   - loadNodeByLocation() with no argument throws: its `path` parameter
//     shadows the path module, so `path.resolve` reads a property of null.
//   - getSocialShareImage(null) reaches the same broken call and throws.
//   - loadNodeByLocation walks this.manifest.files, which JSONOutlineSchema
//     never populates — the walk only matches when manifest.files is set
//     manually (as done here to exercise the loop).
//   - loadNodeFieldSchema's core cascade reads coreFields.configure /
//     .advanced, but the real nodeFields.json nests everything under
//     fields[0].properties, so the core loops never run against the shipped
//     file; a crafted core nodeFields.json walks them and the object-initial
//     .push rejects (fields.configure is {} but merged via Array.push).
//   - HAXCMS.config.node.fields.advanced walks the same rejecting push.
//   - processForm('siteSettings', ...) runs the whole settings-value load and
//     has no return value (its undeclared-global strict-mode error is fixed).
//   - itemSelectorList now takes the site as an argument (it used to read an
//     undeclared PHP-port global); hierarchical items still reject on the
//     missing this.findParent method.
//   - HAXCMS.createSite falls back to config.site.git for git details and
//     appends '<name>.git' to its url; the github.io domain heuristic and
//     the node_modules symlink branch also walk here.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BOILERPLATE_SYSTEMSETUP = path.join(
  REPO_ROOT,
  "src",
  "boilerplate",
  "systemsetup",
);

const TEST_USER_NAME = "latent-behaviors-user";
const TEST_USER_PASSWORD = "latent-behaviors-pass";

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-latent-"));
const runtimeRoot = path.join(tempRoot, "runtime");
const configRoot = path.join(runtimeRoot, "_config");
const sitesRoot = path.join(runtimeRoot, "_sites");

function seedRuntimeConfig() {
  fs.ensureDirSync(configRoot);
  fs.writeFileSync(path.join(configRoot, ".isHAXcmsConfig"), "");
  const seedFiles = [
    "config.json",
    "my-custom-elements.js",
    "userData.json",
    "config.php",
    ".htaccess",
    ".user-files-htaccess",
  ];
  for (let i = 0; i < seedFiles.length; i++) {
    fs.copySync(
      path.join(BOILERPLATE_SYSTEMSETUP, seedFiles[i]),
      path.join(configRoot, seedFiles[i]),
    );
  }
  fs.ensureDirSync(path.join(configRoot, "tmp"));
  fs.ensureDirSync(path.join(configRoot, "cache"));
  fs.ensureDirSync(path.join(configRoot, "user"));
  fs.ensureDirSync(path.join(configRoot, "user", "files"));
  fs.ensureDirSync(path.join(configRoot, "user", "skeletons"));
  fs.ensureDirSync(path.join(configRoot, "skeletons"));
  fs.ensureDirSync(path.join(configRoot, "settings"));
  fs.ensureDirSync(path.join(configRoot, "node_modules"));
}

fs.ensureDirSync(sitesRoot);
seedRuntimeConfig();
fs.writeFileSync(
  path.join(configRoot, ".user"),
  JSON.stringify(
    { name: TEST_USER_NAME, password: TEST_USER_PASSWORD },
    null,
    2,
  ),
);

process.chdir(runtimeRoot);
// HAXCMS.js mixes string concat (HAXCMS_ROOT + sitesDirectory) and path.join,
// so the root env var must carry a trailing slash.
process.env.HAXCMS_ROOT = runtimeRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");

test.after(() => {
  process.chdir(originalCwd);
  delete process.env.HAXCMS_ROOT;
  fs.removeSync(tempRoot);
});

// point coreConfigPath at a temp core-config tree (nodeFields.json / skeletons)
function useTempCoreConfigPath(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-latent-core-"));
  const originalCoreConfigPath = HAXCMS.coreConfigPath;
  HAXCMS.coreConfigPath = tmpDir + "/";
  t.after(() => {
    HAXCMS.coreConfigPath = originalCoreConfigPath;
    fs.removeSync(tmpDir);
  });
  return tmpDir;
}

test("harness points at the temp runtime", () => {
  assert.equal(HAXCMS.HAXCMS_ROOT, runtimeRoot + "/");
});

test("loadNodeByLocation without a path argument throws on the shadowed path module", async () => {
  const site = await HAXCMS.createSite("latent-site");
  // Characterization: the `path` parameter shadows the path module, so the
  // default branch reads `path.resolve` off null and rejects. If this fails
  // after a fix, update it to the fixed contract.
  assert.throws(
    () => site.loadNodeByLocation(),
    function (err) {
      return err instanceof TypeError && err.message.indexOf("resolve") !== -1;
    },
  );
  // the same broken call is reachable through getSocialShareImage(null)
  assert.throws(
    () => site.getSocialShareImage(null),
    function (err) {
      return err instanceof TypeError && err.message.indexOf("resolve") !== -1;
    },
  );
});

test("loadNodeByLocation matches an item only when manifest.files is populated", async () => {
  const site = await HAXCMS.loadSite("latent-site");
  const first = site.manifest.items[0];
  // Characterization: the walk iterates this.manifest.files, which
  // JSONOutlineSchema never populates, so lookups only match when the index
  // is wired manually (as here). Without it every lookup answers a fresh
  // blank item — see haxcms-site-operations.test.cjs.
  site.manifest.files = { 0: 0 };
  try {
    // the method PREPENDS pages/ itself, so callers pass the bare page path
    // (a location minus its pages/ prefix and /index.html suffix)
    const barePath = first.location
      .replace("pages/", "")
      .replace("/index.html", "");
    const lookedUp = site.loadNodeByLocation(barePath);
    assert.equal(lookedUp.id, first.id);
    const unmatched = site.loadNodeByLocation("no-such-page");
    assert.ok(unmatched && unmatched.id && unmatched.id.indexOf("item-") === 0);
  } finally {
    delete site.manifest.files;
  }
});

test("loadNodeFieldSchema walks a crafted core nodeFields.json and rejects on the object push", async (t) => {
  const coreDir = useTempCoreConfigPath(t);
  const site = await HAXCMS.loadSite("latent-site");
  const page = site.manifest.items[0];
  // Characterization: the shipped nodeFields.json nests its fields under
  // fields[0].properties, so coreFields.configure / .advanced never exist and
  // these loops are dead against the real file. A crafted flat shape walks
  // them — and fields.configure is object-initialized but merged with
  // Array.push, so the first core field rejects. If this fails after a schema
  // fix, update it to the fixed contract.
  fs.writeFileSync(
    path.join(coreDir, "nodeFields.json"),
    JSON.stringify({
      advanced: [{ property: "theme", title: "Theme" }],
      configure: [
        { property: "node-configure-title" },
        { property: "location" },
      ],
    }),
  );
  await assert.rejects(
    () => site.loadNodeFieldSchema(page),
    function (err) {
      return err instanceof TypeError && err.message.indexOf("push") !== -1;
    },
  );
  // configure absent, advanced present: the advanced loop walks to its push
  fs.writeFileSync(
    path.join(coreDir, "nodeFields.json"),
    JSON.stringify({
      advanced: [{ property: "theme", title: "Theme" }],
    }),
  );
  await assert.rejects(
    () => site.loadNodeFieldSchema(page),
    function (err) {
      return err instanceof TypeError && err.message.indexOf("push") !== -1;
    },
  );
});

test("loadNodeFieldSchema walks config.node.fields.advanced to its rejecting push", async (_t) => {
  const site = await HAXCMS.loadSite("latent-site");
  const page = site.manifest.items[0];
  HAXCMS.config.node.fields = {
    advanced: { latentAdvKey: { property: "latentAdvKey" } },
  };
  try {
    await assert.rejects(
      () => site.loadNodeFieldSchema(page),
      function (err) {
        return err instanceof TypeError && err.message.indexOf("push") !== -1;
      },
    );
  } finally {
    delete HAXCMS.config.node.fields;
  }
});

test("processForm runs the settings value load and resolves", async () => {
  // processForm ignores `params` and passes its `context` through, so the
  // settings values load runs against the context here. strict-mode fix: the
  // undeclared `value` assignment used to reject after the await.
  assert.equal(
    await HAXCMS.processForm(
      "siteSettings",
      {},
      { site: { name: "latent-site" } },
    ),
    undefined,
  );
});

test("itemSelectorList builds the selector from the site it is given", () => {
  // strict-mode fix: the site is an argument now (it used to be read from an
  // undeclared global); flat pages exercise the whole walk without findParent
  const items = [
    { id: "p1", title: "Page One", parent: null },
    { id: "p2", title: "Page Two", parent: null },
  ];
  const fakeSite = { manifest: { orderTree: (list) => list, items: items } };
  const list = HAXCMS.itemSelectorList(fakeSite);
  assert.deepEqual(list[0], { text: "-- No page --", value: null });
  assert.deepEqual(list[1], { text: "- Page One", value: "p1" });
  assert.deepEqual(list[2], { text: "- Page Two", value: "p2" });
  // no implicit globals leak out of the walk
  assert.equal(
    Object.prototype.hasOwnProperty.call(globalThis, "itemValues"),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(globalThis, "distance"),
    false,
  );
});

test("itemSelectorList rejects on hierarchical items because findParent is missing", () => {
  const items = [
    { id: "p1", title: "Page One", parent: null },
    { id: "p2", title: "Page Two", parent: "p1" },
  ];
  const fakeSite = { manifest: { orderTree: (list) => list, items: items } };
  // Characterization: the depth walk calls this.findParent, which is not
  // defined on the core class, so any hierarchical item rejects.
  assert.throws(
    () => HAXCMS.itemSelectorList(fakeSite),
    function (err) {
      return (
        err instanceof TypeError && err.message.indexOf("findParent") !== -1
      );
    },
  );
});

test("the unported PHP DOM helpers are gone", () => {
  // html_to_obj/element_to_obj referenced DOMDocument/mb_convert_encoding/
  // XML_TEXT_NODE (never available in Node) and assigned undeclared globals
  assert.equal(typeof HAXCMS.html_to_obj, "undefined");
  assert.equal(typeof HAXCMS.element_to_obj, "undefined");
});

test("createSite falls back to config.site.git details and appends the name", async (t) => {
  const originalGit = HAXCMS.config.site.git;
  HAXCMS.config.site.git = { url: "git@github.com:latent-org" };
  t.after(() => {
    HAXCMS.config.site.git = originalGit;
  });
  const site = await HAXCMS.createSite("latent-git-fallback", null, {
    remote: true,
  });
  assert.ok(site);
  // Characterization: the config git fallback appends '<name>.git' to the
  // url inside the local gitDetails, but without a gitDetails.user the
  // github.io domain heuristic never fires, so the site domain stays null
  // and the (throwing) setRemote is a swallowed no-op.
  assert.equal(site.manifest.metadata.site.domain, null);
  assert.ok(
    fs.statSync(path.join(sitesRoot, "latent-git-fallback")).isDirectory(),
  );
});

test("createSite uses the github.io domain when git details carry a user", async (t) => {
  const originalGit = HAXCMS.config.site.git;
  HAXCMS.config.site.git = {};
  t.after(() => {
    HAXCMS.config.site.git = originalGit;
  });
  const site = await HAXCMS.createSite("latent-user-site", null, {
    user: "latent-user",
    url: "git@github.com:latent-user/none.git",
  });
  assert.ok(site);
  assert.equal(
    site.manifest.metadata.site.domain,
    "https://latent-user.github.io/latent-user-site",
  );
  // gitSetRemote is a silent no-op in this harness (repo is never defined),
  // so the site still builds fine
  assert.ok(
    fs.statSync(path.join(sitesRoot, "latent-user-site")).isDirectory(),
  );
});

test("createSite links node_modules into the new site when the runtime has one", async () => {
  // the runtime node_modules symlink branch only runs when HAXCMS_ROOT has a
  // node_modules directory; the seeded config has one at the config root, so
  // create a real one at the runtime root for this call
  fs.ensureDirSync(path.join(runtimeRoot, "node_modules", "placeholder-pkg"));
  const site = await HAXCMS.createSite("latent-node-modules-site");
  assert.ok(site);
  const linked = path.join(
    sitesRoot,
    "latent-node-modules-site",
    "node_modules",
  );
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.equal(fs.readlinkSync(linked), "../../node_modules");
});
