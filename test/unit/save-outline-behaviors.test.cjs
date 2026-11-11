"use strict";

// saveOutline: behaviors the mutation run found unpinned
//
// The weekly Stryker run on the saveOutline write path
// (.github/workflows/mutation-testing.yml) showed mutants that no test
// noticed: the delete flag check, duplicating into a page that already
// existed, nested pathauto slugs and slug clash numbering
// (HAXCMSSite.getUniqueSlugName), and updateNode / deleteNode, which every
// outline save goes through. Each test here pins one of those behaviors
// against a REAL site in a temp HAXCMS_ROOT, through the route where the
// route can reach it, and reads the result back from site.json and the page
// files on disk.
//
// Parity: haxcms-php carries the same scenarios, under the same names, in
// OperationsSaveOutlineBehaviorsTest.php. CommonJS, NO optional chaining,
// node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saveoutline-beh-"));
// HAXCMS reads HAXCMS_ROOT at require time; trailing slash is required
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const saveOutline = require("../../src/siteRoutes/v1/routes/saveOutline.js");

test.after(() => {
  fs.removeSync(testRoot);
});

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
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "saveoutline-beh-config-"),
  );
  const originalConfigDirectory = HAXCMS.configDirectory;
  HAXCMS.configDirectory = tmpDir;
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory;
    fs.removeSync(tmpDir);
  });
}

function makeReq(siteName, items) {
  return {
    headers: { "x-haxcms-site-token": "site-token-under-test" },
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: siteName,
    },
    body: { site: { name: siteName }, items: items },
  };
}

function siteDir(siteName) {
  return path.join(testRoot, "_sites", siteName);
}

function readItems(siteName) {
  return JSON.parse(
    fs.readFileSync(path.join(siteDir(siteName), "site.json"), "utf8"),
  ).items;
}

function byTitle(siteName, title) {
  return readItems(siteName).find((i) => i.title === title);
}

async function save(siteName, items) {
  const res = stubRes();
  await saveOutline(makeReq(siteName, items), res);
  return res;
}

function newPage(id, title, extra) {
  return Object.assign(
    {
      id: id,
      title: title,
      parent: null,
      indent: 0,
      order: 0,
      metadata: {},
      new: true,
    },
    extra || {},
  );
}

// the request an outline designer sends for an unchanged page
function sent(item, extra) {
  return Object.assign(
    {
      id: item.id,
      title: item.title,
      parent: item.parent,
      indent: item.indent,
      order: item.order,
      slug: item.slug,
      metadata: {},
    },
    extra || {},
  );
}

// a real, empty site (the boilerplate page createSite adds is removed) with
// the given site settings and the request auth stubbed to pass
async function buildSite(t, siteName, settings) {
  useTempConfigDirectory(t);
  assert.ok(await HAXCMS.createSite(siteName), "site is created");
  const site = await HAXCMS.loadSite(siteName);
  site.manifest.items = [];
  site.manifest.metadata.site.settings = Object.assign(
    {},
    site.manifest.metadata.site.settings || {},
    settings || {},
  );
  await site.manifest.save();
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
}

// pages A and B at the top level, each with its own content
async function buildTwoPageSite(t, siteName, settings) {
  await buildSite(t, siteName, settings);
  const res = await save(siteName, [
    newPage("a", "A", { contents: "<p>Content of A</p>" }),
    newPage("b", "B", { order: 1, contents: "<p>Content of B</p>" }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
}

// ---------------------------------------------------------------------------
// delete flag
// ---------------------------------------------------------------------------

test("delete: only delete === true removes a page; delete false keeps it", async (t) => {
  const siteName = "beh-delete-false";
  await buildTwoPageSite(t, siteName);
  const a = byTitle(siteName, "A");
  const b = byTitle(siteName, "B");
  const res = await save(siteName, [
    sent(a, { delete: false }),
    sent(b, { delete: "true" }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(
    readItems(siteName)
      .map((i) => i.title)
      .sort(),
    ["A", "B"],
    "neither false nor a non-boolean flag deletes",
  );
  const del = await save(siteName, [sent(a), sent(b, { delete: true })]);
  assert.equal(del.statusCode, 200, JSON.stringify(del.body));
  assert.deepEqual(
    readItems(siteName).map((i) => i.title),
    ["A"],
  );
  assert.equal(
    del.body.data.items.some((i) => i.id === b.id),
    false,
    "the response lists what site.json lists",
  );
});

test("delete: deleting a page and its new child in one request rescues nothing", async (t) => {
  const siteName = "beh-delete-new-child";
  await buildTwoPageSite(t, siteName);
  const a = byTitle(siteName, "A");
  const b = byTitle(siteName, "B");
  // a new page under B, created and deleted in the same request, together
  // with B itself
  const res = await save(siteName, [
    sent(a),
    sent(b, { delete: true }),
    newPage("client-child", "Child", {
      parent: b.id,
      indent: 1,
      delete: true,
    }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(
    readItems(siteName).map((i) => i.title),
    ["A"],
    "the new child is deleted through its idMap id, not rescued as an orphan",
  );
});

// ---------------------------------------------------------------------------
// duplicate
// ---------------------------------------------------------------------------

test("duplicate: duplicating into an existing page rewrites its content and alternate formats", async (t) => {
  const siteName = "beh-duplicate-existing";
  await buildTwoPageSite(t, siteName);
  const a = byTitle(siteName, "A");
  const b = byTitle(siteName, "B");
  const bFile = path.join(siteDir(siteName), b.location);
  const bMarkdown = bFile.replace(/\.html$/, ".md");
  assert.match(fs.readFileSync(bMarkdown, "utf8"), /Content of B/);
  const res = await save(siteName, [sent(a), sent(b, { duplicate: a.id })]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(fs.readFileSync(bFile, "utf8"), /Content of A/);
  const markdown = fs.readFileSync(bMarkdown, "utf8");
  assert.match(markdown, /Content of A/, "the markdown sidecar follows");
  assert.doesNotMatch(markdown, /Content of B/);
  // the source page is untouched
  assert.match(
    fs.readFileSync(path.join(siteDir(siteName), a.location), "utf8"),
    /Content of A/,
  );
});

test("duplicate: a new page can duplicate another new page by its client id", async (t) => {
  const siteName = "beh-duplicate-new";
  await buildSite(t, siteName);
  const res = await save(siteName, [
    newPage("src", "Source", { contents: "<p>Source body</p>" }),
    newPage("copy", "Copy", { order: 1, duplicate: "src" }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const copy = byTitle(siteName, "Copy");
  assert.equal(copy.id, res.body.data.idMap.copy);
  assert.match(
    fs.readFileSync(path.join(siteDir(siteName), copy.location), "utf8"),
    /Source body/,
  );
});

// ---------------------------------------------------------------------------
// slugs (HAXCMSSite.getUniqueSlugName through the route)
// ---------------------------------------------------------------------------

test("slugs: pathauto nests a page's slug under its ancestors' slugs", async (t) => {
  const siteName = "beh-pathauto-nested";
  await buildSite(t, siteName, { pathauto: true });
  const res = await save(siteName, [
    newPage("p", "Parent"),
    newPage("c", "Child", { parent: "p", indent: 1 }),
    newPage("g", "Grand Child", { parent: "c", indent: 2 }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(byTitle(siteName, "Parent").slug, "parent");
  assert.equal(byTitle(siteName, "Child").slug, "parent/child");
  assert.equal(
    byTitle(siteName, "Grand Child").slug,
    "parent/child/grand-child",
  );
});

test("slugs: pathauto off keeps a child's slug flat", async (t) => {
  const siteName = "beh-pathauto-off";
  await buildSite(t, siteName, { pathauto: false });
  const res = await save(siteName, [
    newPage("p", "Parent"),
    newPage("c", "Child", { parent: "p", indent: 1, slug: "child" }),
    newPage("d", "Derived", { parent: "p", indent: 1, order: 1 }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(byTitle(siteName, "Child").slug, "child");
  // a page sent without a slug gets one from its title; with pathauto off a
  // new page's derived slug still nests (normalizeOutlineSlug asks for it)
  assert.equal(byTitle(siteName, "Derived").slug, "parent/derived");
});

test("slugs: clashing slugs are numbered -1, -2 in request order", async (t) => {
  const siteName = "beh-slug-clash";
  await buildSite(t, siteName, { pathauto: true });
  const res = await save(siteName, [
    newPage("p", "Parent"),
    newPage("s1", "Same", { parent: "p", indent: 1, order: 0 }),
    newPage("s2", "Same", { parent: "p", indent: 1, order: 1 }),
    newPage("s3", "Same", { parent: "p", indent: 1, order: 2 }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const idMap = res.body.data.idMap;
  const slugOf = (clientId) =>
    readItems(siteName).find((i) => i.id === idMap[clientId]).slug;
  assert.equal(slugOf("s1"), "parent/same");
  assert.equal(slugOf("s2"), "parent/same-1");
  assert.equal(slugOf("s3"), "parent/same-2");
  // saving the same outline again keeps every page's own slug
  const again = await save(
    siteName,
    readItems(siteName).map((i) => sent(i)),
  );
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.equal(slugOf("s1"), "parent/same");
  assert.equal(slugOf("s2"), "parent/same-1");
  assert.equal(slugOf("s3"), "parent/same-2");
});

test("slugs: an ancestor with an empty slug adds no leading slash", async (t) => {
  const siteName = "beh-slug-empty-parent";
  await buildSite(t, siteName, { pathauto: true });
  const res = await save(siteName, [newPage("p", "Parent")]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // a legacy site.json can hold a page whose slug is empty
  const site = await HAXCMS.loadSite(siteName);
  const parent = site.manifest.items[0];
  parent.slug = "";
  await site.manifest.save(false);
  const child = await save(siteName, [
    newPage("c", "Child", { parent: parent.id, indent: 1 }),
  ]);
  assert.equal(child.statusCode, 200, JSON.stringify(child.body));
  assert.equal(byTitle(siteName, "Child").slug, "child");
});

test(
  "slugs: an ancestor with an empty slug adds no leading slash, even when the slug clashes",
  {
    todo:
      "getUniqueSlugName trims the leading '/' from the slug it checks but " +
      "numbers a clash from the untrimmed one, so the page gets '/child-1'. " +
      "Same in haxcms-php HAXCMSSite::getUniqueSlugName.",
  },
  async (t) => {
    const siteName = "beh-slug-empty-parent-clash";
    await buildSite(t, siteName, { pathauto: true });
    const res = await save(siteName, [
      newPage("p", "Parent"),
      newPage("o", "Child", { order: 1 }),
    ]);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const site = await HAXCMS.loadSite(siteName);
    const parent = site.manifest.items.find((i) => i.title === "Parent");
    parent.slug = "";
    await site.manifest.save(false);
    // "child" is taken by the top-level page
    const child = await save(siteName, [
      newPage("c", "Child", { parent: parent.id, indent: 1 }),
    ]);
    assert.equal(child.statusCode, 200, JSON.stringify(child.body));
    const created = readItems(siteName).find(
      (i) => i.id === child.body.data.idMap.c,
    );
    assert.equal(created.slug, "child-1");
  },
);

// ---------------------------------------------------------------------------
// the site methods every outline save goes through
// ---------------------------------------------------------------------------

test("site methods: updateNode writes site.json in the manifest's order by default", async (t) => {
  const siteName = "beh-update-node";
  await buildTwoPageSite(t, siteName);
  const site = await HAXCMS.loadSite(siteName);
  // the manifest lists B (order 1) before A (order 0)
  site.manifest.items.reverse();
  const b = site.manifest.items[0];
  b.title = "B renamed";
  const result = await site.updateNode(b);
  assert.equal(result, b, "returns the page it stored");
  assert.deepEqual(
    readItems(siteName).map((i) => i.title),
    ["B renamed", "A"],
    "persisted without re-sorting the outline",
  );
});

test("site methods: updateNode with persist false changes memory only", async (t) => {
  const siteName = "beh-update-node-memory";
  await buildTwoPageSite(t, siteName);
  const site = await HAXCMS.loadSite(siteName);
  const a = site.manifest.items.find((i) => i.title === "A");
  a.title = "A in memory";
  assert.equal(await site.updateNode(a, false), a);
  assert.equal(site.loadNode(a.id).title, "A in memory");
  assert.equal(byTitle(siteName, "A").id, a.id, "site.json is not written");
});

test("site methods: updateNode and deleteNode answer false for a page the site does not have", async (t) => {
  const siteName = "beh-unknown-node";
  await buildTwoPageSite(t, siteName);
  const site = await HAXCMS.loadSite(siteName);
  const before = fs.readFileSync(
    path.join(siteDir(siteName), "site.json"),
    "utf8",
  );
  const stranger = Object.assign({}, site.manifest.items[0], {
    id: "not-in-this-site",
  });
  assert.equal(await site.updateNode(stranger), false);
  assert.equal(await site.deleteNode(stranger), false);
  assert.equal(site.manifest.items.length, 2);
  assert.equal(
    fs.readFileSync(path.join(siteDir(siteName), "site.json"), "utf8"),
    before,
    "site.json untouched",
  );
});

test("site methods: deleteNode removes the page from site.json and answers true", async (t) => {
  const siteName = "beh-delete-node";
  await buildTwoPageSite(t, siteName);
  const res = await save(siteName, [
    sent(byTitle(siteName, "A")),
    sent(byTitle(siteName, "B")),
    newPage("c", "C", { order: 2 }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const site = await HAXCMS.loadSite(siteName);
  // the manifest lists C (order 2), B, A (order 0)
  site.manifest.items.reverse();
  const b = site.manifest.items.find((i) => i.title === "B");
  assert.equal(await site.deleteNode(b), true);
  assert.deepEqual(
    readItems(siteName).map((i) => i.title),
    ["C", "A"],
    "persisted without re-sorting the outline",
  );
});

// ---------------------------------------------------------------------------
// page file references (metadata.files)
// ---------------------------------------------------------------------------

test("files: a page saved without contents keeps the file references its content has", async (t) => {
  const siteName = "beh-files-kept";
  await buildSite(t, siteName);
  fs.writeFileSync(path.join(siteDir(siteName), "files", "photo.jpg"), "jpg");
  const res = await save(siteName, [
    newPage("a", "A", { contents: '<p><img src="files/photo.jpg"></p>' }),
    newPage("b", "B", { order: 1, contents: "<p>no files</p>" }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const a = byTitle(siteName, "A");
  assert.equal(a.metadata.files.length, 1, "the reference is tracked");
  const uuid = a.metadata.files[0];
  // a reorder sends no contents: the references are read from the page file
  const moved = await save(siteName, [
    sent(byTitle(siteName, "B"), { order: 0 }),
    sent(a, { order: 1 }),
  ]);
  assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
  assert.deepEqual(byTitle(siteName, "A").metadata.files, [uuid]);
  assert.deepEqual(byTitle(siteName, "B").metadata.files, []);
  // new contents replace the set
  const edited = await save(siteName, [
    sent(byTitle(siteName, "A"), { contents: "<p>image removed</p>" }),
  ]);
  assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
  assert.deepEqual(byTitle(siteName, "A").metadata.files, []);
});

test("alternate formats: a new page sent without contents still gets its sidecar files", async (t) => {
  const siteName = "beh-new-page-sidecars";
  await buildSite(t, siteName);
  const res = await save(siteName, [newPage("a", "A")]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const a = byTitle(siteName, "A");
  const markdown = path.join(
    siteDir(siteName),
    a.location.replace(/\.html$/, ".md"),
  );
  assert.ok(fs.existsSync(markdown), "the markdown sidecar is written");
  // rendered from the page file (the empty boilerplate page)
  assert.equal(fs.readFileSync(markdown, "utf8").trim(), "");
});

test("alternate formats: a save that sends no contents leaves an existing page's sidecar files alone", async (t) => {
  const siteName = "beh-sidecars-untouched";
  await buildTwoPageSite(t, siteName);
  const a = byTitle(siteName, "A");
  const markdown = path.join(
    siteDir(siteName),
    a.location.replace(/\.html$/, ".md"),
  );
  fs.writeFileSync(markdown, "marker");
  const res = await save(siteName, [
    sent(a, { title: "A renamed" }),
    sent(byTitle(siteName, "B")),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(fs.readFileSync(markdown, "utf8"), "marker");
});

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

test("contents: null or empty contents leave the page as it is", async (t) => {
  const siteName = "beh-contents-null";
  await buildTwoPageSite(t, siteName);
  const a = byTitle(siteName, "A");
  const b = byTitle(siteName, "B");
  const res = await save(siteName, [
    sent(a, { contents: null }),
    sent(b, { contents: "" }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(
    fs.readFileSync(path.join(siteDir(siteName), a.location), "utf8"),
    "<p>Content of A</p>",
  );
  assert.equal(
    fs.readFileSync(path.join(siteDir(siteName), b.location), "utf8"),
    "<p>Content of B</p>",
  );
});

// ---------------------------------------------------------------------------
// failure
// ---------------------------------------------------------------------------

test("failure: a crash on the first page writes nothing", async (t) => {
  const siteName = "beh-first-page-crash";
  await buildTwoPageSite(t, siteName, { pathauto: false });
  const a = byTitle(siteName, "A");
  const dir = siteDir(siteName);
  // A's page file is gone, so the save re-creates it from the boilerplate,
  // and that copy fails
  fs.removeSync(path.join(dir, path.dirname(a.location)));
  t.mock.method(HAXCMS, "recurseCopy", async () => {
    throw new Error("copy failed");
  });
  const siteJson = fs.readFileSync(path.join(dir, "site.json"), "utf8");
  const rss = fs.readFileSync(path.join(dir, "rss.xml"), "utf8");
  await assert.rejects(
    save(siteName, [
      sent(a, { title: "A renamed" }),
      sent(byTitle(siteName, "B")),
    ]),
    /copy failed/,
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "site.json"), "utf8"),
    siteJson,
    "site.json untouched",
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "rss.xml"), "utf8"),
    rss,
    "the feeds are not rebuilt",
  );
});

test("failure: a crash after the structure is saved keeps the new pages' folders", async (t) => {
  const siteName = "beh-late-crash";
  await buildTwoPageSite(t, siteName);
  const site = await HAXCMS.loadSite(siteName);
  t.mock.method(HAXCMS, "loadSite", async () => site);
  // the delete pass fails after the outline (with the new page) was written
  t.mock.method(site, "gitCommit", async (message) => {
    if (String(message).indexOf("Page deleted") === 0) {
      throw new Error("commit failed");
    }
    return true;
  });
  await assert.rejects(
    save(siteName, [
      sent(byTitle(siteName, "A")),
      sent(byTitle(siteName, "B"), { delete: true }),
      newPage("n", "New", { order: 2 }),
    ]),
    /commit failed/,
  );
  const created = byTitle(siteName, "New");
  assert.ok(created, "site.json lists the new page");
  assert.ok(
    fs.existsSync(path.join(siteDir(siteName), created.location)),
    "and its page folder is still there",
  );
});

// ---------------------------------------------------------------------------
// contents and delete, as the client sees them
// ---------------------------------------------------------------------------

test("contents: new contents on an existing page rewrite its sidecar files", async (t) => {
  const siteName = "beh-contents-sidecars";
  await buildTwoPageSite(t, siteName);
  const a = byTitle(siteName, "A");
  const res = await save(siteName, [
    sent(a, { contents: "<p>Rewritten body</p>" }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const markdown = path.join(
    siteDir(siteName),
    a.location.replace(/\.html$/, ".md"),
  );
  assert.match(fs.readFileSync(markdown, "utf8"), /Rewritten body/);
});

test("contents: contents that are not HTML are refused with a 400", async (t) => {
  const siteName = "beh-contents-not-html";
  await buildTwoPageSite(t, siteName);
  const a = byTitle(siteName, "A");
  const res = await save(siteName, [sent(a, { contents: "just text" })]);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    status: 400,
    data: { message: "invalid page contents" },
  });
  assert.equal(
    fs.readFileSync(path.join(siteDir(siteName), a.location), "utf8"),
    "<p>Content of A</p>",
  );
});

test("delete: a deleted page is committed as 'Page deleted: <title> (<id>)'", async (t) => {
  const siteName = "beh-delete-commit";
  await buildTwoPageSite(t, siteName);
  const site = await HAXCMS.loadSite(siteName);
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const commits = [];
  t.mock.method(site, "gitCommit", async (message) => {
    commits.push(message);
    return true;
  });
  const b = byTitle(siteName, "B");
  const res = await save(siteName, [
    sent(byTitle(siteName, "A")),
    sent(b, { delete: true }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(
    commits.indexOf("Page deleted: B (" + b.id + ")") !== -1,
    JSON.stringify(commits),
  );
});
