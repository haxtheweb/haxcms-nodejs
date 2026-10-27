"use strict";

// saveOutline failures (haxtheweb/issues#3114). Saving per item used to
// write site.json after every page, so whatever failed part-way through a
// request, the outline as far as it got was already saved. Batching the
// writes must not change that:
//   - a crash or rejection in the content or delete phase leaves the whole
//     new structure saved (it is written once, as a checkpoint, after the
//     structure pass)
//   - a crash during the structure pass leaves the pages before it saved
// and siblings that share an order keep the order the request sent them in,
// so where a page lands never depends on how the save ran.
//
// Runs the REAL saveOutline route against a REAL site, as
// save-outline-batching.test.cjs does. CommonJS, globalThis, no optional
// chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saveoutline-fail-"));
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS, HAXCMSSite } = require("../../src/lib/HAXCMS.js");
const JSONOutlineSchemaItem = require("../../src/lib/JSONOutlineSchemaItem.js");
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
    path.join(os.tmpdir(), "saveoutline-fail-config-"),
  );
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
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: siteName,
    },
    body: { site: { name: siteName }, items: items },
  };
}

// a site with pages A, B, C at the top level and A1, A2 under A
async function buildSite(t, siteName) {
  useTempConfigDirectory(t);
  mockAuth(t);
  assert.ok(await HAXCMS.createSite(siteName), "site is created");
  const res = stubRes();
  const page = (id, title, parent, order, indent) => ({
    id: id,
    title: title,
    parent: parent,
    indent: indent,
    order: order,
    metadata: {},
    contents: "<p>" + title + "</p>",
    new: true,
  });
  await saveOutline(
    makeReq(siteName, [
      page("a", "A", null, 0, 0),
      page("a1", "A1", "a", 0, 1),
      page("a2", "A2", "a", 1, 1),
      page("b", "B", null, 1, 0),
      page("c", "C", null, 2, 0),
    ]),
    res,
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // drop the boilerplate page createSite adds, so only A..C remain
  const site = await HAXCMS.loadSite(siteName);
  const keep = ["A", "A1", "A2", "B", "C"];
  site.manifest.items = site.manifest.items.filter(
    (i) => keep.indexOf(i.title) !== -1,
  );
  await site.manifest.save();
  return site;
}

const byTitle = (site, title) =>
  site.manifest.items.find((i) => i.title === title);

// an edit: every page renamed, C moved first, a new page D after B and a
// new page E under it, A2 gets new contents
function editRequest(site) {
  const sent = (title, extra) =>
    Object.assign(
      {
        id: byTitle(site, title).id,
        title: title + " edited",
        parent: byTitle(site, title).parent,
        indent: byTitle(site, title).indent,
        order: byTitle(site, title).order,
        metadata: {},
      },
      extra || {},
    );
  return [
    sent("C", { order: 0 }),
    sent("A", { order: 1 }),
    sent("A1"),
    sent("A2", { contents: "<p>A2 new contents</p>" }),
    sent("B", { order: 2 }),
    {
      id: "client-d",
      title: "D",
      parent: null,
      indent: 0,
      order: 3,
      metadata: {},
      contents: "<p>D</p>",
      new: true,
    },
    {
      id: "client-e",
      title: "E",
      parent: "client-d",
      indent: 1,
      order: 0,
      metadata: {},
      contents: "<p>E</p>",
      new: true,
    },
  ];
}

// the outline in site.json on disk, as "title<parent" in tree order
function savedTree(siteName) {
  const file = path.join(testRoot, "_sites", siteName, "site.json");
  const items = JSON.parse(fs.readFileSync(file, "utf8")).items;
  const title = (id) => {
    const found = items.find((i) => i.id === id);
    return found ? found.title : "root";
  };
  const out = [];
  const walk = (parent) =>
    items
      .map((item, position) => ({ item, position }))
      .filter((x) => (x.item.parent || null) === parent)
      .sort((x, y) => x.item.order - y.item.order || x.position - y.position)
      .forEach((x) => {
        out.push(x.item.title + "<" + title(x.item.parent));
        walk(x.item.id);
      });
  walk(null);
  return out;
}

const EDITED = [
  "C edited<root",
  "A edited<root",
  "A1 edited<A edited",
  "A2 edited<A edited",
  "B edited<root",
  "D<root",
  "E<D",
];

async function run(t, site, items) {
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const res = stubRes();
  let thrown = null;
  try {
    await saveOutline(makeReq(site.manifest.metadata.site.name, items), res);
  } catch (e) {
    thrown = e;
  }
  return { res, thrown };
}

test("a saved edit lands as sent", async (t) => {
  const site = await buildSite(t, "fail-ok");
  const { res, thrown } = await run(t, site, editRequest(site));
  assert.equal(thrown, null);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(savedTree("fail-ok"), EDITED);
});

test("a crash writing page contents still leaves the new structure saved", async (t) => {
  const site = await buildSite(t, "fail-content-crash");
  let writes = 0;
  const write = JSONOutlineSchemaItem.prototype.writeLocation;
  t.mock.method(
    JSONOutlineSchemaItem.prototype,
    "writeLocation",
    async function (...args) {
      writes++;
      if (writes === 2) {
        throw new Error("disk failure");
      }
      return write.apply(this, args);
    },
  );
  const { thrown } = await run(t, site, editRequest(site));
  assert.ok(thrown, "the failure is reported");
  assert.deepEqual(savedTree("fail-content-crash"), EDITED);
});

test("a rejected page in the content phase still leaves the new structure saved", async (t) => {
  const site = await buildSite(t, "fail-content-400");
  const items = editRequest(site);
  items[4].contents = "just text, no markup";
  const { res, thrown } = await run(t, site, items);
  assert.equal(thrown, null);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(savedTree("fail-content-400"), EDITED);
});

test("a crash while deleting still leaves the new structure saved", async (t) => {
  const site = await buildSite(t, "fail-delete-crash");
  const items = editRequest(site);
  items[4].delete = true;
  t.mock.method(HAXCMSSite.prototype, "deleteNode", async () => {
    throw new Error("disk failure");
  });
  const { thrown } = await run(t, site, items);
  assert.ok(thrown, "the failure is reported");
  assert.deepEqual(savedTree("fail-delete-crash"), EDITED);
});

test("a crash in the structure pass leaves the pages before it saved", async (t) => {
  const site = await buildSite(t, "fail-structure-crash");
  // E is the second new page: creating its folder fails
  let copies = 0;
  const copy = HAXCMS.recurseCopy.bind(HAXCMS);
  t.mock.method(HAXCMS, "recurseCopy", async (...args) => {
    copies++;
    if (copies === 2) {
      throw new Error("disk failure");
    }
    return copy(...args);
  });
  const { thrown } = await run(t, site, editRequest(site));
  assert.ok(thrown, "the failure is reported");
  const tree = savedTree("fail-structure-crash");
  // every page before E was saved as sent; E was not
  assert.ok(tree.indexOf("D<root") !== -1, JSON.stringify(tree));
  assert.ok(tree.indexOf("B edited<root") !== -1, JSON.stringify(tree));
  assert.ok(tree.indexOf("A2 edited<A edited") !== -1, JSON.stringify(tree));
  assert.equal(
    tree.some((x) => x.indexOf("E<") === 0),
    false,
  );
});

test("siblings that share an order keep the order they were sent in", async (t) => {
  const site = await buildSite(t, "fail-ties");
  // B and C both at order 1, sent C first, then B; A1 and A2 both at 0,
  // sent A2 first
  const items = [
    {
      id: byTitle(site, "A").id,
      title: "A",
      parent: null,
      indent: 0,
      order: 0,
      metadata: {},
    },
    {
      id: byTitle(site, "A2").id,
      title: "A2",
      parent: byTitle(site, "A").id,
      indent: 1,
      order: 0,
      metadata: {},
    },
    {
      id: byTitle(site, "A1").id,
      title: "A1",
      parent: byTitle(site, "A").id,
      indent: 1,
      order: 0,
      metadata: {},
    },
    {
      id: byTitle(site, "C").id,
      title: "C",
      parent: null,
      indent: 0,
      order: 1,
      metadata: {},
    },
    {
      id: byTitle(site, "B").id,
      title: "B",
      parent: null,
      indent: 0,
      order: 1,
      metadata: {},
    },
  ];
  const { res } = await run(t, site, items);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(savedTree("fail-ties"), [
    "A<root",
    "A2<A",
    "A1<A",
    "C<root",
    "B<root",
  ]);
});
