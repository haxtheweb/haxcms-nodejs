"use strict";

// Page history (haxtheweb/issues#3191): compareItemRevisions returns both
// contents and the page detail fields that differ between two revisions,
// and restoreItemRevision takes an optional note that is added to the
// commit summary (cleaned and capped; the commit line keeps its 200
// character limit).
//
// Builds a real git repo (page file + .json variant), HAXCMS.loadSite mocked
// as in revisions-structure-history.test.cjs.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const {
  compareItemRevisions,
  restoreItemRevision,
  normalizeRestoreNote,
  diffRevisionItemMetadata,
} = require("../../src/siteRoutes/v1/revisions.js");
const { SiteRoutesMap } = require("../../src/lib/SiteRoutesMap.js");

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

async function makeSite(t) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revisions-compare-"));
  const dir = path.join(tmpRoot, "demo");
  fs.ensureDirSync(path.join(dir, "pages", "item-p"));
  git(dir, "init", "--quiet");
  const pageFile = path.join(dir, "pages", "item-p", "index.html");
  const jsonFile = path.join(dir, "pages", "item-p", "index.json");
  const hashes = {};
  function commit(name, html, meta, message) {
    fs.writeFileSync(pageFile, html);
    fs.writeFileSync(jsonFile, JSON.stringify(meta));
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", message);
    hashes[name] = git(dir, "rev-parse", "HEAD");
  }
  commit(
    "one",
    "<p>The quick fox</p>\n",
    { id: "item-p", title: "Welcome", metadata: { published: false } },
    "[H:createItem:aaaa] Page added: Welcome (item-p)",
  );
  commit(
    "two",
    "<p>The slow fox</p>\n",
    { id: "item-p", title: "Intro", description: "Start here", metadata: {} },
    "[H:updateContentByIdOrSlug:bbbb] Committed changes",
  );
  const commits = [];
  const page = {
    id: "item-p",
    title: "Intro",
    slug: "intro",
    location: "pages/item-p/index.html",
    metadata: {},
    async writeLocation(content) {
      fs.writeFileSync(pageFile, content);
      return content.length;
    },
  };
  const site = {
    siteDirectory: dir,
    name: "demo",
    hashes: hashes,
    commits: commits,
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
    async writePageAlternateFormats() {},
    async gitCommit(message) {
      commits.push(message);
    },
  };
  t.mock.method(HAXCMS, "loadSite", async () => site);
  t.after(() => fs.removeSync(tmpRoot));
  return site;
}

function compareReq(a, b) {
  return {
    headers: {},
    query: {},
    params: { idOrSlug: "intro", revisionId: a, compareRevisionId: b },
    body: {},
    originalUrl:
      "/_sites/demo/x/api/v1/items/intro/revisions/" + a + "/compare/" + b,
  };
}

describe("compareItemRevisions", () => {
  test("is registered as GET .../revisions/:revisionId/compare/:compareRevisionId", () => {
    const routes = SiteRoutesMap.get || SiteRoutesMap.GET || {};
    const keys = Object.keys(routes);
    assert.ok(
      keys.indexOf(
        "v1/items/:idOrSlug/revisions/:revisionId/compare/:compareRevisionId",
      ) !== -1,
      "compare route registered",
    );
  });

  test("returns both contents and the page details that differ", async (t) => {
    const site = await makeSite(t);
    const res = stubRes();
    await compareItemRevisions(
      compareReq(site.hashes.one, site.hashes.two),
      res,
    );
    assert.equal(res.statusCode, 200);
    const data = res.body.data;
    assert.equal(data.nodeId, "item-p");
    assert.equal(data.from.revision.hash, site.hashes.one);
    assert.equal(data.to.revision.hash, site.hashes.two);
    assert.equal(data.from.content, "<p>The quick fox</p>\n");
    assert.equal(data.to.content, "<p>The slow fox</p>\n");
    assert.equal(data.to.revision.op, "updateContentByIdOrSlug");
    assert.equal(data.contentChanged, true);
    assert.equal(data.from.hasItemMetadata, true);
    assert.deepEqual(data.itemMetadataChanges, [
      { field: "title", from: "Welcome", to: "Intro" },
      { field: "description", from: "", to: "Start here" },
      { field: "published", from: "false", to: "true" },
    ]);
    assert.ok(data.links.self.indexOf("/compare/") !== -1);
  });

  test("rejects a bad hash and reports a missing revision", async (t) => {
    const site = await makeSite(t);
    let res = stubRes();
    await compareItemRevisions(compareReq(site.hashes.one, "zz;rm"), res);
    assert.equal(res.statusCode, 400);
    res = stubRes();
    await compareItemRevisions(
      compareReq(site.hashes.one, "abcdef1234567"),
      res,
    );
    assert.equal(res.statusCode, 404);
  });

  test("diffRevisionItemMetadata needs both sides", () => {
    assert.deepEqual(diffRevisionItemMetadata(null, { title: "x" }), []);
    assert.deepEqual(
      diffRevisionItemMetadata(
        { metadata: { locked: true } },
        { metadata: {} },
      ),
      [{ field: "locked", from: "true", to: "false" }],
    );
  });
});

describe("restoreItemRevision note", () => {
  test("normalizeRestoreNote cleans and caps the note", () => {
    assert.equal(
      normalizeRestoreNote("  put\tback\nthe   intro "),
      "put back the intro",
    );
    assert.equal(normalizeRestoreNote("a\u0007b"), "ab");
    assert.equal(normalizeRestoreNote(42), "");
    assert.equal(normalizeRestoreNote("x".repeat(300)).length, 120);
  });

  test("the note is added to the restore commit and returned", async (t) => {
    const site = await makeSite(t);
    const res = stubRes();
    await restoreItemRevision(
      {
        headers: {},
        query: {},
        params: { idOrSlug: "intro", revisionId: site.hashes.one },
        body: { note: "  back to the\nfirst draft " },
        originalUrl: "/_sites/demo/x/api/v1/items/intro/revisions/x/restore",
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.note, "back to the first draft");
    assert.equal(site.commits.length, 1);
    assert.match(
      site.commits[0],
      /^Page revision restored: .+ \(item-p\) from [0-9a-f]{12}: back to the first draft$/,
    );
  });

  test("without a note the commit is unchanged", async (t) => {
    const site = await makeSite(t);
    const res = stubRes();
    await restoreItemRevision(
      {
        headers: {},
        query: {},
        params: { idOrSlug: "intro", revisionId: site.hashes.one },
        body: {},
        originalUrl: "/_sites/demo/x/api/v1/items/intro/revisions/x/restore",
      },
      res,
    );
    assert.equal(res.body.data.note, "");
    assert.match(site.commits[0], /from [0-9a-f]{12}$/);
  });
});
