"use strict";

// Outline item ids are strings (haxtheweb/json-outline-schema: id is a
// string, parent an id or null). A hand-made site.json, skeleton or import
// may hold integer ids; they become strings when the site is loaded (and on
// every save), so saveOutline can require string ids. Ids are otherwise
// opaque: never trimmed. haxcms-php mirrors every test here
// (OutlineNumericIdsTest).
//
// CommonJS, no optional chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outline-numeric-"));
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const JSONOutlineSchema = require("../../src/lib/JSONOutlineSchema.js");
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

function makeReq(siteName, items) {
  return {
    headers: { "x-haxcms-site-token": "token" },
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: siteName,
    },
    body: { site: { name: siteName }, items: items },
  };
}

function siteJsonPath(siteName) {
  return path.join(testRoot, "_sites", siteName, "site.json");
}

function readSiteJson(siteName) {
  return fs.readFileSync(siteJsonPath(siteName), "utf8");
}

function pageFolders(siteName) {
  return fs
    .readdirSync(path.join(testRoot, "_sites", siteName, "pages"))
    .filter((dir) => dir.charAt(0) !== ".")
    .sort();
}

function useConfigDir(t) {
  const configDir = fs.mkdtempSync(path.join(testRoot, "config-"));
  const originalConfigDirectory = HAXCMS.configDirectory;
  HAXCMS.configDirectory = configDir;
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory;
  });
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
}

// a site whose site.json was written by hand: pages A (1), A1 (2, under 1),
// B (3), and C whose id is padded with spaces (" page-c "), each with its
// page folder; parents of the top level pages are null and ""
async function buildHandMadeSite(t, siteName) {
  useConfigDir(t);
  assert.ok(await HAXCMS.createSite(siteName), "site is created");
  const res = stubRes();
  await saveOutline(
    makeReq(siteName, [
      { id: "a", title: "A", parent: null, indent: 0, order: 0 },
      { id: "a1", title: "A1", parent: "a", indent: 1, order: 0 },
      { id: "b", title: "B", parent: null, indent: 0, order: 1 },
      { id: "c", title: "C", parent: null, indent: 0, order: 2 },
    ]),
    res,
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const json = JSON.parse(readSiteJson(siteName));
  const ids = { A: 1, A1: 2, B: 3, C: " page-c " };
  const serverIds = {};
  json.items.forEach((item) => {
    serverIds[item.title] = item.id;
  });
  json.items = json.items
    .filter((item) => typeof ids[item.title] !== "undefined")
    .map((item) => {
      const copy = Object.assign({}, item);
      copy.id = ids[item.title];
      if (item.title === "A1") {
        copy.parent = 1;
      } else if (item.title === "B") {
        copy.parent = "";
      } else {
        copy.parent = null;
      }
      return copy;
    });
  fs.writeFileSync(siteJsonPath(siteName), JSON.stringify(json, null, 2));
  // only the four pages' folders remain
  const keep = json.items.map((item) => String(item.location).split("/")[1]);
  pageFolders(siteName).forEach((dir) => {
    if (keep.indexOf(dir) === -1) {
      fs.removeSync(path.join(testRoot, "_sites", siteName, "pages", dir));
    }
  });
  return serverIds;
}

test("normalizeOutlineId turns integers into strings and leaves the rest", () => {
  assert.equal(JSONOutlineSchema.normalizeOutlineId(7), "7");
  assert.equal(JSONOutlineSchema.normalizeOutlineId(0), "0");
  assert.equal(JSONOutlineSchema.normalizeOutlineId(-0), "0");
  assert.equal(JSONOutlineSchema.normalizeOutlineId(-12), "-12");
  assert.equal(
    JSONOutlineSchema.normalizeOutlineId(9007199254740991),
    "9007199254740991",
  );
  [
    null,
    undefined,
    "",
    "7",
    " 7 ",
    "item-1",
    1.5,
    9007199254740992,
    NaN,
    Infinity,
    true,
  ].forEach((value) => {
    assert.equal(JSONOutlineSchema.normalizeOutlineId(value), value);
  });
});

test("loading a site.json with numeric ids and parents gives string ids", async (t) => {
  await buildHandMadeSite(t, "numeric-load");
  const site = await HAXCMS.loadSite("numeric-load");
  const items = {};
  site.manifest.items.forEach((item) => {
    items[item.title] = item;
  });
  assert.equal(items.A.id, "1");
  assert.equal(items.A1.id, "2");
  assert.equal(items.A1.parent, "1");
  assert.equal(items.B.id, "3");
  // null and "" parents are left as they were
  assert.equal(items.A.parent, null);
  assert.equal(items.B.parent, "");
  // a padded string id is kept exactly
  assert.equal(items.C.id, " page-c ");
  // lookups by the string id work
  assert.equal(site.loadNode("2").title, "A1");
  assert.equal(site.manifest.getItemById("1").title, "A");
  assert.equal(
    site.manifest
      .findBranch("1")
      .map((item) => item.title)
      .join(","),
    "A,A1",
  );
});

test("a full save of a site loaded with numeric ids succeeds and writes strings", async (t) => {
  await buildHandMadeSite(t, "numeric-save");
  const foldersBefore = pageFolders("numeric-save");
  const site = await HAXCMS.loadSite("numeric-save");
  t.mock.method(HAXCMS, "loadSite", async () => site);
  // what the editor sends back: the items it was given, over JSON
  const sent = JSON.parse(JSON.stringify(site.manifest.items)).map((item) => {
    if (item.title === "B") {
      item.title = "B renamed";
    }
    return item;
  });
  const res = stubRes();
  await saveOutline(makeReq("numeric-save", sent), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // no page was treated as new
  assert.deepEqual(Object.keys(res.body.data.idMap), []);
  assert.deepEqual(pageFolders("numeric-save"), foldersBefore);
  const saved = JSON.parse(readSiteJson("numeric-save")).items;
  assert.equal(saved.length, 4);
  const byTitle = {};
  saved.forEach((item) => {
    byTitle[item.title] = item;
  });
  assert.equal(byTitle.A.id, "1");
  assert.equal(byTitle.A1.id, "2");
  assert.equal(byTitle.A1.parent, "1");
  assert.equal(byTitle["B renamed"].id, "3");
  assert.equal(byTitle["B renamed"].parent, null);
  assert.equal(byTitle.C.id, " page-c ");
  saved.forEach((item) => {
    assert.equal(typeof item.id, "string", item.title);
  });
});

test("any other site.json write also writes string ids", async (t) => {
  await buildHandMadeSite(t, "numeric-other-write");
  const site = await HAXCMS.loadSite("numeric-other-write");
  // an id that bypassed load (an in-memory change) is still saved as a string
  site.manifest.items[0].parent = 2;
  site.manifest.items[0].id = 10;
  await site.manifest.save(false);
  const saved = JSON.parse(readSiteJson("numeric-other-write")).items;
  assert.equal(saved[0].id, "10");
  assert.equal(saved[0].parent, "2");
});

test("a numeric id in a saveOutline request is a 400 and nothing is written", async (t) => {
  await buildHandMadeSite(t, "numeric-request");
  const site = await HAXCMS.loadSite("numeric-request");
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const before = readSiteJson("numeric-request");
  const foldersBefore = pageFolders("numeric-request");
  // an existing page's id as a number, and a new page with a number
  for (const id of [1, 99, 0]) {
    const res = stubRes();
    await saveOutline(
      makeReq("numeric-request", [
        { id: "3", title: "B renamed", parent: null, indent: 0, order: 1 },
        { id: id, title: "Numeric", parent: null, indent: 0, order: 0 },
      ]),
      res,
    );
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(res.body.data.message, "Each outline item requires an id");
    assert.equal(readSiteJson("numeric-request"), before);
    assert.deepEqual(pageFolders("numeric-request"), foldersBefore);
  }
});

test("a padded existing id round-trips without creating a new page", async (t) => {
  await buildHandMadeSite(t, "padded-id");
  const site = await HAXCMS.loadSite("padded-id");
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const foldersBefore = pageFolders("padded-id");
  const res = stubRes();
  await saveOutline(
    makeReq("padded-id", [
      { id: " page-c ", title: "C renamed", parent: null, indent: 0, order: 2 },
    ]),
    res,
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body.data.idMap), []);
  assert.deepEqual(pageFolders("padded-id"), foldersBefore);
  const saved = JSON.parse(readSiteJson("padded-id")).items;
  assert.equal(saved.length, 4);
  const c = saved.find((item) => item.id === " page-c ");
  assert.ok(c, "the page keeps its id exactly");
  assert.equal(c.title, "C renamed");
});

test('ids are opaque: " 3 " and "03" are not page 3', async (t) => {
  await buildHandMadeSite(t, "opaque-id");
  for (const id of [" 3 ", "03"]) {
    const site = await HAXCMS.loadSite("opaque-id");
    t.mock.method(HAXCMS, "loadSite", async () => site);
    const res = stubRes();
    await saveOutline(
      makeReq("opaque-id", [
        { id: id, title: "Not B", parent: null, indent: 0, order: 5 },
      ]),
      res,
    );
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    // a new page, mapped from the id that was sent
    assert.deepEqual(Object.keys(res.body.data.idMap), [id]);
    const saved = JSON.parse(readSiteJson("opaque-id")).items;
    const b = saved.find((item) => item.id === "3");
    assert.equal(b.title, "B", "page 3 is unchanged");
    t.mock.restoreAll();
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
  }
  assert.equal(JSON.parse(readSiteJson("opaque-id")).items.length, 6);
});

test("a blank id is a 400 and nothing is written", async (t) => {
  await buildHandMadeSite(t, "blank-id");
  const site = await HAXCMS.loadSite("blank-id");
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const before = readSiteJson("blank-id");
  for (const id of ["", "   ", "\t\n", " ", "﻿　"]) {
    const res = stubRes();
    await saveOutline(
      makeReq("blank-id", [
        { id: id, title: "Blank", parent: null, indent: 0, order: 0 },
      ]),
      res,
    );
    assert.equal(res.statusCode, 400, JSON.stringify(id));
    assert.equal(res.body.data.message, "Each outline item requires an id");
    assert.equal(readSiteJson("blank-id"), before);
  }
});

test("a skeleton / import with numeric ids keeps its parents as strings", async (t) => {
  useConfigDir(t);
  const site = await HAXCMS.createSite("numeric-import", null, null, {
    structure: "from-skeleton",
    items: [
      { id: 0, title: "Zero", parent: null, order: 0, indent: 0 },
      { id: 1, title: "One", parent: null, order: 1, indent: 0 },
      { id: 2, title: "Two", parent: 1, order: 0, indent: 1 },
      { id: 3, title: "Three", parent: 0, order: 0, indent: 1 },
    ],
  });
  assert.ok(site, "site is created");
  const saved = JSON.parse(readSiteJson("numeric-import")).items;
  const byTitle = {};
  saved.forEach((item) => {
    byTitle[item.title] = item;
  });
  assert.equal(byTitle.Zero.id, "0");
  assert.equal(byTitle.One.id, "1");
  assert.equal(byTitle.Two.id, "2");
  assert.equal(byTitle.Two.parent, "1");
  assert.equal(byTitle.Three.parent, "0");
  saved.forEach((item) => {
    assert.equal(typeof item.id, "string", item.title);
  });
});
