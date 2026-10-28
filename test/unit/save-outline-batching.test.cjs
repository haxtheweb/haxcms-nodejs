"use strict";

// saveOutline batching (haxtheweb/issues#3114): the request used to call
// site.updateNode() for every existing item, and each call rewrote site.json
// and rebuilt RSS / Atom / sitemap / llms.txt / the search index, so a save
// cost O(items^2). The manifest is now updated in memory and saved + rebuilt
// once per request.
//
// Runs the REAL saveOutline route against a REAL site (same temp-root pattern
// as create-site-route.test.cjs) and checks:
//   1. correctness: persisted site.json and every generated file are
//      byte-identical to what the legacy one-save-per-item flow produced
//      (the legacy flow is replayed by making updateNode ignore the new
//      persist flag, which is exactly what it did before)
//   2. cost: the number of site.json saves and alternate-format rebuilds per
//      request does not grow with the number of items
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

// sites are created under the module-level HAXCMS_ROOT resolved at require time
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saveoutline-batch-"));
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const saveOutline = require("../../src/siteRoutes/v1/routes/saveOutline.js");

test.after(() => {
  fs.removeSync(testRoot);
});

const GENERATED = [
  "site.json",
  "rss.xml",
  "atom.xml",
  "sitemap.xml",
  "llms.txt",
  "lunrSearchIndex.json",
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
  };
}

function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "saveoutline-config-"));
  const originalConfigDirectory = HAXCMS.configDirectory;
  HAXCMS.configDirectory = tmpDir;
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory;
    fs.removeSync(tmpDir);
  });
}

function mockAuth(t) {
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
}

function makeReq(siteName, items) {
  return {
    headers: { "x-haxcms-site-token": "token" },
    // the authenticated identity validateSiteApiRouteAccess resolves
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: siteName,
    },
    body: { site: { name: siteName }, items: items },
  };
}

// site with a root page, a child under it, and (itemCount - 2) more root pages
async function buildSite(t, siteName, itemCount) {
  const created = await HAXCMS.createSite(siteName);
  assert.ok(created, "site is created");
  mockAuth(t);
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    items.push({
      id: "client-" + i,
      title: "Page " + i,
      parent: i === 1 ? "client-0" : null,
      indent: i === 1 ? 1 : 0,
      order: i,
      metadata: {},
      new: true,
    });
  }
  const res = stubRes();
  await saveOutline(makeReq(siteName, items), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const site = await HAXCMS.loadSite(siteName);
  return site;
}

function siteDir(siteName) {
  return path.join(testRoot, "_sites", siteName);
}

function snapshot(siteName) {
  const out = {};
  GENERATED.forEach((file) => {
    const p = path.join(siteDir(siteName), file);
    out[file] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  });
  return out;
}

// the request a client sends when saving the outline: every item, renamed
// and reversed, with the first (parent) page flagged for deletion so the
// orphan rescue path runs too
function editRequest(site, withDelete = true) {
  const existing = site.manifest.items.map((i) => ({
    id: i.id,
    title: i.title + " edited",
    parent: i.parent,
    indent: i.indent,
    order: i.order,
    metadata: {},
  }));
  existing.reverse().forEach((item, index) => {
    item.order = index;
  });
  const parent = existing.find(
    (i) => i.parent === null && i.title.indexOf("Page 0") === 0,
  );
  if (withDelete) {
    parent.delete = true;
  }
  return existing;
}

async function runCounted(t, siteName, legacy, withDelete = true) {
  const site = await HAXCMS.loadSite(siteName);
  const counts = { manifestSave: 0, alternateFormats: 0 };
  const origSave = site.manifest.save.bind(site.manifest);
  t.mock.method(site.manifest, "save", async (...args) => {
    counts.manifestSave++;
    return origSave(...args);
  });
  const origAlt = site.updateAlternateFormats.bind(site);
  t.mock.method(site, "updateAlternateFormats", async (...args) => {
    counts.alternateFormats++;
    return origAlt(...args);
  });
  if (legacy) {
    // pre-#3114 behaviour: updateNode always saved site.json and rebuilt
    const origUpdate = site.updateNode.bind(site);
    t.mock.method(site, "updateNode", (page) => origUpdate(page, true));
  }
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const res = stubRes();
  await saveOutline(
    makeReq(site.manifest.metadata.site.name, editRequest(site, withDelete)),
    res,
  );
  t.mock.restoreAll();
  return { res, counts };
}

test("saveOutline output matches the one-save-per-item flow", async (t) => {
  useTempConfigDirectory(t);
  mockAuth(t);
  t.mock.method(Date, "now", () => 1760000000000);
  const name = "batch-parity";
  await buildSite(t, name, 6);
  const before = path.join(testRoot, "snapshot-" + name);
  fs.copySync(siteDir(name), before);

  const batched = await runCounted(t, name, false);
  assert.equal(batched.res.statusCode, 200, JSON.stringify(batched.res.body));
  const batchedFiles = snapshot(name);
  const batchedBody = JSON.stringify(batched.res.body);

  // restore the original site and replay the request the legacy way
  fs.removeSync(siteDir(name));
  fs.copySync(before, siteDir(name));
  mockAuth(t);
  t.mock.method(Date, "now", () => 1760000000000);
  const legacy = await runCounted(t, name, true);
  assert.equal(legacy.res.statusCode, 200, JSON.stringify(legacy.res.body));

  assert.equal(batchedBody, JSON.stringify(legacy.res.body), "same response");
  const legacyFiles = snapshot(name);
  GENERATED.forEach((file) => {
    assert.ok(batchedFiles[file] !== null, file + " is generated");
    assert.equal(batchedFiles[file], legacyFiles[file], file + " is identical");
  });
  // sanity: the request did something, and the legacy flow really did more work
  assert.ok(batchedFiles["site.json"].indexOf("edited") !== -1);
  assert.ok(legacy.counts.alternateFormats > batched.counts.alternateFormats);
});

test("saveOutline saves and rebuilds once per request, not once per item", async (t) => {
  useTempConfigDirectory(t);
  const results = {};
  for (const size of [4, 12]) {
    mockAuth(t);
    const name = "batch-count-" + size;
    await buildSite(t, name, size);
    results[size] = (await runCounted(t, name, false, false)).counts;
  }
  assert.deepEqual(
    results[12],
    results[4],
    "cost does not grow with item count",
  );
  // the checkpoint after the structure pass (1), rebuildManagedFiles()
  // refreshing llms.txt (1) and the final full rebuild (1)
  assert.equal(results[12].alternateFormats, 3);
  assert.ok(results[12].manifestSave <= 4, "fixed number of site.json saves");
});

test("deleting a parent costs a fixed number of rebuilds too", async (t) => {
  useTempConfigDirectory(t);
  const results = {};
  for (const size of [4, 12]) {
    mockAuth(t);
    const name = "batch-count-delete-" + size;
    await buildSite(t, name, size);
    // Page 0 is deleted and its child is rescued as an orphan
    results[size] = (await runCounted(t, name, false, true)).counts;
  }
  assert.deepEqual(
    results[12],
    results[4],
    "cost does not grow with item count",
  );
  // as above, plus the deleted page's own rebuild in deleteNode (1) and one
  // rebuild for all rescued orphans (1), so a failure after the orphan pass
  // leaves the feeds per-item saving left
  assert.equal(results[12].alternateFormats, 5);
});
