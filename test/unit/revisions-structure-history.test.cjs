"use strict";

// Page structure history (haxtheweb/issues#3191): outline saves only change
// site.json, so listItemRevisions now also reports the commits where the
// page's outline entry changed (move, rename, publish toggle) as
// kind "structure", with before/after values in `changes`.
//
// Builds a real git repo whose site.json and page file evolve, then runs
// listItemRevisions against it (HAXCMS.loadSite mocked, as in
// revisions-routes.test.cjs).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const { listItemRevisions } = require("../../src/siteRoutes/v1/revisions.js");
const {
  itemSnapshot,
  diffSnapshots,
  findStructureChanges,
  readBlobs,
} = require("../../src/lib/structureHistory.js");

function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test Author",
      "-c",
      "user.email=author@example.com",
    ].concat(args),
    { cwd: cwd, encoding: "utf8" },
  ).trim();
}

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
    send(value) {
      this.body = value;
      return this;
    },
  };
}

function makeReq(query) {
  return {
    headers: {},
    query: query || {},
    params: { idOrSlug: "photosynthesis" },
    body: {},
    originalUrl: "/_sites/demo/x/api/v1/items/photosynthesis/revisions",
  };
}

function unit(id, title, order) {
  return {
    id: id,
    title: title,
    slug: title.toLowerCase().replace(/ /g, "-"),
    parent: null,
    order: order,
    location: "pages/" + id + "/index.html",
    metadata: {},
  };
}

// site history, newest last:
//  1 site created: Unit 1, Unit 2, Photosynthesis (under Unit 1, unpublished)
//  2 content edit of Photosynthesis (page file)
//  3 outline: Photosynthesis moved to Unit 2 and to the top
//  4 outline: Unit 2 renamed (parent renamed, page not moved)
//  5 outline: another page renamed (nothing about Photosynthesis)
//  6 outline: Photosynthesis renamed + published
//  7 content edit + slug change in the same commit
async function makeSite(t) {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "revisions-structure-"),
  );
  const dir = path.join(tmpRoot, "demo");
  fs.ensureDirSync(path.join(dir, "pages", "item-p"));
  git(dir, "init", "--quiet");
  const items = {
    u1: unit("item-u1", "Unit 1 Cells", 0),
    u2: unit("item-u2", "Unit 2 Energy", 1),
    p: {
      id: "item-p",
      title: "Photosynthesis",
      slug: "photosynthesis",
      parent: "item-u1",
      order: 2,
      location: "pages/item-p/index.html",
      metadata: { published: false },
    },
  };
  const hashes = {};
  function commit(name, message) {
    fs.writeFileSync(
      path.join(dir, "site.json"),
      JSON.stringify(
        { title: "Demo", items: [items.u1, items.u2, items.p] },
        null,
        2,
      ),
    );
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "--allow-empty", "-m", message);
    hashes[name] = git(dir, "rev-parse", "HEAD");
  }
  const pageFile = path.join(dir, "pages", "item-p", "index.html");
  fs.writeFileSync(pageFile, "<p>one</p>\n");
  commit("created", "[S:siteCreate] A new journey begins: Demo (x)");
  fs.writeFileSync(pageFile, "<p>two</p>\n");
  commit(
    "edit1",
    "[H:updateItem:aaaa] Page details updated: Photosynthesis (item-p)",
  );
  items.p.parent = "item-u2";
  items.p.order = 0;
  commit("moved", "[H:updateSiteOutline:bbbb] Outline updated in bulk");
  items.u2.title = "Unit 2 Energy and Light";
  commit("parentRenamed", "[H:updateSiteOutline:cccc] Outline updated in bulk");
  items.u1.title = "Unit 1 Cells and Structure";
  commit("otherRenamed", "[H:updateSiteOutline:dddd] Outline updated in bulk");
  items.p.title = "Photosynthesis basics";
  items.p.metadata.published = true;
  commit(
    "renamedPublished",
    "[A:updateSiteOutline:eeee] Outline updated in bulk",
  );
  fs.writeFileSync(pageFile, "<p>three</p>\n");
  items.p.slug = "photosynthesis-basics";
  commit(
    "edit2",
    "[H:updateItem:ffff] Page details updated: Photosynthesis basics (item-p)",
  );

  const page = Object.assign({}, items.p, { slug: "photosynthesis" });
  const site = {
    siteDirectory: dir,
    name: "demo",
    hashes: hashes,
    manifest: {
      items: [page],
      metadata: { site: { name: "demo" } },
      async save() {},
    },
    loadNode(id) {
      return id === "item-p" ? page : null;
    },
    getPageAlternateLocation(location, extension) {
      return String(location).replace(/\.html?$/i, "." + extension);
    },
  };
  t.mock.method(HAXCMS, "loadSite", async () => site);
  t.after(() => fs.removeSync(tmpRoot));
  return site;
}

describe("listItemRevisions structure history", () => {
  test("lists content and structure commits for the page, newest first", async (t) => {
    const site = await makeSite(t);
    const res = stubRes();
    await listItemRevisions(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const rows = res.body.data.revisions;
    assert.deepEqual(
      rows.map((r) => r.hash),
      [
        site.hashes.edit2,
        site.hashes.renamedPublished,
        site.hashes.moved,
        site.hashes.edit1,
        site.hashes.created,
      ],
    );
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["content", "structure", "structure", "content", "content"],
    );
    assert.equal(res.body.data.total, 5);
    assert.equal(res.body.data.structureScanLimit, 300);
  });

  test("a move reports the parent by title (ids alongside) and the new position", async (t) => {
    const site = await makeSite(t);
    const res = stubRes();
    await listItemRevisions(makeReq(), res);
    const moved = res.body.data.revisions.find(
      (r) => r.hash === site.hashes.moved,
    );
    assert.deepEqual(moved.changes, [
      {
        field: "parent",
        from: "Unit 1 Cells",
        to: "Unit 2 Energy",
        fromId: "item-u1",
        toId: "item-u2",
      },
      { field: "order", from: "2", to: "0" },
    ]);
    assert.equal(moved.op, "updateSiteOutline");
    assert.equal(moved.actor, "H");
  });

  test("rename + publish in one outline save", async (t) => {
    const site = await makeSite(t);
    const res = stubRes();
    await listItemRevisions(makeReq(), res);
    const row = res.body.data.revisions.find(
      (r) => r.hash === site.hashes.renamedPublished,
    );
    assert.deepEqual(row.changes, [
      { field: "title", from: "Photosynthesis", to: "Photosynthesis basics" },
      { field: "published", from: "false", to: "true" },
    ]);
    assert.equal(row.actor, "A");
  });

  test("a renamed parent or another page changing is not this page changing", async (t) => {
    const site = await makeSite(t);
    const res = stubRes();
    await listItemRevisions(makeReq(), res);
    const hashes = res.body.data.revisions.map((r) => r.hash);
    assert.equal(hashes.indexOf(site.hashes.parentRenamed), -1);
    assert.equal(hashes.indexOf(site.hashes.otherRenamed), -1);
  });

  test("a content commit that also changed the outline entry stays content, with changes", async (t) => {
    const site = await makeSite(t);
    const res = stubRes();
    await listItemRevisions(makeReq(), res);
    const row = res.body.data.revisions[0];
    assert.equal(row.hash, site.hashes.edit2);
    assert.equal(row.kind, "content");
    assert.deepEqual(row.changes, [
      { field: "slug", from: "photosynthesis", to: "photosynthesis-basics" },
    ]);
    // content commits with no outline change carry an empty list
    const edit1 = res.body.data.revisions.find(
      (r) => r.hash === site.hashes.edit1,
    );
    assert.deepEqual(edit1.changes, []);
  });

  test("paging counts structure rows too", async (t) => {
    await makeSite(t);
    const res = stubRes();
    await listItemRevisions(
      makeReq({ "page.limit": "2", "page.offset": "1" }),
      res,
    );
    assert.equal(res.body.data.total, 5);
    assert.equal(res.body.data.count, 2);
    assert.deepEqual(
      res.body.data.revisions.map((r) => r.revisionNumber),
      [2, 3],
    );
    assert.deepEqual(
      res.body.data.revisions.map((r) => r.kind),
      ["structure", "structure"],
    );
  });
});

describe("structureHistory helpers", () => {
  test("itemSnapshot resolves the parent title and normalizes flags", () => {
    const manifest = {
      items: [
        unit("a", "Alpha", 0),
        {
          id: "b",
          title: "Beta",
          parent: "a",
          order: 1,
          metadata: { hideInMenu: true },
        },
      ],
    };
    assert.deepEqual(itemSnapshot(manifest, "b"), {
      title: "Beta",
      slug: "",
      parent: "Alpha",
      parentId: "a",
      order: "1",
      published: "false",
      hideInMenu: "true",
      locked: "false",
    });
    assert.equal(itemSnapshot(manifest, "missing"), null);
    assert.equal(itemSnapshot(null, "b"), null);
  });

  test("diffSnapshots ignores a missing side (page created or deleted)", () => {
    const snap = itemSnapshot({ items: [unit("a", "Alpha", 0)] }, "a");
    assert.deepEqual(diffSnapshots(null, snap), []);
    assert.deepEqual(diffSnapshots(snap, null), []);
    assert.deepEqual(diffSnapshots(snap, snap), []);
  });

  test("unreadable or invalid site.json versions are skipped, not fatal", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "structure-bad-"));
    t.after(() => fs.removeSync(dir));
    git(dir, "init", "--quiet");
    fs.writeFileSync(path.join(dir, "site.json"), "{ not json");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "broken");
    const bad = git(dir, "rev-parse", "HEAD");
    fs.writeFileSync(
      path.join(dir, "site.json"),
      JSON.stringify({ items: [unit("a", "Alpha", 0)] }),
    );
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "fixed");
    const good = git(dir, "rev-parse", "HEAD");
    assert.deepEqual(await findStructureChanges(dir, "a", [good, bad]), {});
    // a hash that does not exist reads as missing
    const blobs = await readBlobs(dir, [
      good + ":site.json",
      "0000000000000000000000000000000000000000:site.json",
    ]);
    assert.ok(blobs[0] && blobs[0].length > 0);
    assert.equal(blobs[1], null);
  });
});
