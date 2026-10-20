"use strict";

// Security: path-containment hardening (CodeQL triage follow-up). Covers the
// site logo path (getLogoSize + save-time rejection), the multisite index
// fallback, the alternate-link / llms helpers, recurseCopy's now-required
// base, renamePageLocation/changeName, HAXCMSFile.save subfolder and
// FilesDataStore.buildFileRecordFromDisk.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const sharp = require("sharp");

const { HAXCMS, HAXCMSSite } = require("../../src/lib/HAXCMS.js");
const HAXCMSFile = require("../../src/lib/HAXCMSFile.js");
const FilesDataStore = require("../../src/lib/FilesDataStore.js");
const { isUnsafeRelativePath } = require("../../src/lib/pathConfinement.js");
const saveSeoSettings = require("../../src/siteRoutes/v1/routes/saveSeoSettings.js");
const saveManifest = require("../../src/siteRoutes/v1/routes/saveManifest.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const BAD_PATHS = [
  "../x.png",
  "files/../../x.png",
  "files/../../othertenant/files/a.png",
  "/etc/passwd",
  "/abs/files/a.png",
  "..\\x.png",
  "files\\..\\..\\x.png",
  "C:\\windows\\x.png",
  "files/a\0.png",
];

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    send(obj) {
      this.body = obj;
      return this;
    },
  };
}

async function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-pathhard-"));
  const sitesDir = path.join(root, "sites");
  const siteDir = path.join(sitesDir, "mysite");
  const otherDir = path.join(sitesDir, "othertenant");
  fs.ensureDirSync(path.join(siteDir, "pages", "item-1"));
  fs.ensureDirSync(path.join(siteDir, "files"));
  fs.writeFileSync(
    path.join(siteDir, "pages", "item-1", "index.html"),
    "<p>hi</p>",
  );
  const manifest = fs.readJsonSync(
    path.join(REPO_ROOT, "src", "boilerplate", "site", "site.json"),
  );
  manifest.metadata = { site: { name: "mysite" }, theme: {} };
  fs.writeJsonSync(path.join(siteDir, "site.json"), manifest);
  fs.writeFileSync(path.join(siteDir, "index.html"), "SITE INDEX");
  fs.ensureDirSync(path.join(otherDir, "files", "haxcms-managed"));
  fs.writeFileSync(path.join(otherDir, "index.html"), "OTHER INDEX");
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#f00" },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(otherDir, "files", "a.png"), png);
  fs.writeFileSync(path.join(siteDir, "files", "logo.png"), png);
  fs.writeFileSync(path.join(root, "x.png"), png);
  const site = new HAXCMSSite();
  await site.load(sitesDir, "/", "mysite");
  site.gitCommit = async () => true;
  site.updateAlternateFormats = async () => true;
  t.after(() => fs.removeSync(root));
  return { root, sitesDir, siteDir, otherDir, site, png };
}

function mockAuth(t, site) {
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
  t.mock.method(HAXCMS, "loadSite", async () => site);
}

// --- isUnsafeRelativePath --------------------------------------------------

test("isUnsafeRelativePath: rejects traversal / absolute, allows normal values", () => {
  for (const bad of BAD_PATHS) {
    assert.equal(isUnsafeRelativePath(bad), true, bad);
  }
  assert.equal(isUnsafeRelativePath(null), true);
  assert.equal(isUnsafeRelativePath("files/logo.png"), false);
  assert.equal(isUnsafeRelativePath("decks/my-deck"), false);
  assert.equal(isUnsafeRelativePath("files/..foo/logo.png"), false);
  assert.equal(isUnsafeRelativePath("https://example.com/logo.png"), false);
});

// --- getLogoSize -----------------------------------------------------------

test("getLogoSize: normal files/ logo is resized into files/haxcms-managed", async (t) => {
  const fx = await makeFixture(t);
  fx.site.manifest.metadata.site.logo = "files/logo.png";
  const out = await fx.site.getLogoSize("16", "16");
  assert.equal(out, "files/haxcms-managed/16x16-logo.png");
  assert.equal(fs.existsSync(path.join(fx.siteDir, out)), true);
});

test("getLogoSize: traversal / absolute / non-files logo never reads or writes outside the site", async (t) => {
  const fx = await makeFixture(t);
  const before = fs.readdirSync(
    path.join(fx.otherDir, "files", "haxcms-managed"),
  );
  const rootBefore = fs.readdirSync(fx.root).sort();
  for (const bad of BAD_PATHS.concat(["x.png", "pages/item-1/index.html"])) {
    fx.site.manifest.metadata.site.logo = bad;
    const out = await fx.site.getLogoSize("16", "16");
    assert.equal(
      out,
      "assets/icon-16x16.png",
      "fallback for " + JSON.stringify(bad),
    );
  }
  assert.deepEqual(
    fs.readdirSync(path.join(fx.otherDir, "files", "haxcms-managed")),
    before,
  );
  assert.deepEqual(fs.readdirSync(fx.root).sort(), rootBefore);
  assert.equal(
    fs.existsSync(path.join(fx.siteDir, "files", "haxcms-managed")),
    false,
  );
});

test("getLogoSize: symlinked logo escaping the site is refused", async (t) => {
  const fx = await makeFixture(t);
  fs.symlinkSync(
    path.join(fx.otherDir, "files"),
    path.join(fx.siteDir, "files", "evil"),
  );
  fx.site.manifest.metadata.site.logo = "files/evil/a.png";
  const out = await fx.site.getLogoSize("16", "16");
  assert.equal(out, "assets/icon-16x16.png");
  assert.deepEqual(
    fs.readdirSync(path.join(fx.otherDir, "files", "haxcms-managed")),
    [],
  );
});

// --- save-time rejection ---------------------------------------------------

test("saveSeoSettings: traversal logo is rejected with 400 and not stored", async (t) => {
  for (const bad of ["../../x.png", "/etc/passwd", "..\\x.png"]) {
    const fx = await makeFixture(t);
    mockAuth(t, fx.site);
    t.mock.method(fx.site.manifest, "save", async () => true);
    const res = stubRes();
    await saveSeoSettings(
      {
        headers: { "x-haxcms-site-token": "t" },
        body: { site: { name: "mysite" }, seo: { logo: bad } },
      },
      res,
    );
    assert.equal(res.statusCode, 400, bad);
    assert.notEqual(fx.site.manifest.metadata.site.logo, bad);
  }
});

test("saveSeoSettings: normal logo is stored", async (t) => {
  const fx = await makeFixture(t);
  mockAuth(t, fx.site);
  t.mock.method(fx.site.manifest, "save", async () => true);
  const res = stubRes();
  await saveSeoSettings(
    {
      headers: { "x-haxcms-site-token": "t" },
      body: { site: { name: "mysite" }, seo: { logo: "files/logo.png" } },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(fx.site.manifest.metadata.site.logo, "files/logo.png");
});

test("saveManifest: traversal logo is rejected with 400, normal logo accepted", async (t) => {
  const fx = await makeFixture(t);
  mockAuth(t, fx.site);
  t.mock.method(fx.site.manifest, "save", async () => true);
  fx.site.rebuildManagedFiles = async () => true;
  // any field the legacy form handler reads that we did not set is ''
  const blank = (base) =>
    new Proxy(base, {
      get: (o, k) => (k in o || typeof k !== "string" ? o[k] : ""),
    });
  const body = (logo) => ({
    site: { name: "mysite" },
    haxcms_form_id: "siteForm",
    haxcms_form_token: "tok",

    manifest: {
      theme: blank({ "manifest-metadata-theme-element": "none" }),
      author: blank({}),
      seo: blank({}),
      site: {
        "manifest-title": "T",
        "manifest-description": "D",
        "manifest-metadata-site-domain": "",
        "manifest-metadata-site-logo": logo,
        "manifest-metadata-site-tags": "",
      },
    },
  });
  const bad = stubRes();
  await saveManifest(
    { headers: { "x-haxcms-site-token": "t" }, body: body("../../x.png") },
    bad,
  );
  assert.equal(bad.statusCode, 400);
  assert.notEqual(fx.site.manifest.metadata.site.logo, "../../x.png");
  const good = stubRes();
  await saveManifest(
    { headers: { "x-haxcms-site-token": "t" }, body: body("files/logo.png") },
    good,
  );
  assert.notEqual(good.statusCode, 400);
  assert.equal(fx.site.manifest.metadata.site.logo, "files/logo.png");
});

// --- multisite index fallback ----------------------------------------------

test("resolveSiteIndexPath: normal site resolves, traversal inputs are rejected or neutralised", async (t) => {
  const fx = await makeFixture(t);
  const ok = HAXCMS.resolveSiteIndexPath(fx.sitesDir, "mysite");
  assert.equal(ok, fs.realpathSync(path.join(fx.siteDir, "index.html")));
  assert.equal(HAXCMS.resolveSiteIndexPath(fx.sitesDir, "MySite"), ok);
  const realSites = fs.realpathSync(fx.sitesDir);
  for (const bad of [
    "..",
    "../mysite",
    "..\\..\\mysite",
    "%2e%2e",
    "..%2Fothertenant",
    "/etc",
    "\0",
    "",
    null,
    "%E0%A4%A",
  ]) {
    const out = HAXCMS.resolveSiteIndexPath(fx.sitesDir, bad);
    if (out !== false) {
      // cleanTitle neutralised it: must still be inside the sites dir
      assert.ok(
        out.startsWith(path.join(fx.sitesDir) + path.sep) ||
          out.startsWith(realSites + path.sep),
        bad + " -> " + out,
      );
      assert.ok(out.indexOf("..") === -1);
    }
    assert.notEqual(out, path.join(fx.root, "index.html"));
  }
  assert.equal(HAXCMS.resolveSiteIndexPath(fx.sitesDir, ".."), false);
  assert.equal(HAXCMS.resolveSiteIndexPath(fx.sitesDir, "%E0%A4%A"), false);
});

// --- recurseCopy -----------------------------------------------------------

test("recurseCopy: base is required; traversal and escaping destinations are refused", async (t) => {
  const fx = await makeFixture(t);
  const src = path.join(fx.siteDir, "pages", "item-1");
  assert.equal(
    await HAXCMS.recurseCopy(src, path.join(fx.siteDir, "pages", "copy")),
    false,
  );
  assert.equal(fs.existsSync(path.join(fx.siteDir, "pages", "copy")), false);
  assert.equal(
    await HAXCMS.recurseCopy(
      src,
      path.join(fx.siteDir, "pages", "copy"),
      [],
      fx.siteDir,
    ),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(fx.siteDir, "pages", "copy", "index.html")),
    true,
  );
  assert.equal(
    await HAXCMS.recurseCopy(src, fx.siteDir + "/../escaped", [], fx.siteDir),
    false,
  );
  assert.equal(
    await HAXCMS.recurseCopy(
      src,
      path.join(fx.root, "escaped"),
      [],
      fx.siteDir,
    ),
    false,
  );
  assert.equal(fs.existsSync(path.join(fx.root, "escaped")), false);
  assert.equal(fs.existsSync(path.join(fx.sitesDir, "escaped")), false);
});

// --- alternate link tags / llms summary -----------------------------------

test("getPageAlternateLinkTags: only contained variants are advertised", async (t) => {
  const fx = await makeFixture(t);
  fs.writeFileSync(
    path.join(fx.siteDir, "pages", "item-1", "index.md"),
    "# hi",
  );
  const good = fx.site.getPageAlternateLinkTags(
    { slug: "item-1", location: "pages/item-1/index.html" },
    "/item-1",
  );
  assert.match(good, /item-1\.md/);
  // a poisoned location must not probe a sibling tenant or parent dir
  fs.writeFileSync(path.join(fx.otherDir, "index.md"), "# secret");
  fs.writeFileSync(path.join(fx.root, "x.md"), "# secret");
  for (const loc of [
    "../othertenant/index.html",
    "../../x.html",
    "..\\..\\x.html",
  ]) {
    const out = fx.site.getPageAlternateLinkTags(
      { slug: "item-1", location: loc },
      "/item-1",
    );
    assert.equal(out.indexOf(".md"), -1, loc);
  }
});

test("getLLMSPageSummary: markdown sidecar is read only from inside the site", async (t) => {
  const fx = await makeFixture(t);
  fs.writeFileSync(
    path.join(fx.siteDir, "pages", "item-1", "index.md"),
    "Inside sidecar text here.",
  );
  fs.writeFileSync(
    path.join(fx.otherDir, "index.md"),
    "SECRET other tenant text.",
  );
  const item = { location: "pages/none/index.html" };
  assert.match(
    fx.site.getLLMSPageSummary(item, "cut mid", "pages/item-1/index.md"),
    /Inside sidecar/,
  );
  assert.doesNotMatch(
    fx.site.getLLMSPageSummary(item, "cut mid", "../othertenant/index.md"),
    /SECRET/,
  );
  assert.doesNotMatch(
    fx.site.getLLMSPageSummary(item, "cut mid", "..\\othertenant\\index.md"),
    /SECRET/,
  );
});

// --- renamePageLocation / changeName --------------------------------------

test("renamePageLocation: traversal is rejected, normal rename works", async (t) => {
  const fx = await makeFixture(t);
  fs.ensureDirSync(path.join(fx.otherDir, "pages", "s"));
  fs.writeFileSync(
    path.join(fx.otherDir, "pages", "s", "index.html"),
    "SECRET",
  );
  assert.equal(
    await fx.site.renamePageLocation(
      "../othertenant/pages/s/index.html",
      "pages/stolen/index.html",
    ),
    false,
  );
  assert.equal(
    await fx.site.renamePageLocation(
      "pages/item-1/index.html",
      "../../escaped/index.html",
    ),
    false,
  );
  assert.equal(
    await fx.site.renamePageLocation(
      "pages/item-1/index.html",
      "..\\..\\escaped\\index.html",
    ),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(fx.siteDir, "pages", "item-1", "index.html")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(fx.otherDir, "pages", "s", "index.html")),
    true,
  );
  assert.equal(fs.existsSync(path.join(fx.root, "escaped")), false);
  try {
    // the trailing unlink of the already-moved file throws (pre-existing
    // behaviour); the move itself is what matters here
    await fx.site.renamePageLocation(
      "pages/item-1/index.html",
      "pages/item-2/index.html",
    );
  } catch (e) {}
  assert.equal(fs.existsSync(path.join(fx.siteDir, "pages", "item-2")), true);
  assert.equal(
    fs.existsSync(path.join(fx.siteDir, "pages", "item-2", "index.html")),
    true,
  );
});

test("changeName: traversal / absolute names are rejected", async (t) => {
  const fx = await makeFixture(t);
  for (const bad of ["../evil", "..\\evil", "/tmp/evil", "a/../../evil"]) {
    assert.equal(await fx.site.changeName(bad), false, bad);
  }
  assert.equal(fx.site.manifest.metadata.site.name, "mysite");
});

// --- HAXCMSFile.save subfolder --------------------------------------------

test("HAXCMSFile.save: traversal / absolute subfolder is rejected, nested subfolder works", async (t) => {
  const fx = await makeFixture(t);
  const mk = (name) => {
    const tmp = path.join(fx.root, "upload-" + name + ".png");
    fs.writeFileSync(tmp, fx.png);
    return {
      path: tmp,
      originalname: name + ".png",
      name: name + ".png",
      mimetype: "image/png",
    };
  };
  for (const bad of ["../evil", "..\\evil", "/abs", "a/../../evil"]) {
    const result = await new HAXCMSFile().save(
      mk("bad"),
      fx.site,
      null,
      null,
      bad,
    );
    assert.equal(result.status, 500, bad);
    assert.match(result.data.message, /subfolder/i);
  }
  assert.equal(fs.existsSync(path.join(fx.siteDir, "evil")), false);
  assert.equal(fs.existsSync(path.join(fx.siteDir, "files", "bad.png")), false);
  const ok = await new HAXCMSFile().save(
    mk("fine"),
    fx.site,
    null,
    null,
    "decks/mydeck",
  );
  assert.notEqual(ok.status, 500, JSON.stringify(ok));
  assert.equal(
    fs.existsSync(
      path.join(fx.siteDir, "files", "decks", "mydeck", "fine.png"),
    ),
    true,
  );
});

// --- FilesDataStore.buildFileRecordFromDisk --------------------------------

test("FilesDataStore.buildFileRecordFromDisk: traversal returns null, normal file returns a record", async (t) => {
  const fx = await makeFixture(t);
  const store = new FilesDataStore(fx.site);
  const record = await store.buildFileRecordFromDisk("files/logo.png");
  assert.ok(record, "record for contained file");
  for (const bad of [
    "files/../../x.png",
    "../x.png",
    "files/../../othertenant/files/a.png",
    "files/a\0.png",
  ]) {
    assert.equal(await store.buildFileRecordFromDisk(bad), null, bad);
  }
});

test("pathWithinBase handles very long runs of trailing slashes in linear time", () => {
  const { pathWithinBase } = require("../../src/lib/pathConfinement");
  const slashes = "/".repeat(200000);
  const start = Date.now();
  assert.equal(pathWithinBase("/a/b" + slashes + "x", "/a/b" + slashes), true);
  assert.equal(pathWithinBase("/a/b" + slashes, "/a/b"), true);
  assert.equal(pathWithinBase("/a/bc", "/a/b" + slashes), false);
  assert.ok(Date.now() - start < 1000);
});
