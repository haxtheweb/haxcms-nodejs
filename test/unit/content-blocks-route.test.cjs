"use strict";

// Direct handler tests for src/siteRoutes/v1/contentBlocks.js
// (GET/PATCH x/api/v1/content/{idOrSlug}/blocks, haxtheweb/issues#3270):
// listing, a successful patch writes the page file and commits once,
// locked pages (423), stale blocks (409), refusals (400) write nothing, and
// metadata image URLs follow a changed src.
//
// Site resolution runs through the real resolveSiteForRequest with
// HAXCMS.loadSite mocked to a site whose page lives in a temp directory.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const FileContentScanner = require("../../src/lib/FileContentScanner.js");
const routes = require("../../src/siteRoutes/v1/contentBlocks.js");

const PAGE =
  '<p>Intro</p><img src="files/a.png"><media-image source="https://media.aanda.psu.edu/m.jpg"></media-image>';

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
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
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    type() {
      return this;
    },
  };
}

function makeReq(params, body, query) {
  return {
    method: body ? "PATCH" : "GET",
    headers: { "x-haxcms-site-token": "token", accept: "application/json" },
    query: query || {},
    params: params,
    body: body || {},
    originalUrl: `/_sites/demo/x/api/v1/content/${params.idOrSlug}/blocks`,
    haxcmsSiteApiAuth: {
      authenticated: true,
      userName: "tester",
      siteName: "demo",
    },
  };
}

function makeSite(t, options) {
  const o = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-blocks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "pages", "item-1"), { recursive: true });
  const file = path.join(dir, "pages", "item-1", "index.html");
  fs.writeFileSync(file, PAGE);
  const page = {
    id: "item-1",
    title: "One",
    slug: "one",
    location: "pages/item-1/index.html",
    metadata: {
      locked: !!o.locked,
      images: ["https://media.aanda.psu.edu/m.jpg", "files/other.png"],
      videos: [],
    },
    async writeLocation(body) {
      fs.writeFileSync(file, body);
      return true;
    },
  };
  const commits = [];
  const site = {
    siteDirectory: dir,
    name: "demo",
    manifest: {
      items: [page],
      metadata: { site: { name: "demo", updated: 0 }, theme: {} },
      async save() {
        return true;
      },
    },
    loadNode(id) {
      return id === "item-1" || id === "one" ? page : null;
    },
    async getPageContent() {
      return fs.readFileSync(file, "utf8");
    },
    async updateNode() {
      return page;
    },
    async writePageAlternateFormats() {
      return true;
    },
    async gitCommit(message) {
      commits.push(message);
    },
  };
  t.mock.method(HAXCMS, "loadSite", async () => site);
  t.mock.method(FileContentScanner, "rebuildPageFilesUuids", async () => true);
  return { site, page, file, commits };
}

function data(res) {
  return res.body && res.body.data ? res.body.data : res.body;
}

describe("GET x/api/v1/content/{idOrSlug}/blocks", () => {
  test("lists allowlisted blocks, optionally by tag", async (t) => {
    makeSite(t);
    const res = stubRes();
    await routes.listContentBlocks(makeReq({ idOrSlug: "one" }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      data(res).blocks.map((b) => b.tag),
      ["img", "media-image"],
    );
    const only = stubRes();
    await routes.listContentBlocks(
      makeReq({ idOrSlug: "one" }, null, { tag: "img" }),
      only,
    );
    assert.deepEqual(
      data(only).blocks.map((b) => b.tag),
      ["img"],
    );
  });

  test("404 for an unknown page", async (t) => {
    makeSite(t);
    const res = stubRes();
    await routes.listContentBlocks(makeReq({ idOrSlug: "nope" }), res);
    assert.equal(res.statusCode, 404);
  });
});

describe("PATCH x/api/v1/content/{idOrSlug}/blocks", () => {
  test("a site's block change budget: 429 over it, refused changes cost nothing", async (t) => {
    const { file, commits } = makeSite(t);
    t.mock.method(HAXCMS, "getBlockOperationsRateLimitSettings", () => ({
      enabled: true,
      windowMs: 60000,
      max: 2,
    }));
    const patch = async (before, alt) => {
      const res = stubRes();
      await routes.updateContentBlocks(
        makeReq(
          { idOrSlug: "one" },
          {
            ops: [
              {
                op: "setAttributes",
                tag: "img",
                index: 0,
                before: before,
                set: { alt: alt },
              },
            ],
          },
        ),
        res,
      );
      return res;
    };
    // a stale change is refused before the budget is charged
    assert.equal(
      (await patch('<img src="files/zzz.png">', "x")).statusCode,
      409,
    );
    const first = await patch('<img src="files/a.png">', "one");
    assert.equal(first.statusCode, 200);
    const second = await patch('<img alt="one" src="files/a.png">', "two");
    assert.equal(second.statusCode, 200);
    const third = await patch('<img alt="two" src="files/a.png">', "three");
    assert.equal(third.statusCode, 429);
    assert.equal(data(third).reason, "rate-limited");
    assert.match(
      data(third).message,
      /^Block change limit reached: 2 changes per 60 seconds for this site\. You can retry in \d+ seconds\.$/,
    );
    assert.ok(Number(third.headers["Retry-After"]) >= 1);
    assert.equal(commits.length, 2);
    assert.match(fs.readFileSync(file, "utf8"), /alt="two"/);
  });

  test("writes the change, commits once, returns the new block source", async (t) => {
    const { file, commits, page } = makeSite(t);
    const res = stubRes();
    await routes.updateContentBlocks(
      makeReq(
        { idOrSlug: "one" },
        {
          ops: [
            {
              op: "setAttributes",
              tag: "img",
              index: 0,
              before: '<img src="files/a.png">',
              set: { alt: "A cat" },
            },
            {
              op: "setAttributes",
              tag: "media-image",
              index: 0,
              before:
                '<media-image source="https://media.aanda.psu.edu/m.jpg"></media-image>',
              set: { source: "https://media.psu.edu/m.jpg", alt: "A dog" },
            },
          ],
          note: "Reports: <b>alt</b> text",
        },
      ),
      res,
    );
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(
      fs.readFileSync(file, "utf8"),
      '<p>Intro</p><img alt="A cat" src="files/a.png"><media-image alt="A dog" source="https://media.psu.edu/m.jpg"></media-image>',
    );
    assert.equal(commits.length, 1);
    assert.equal(
      commits[0],
      "Block operations: alt on 1 img, alt+source on 1 media-image on One (item-1): Reports: balt/b text",
    );
    assert.deepEqual(
      data(res).results.map((r) => r.before),
      [
        '<img alt="A cat" src="files/a.png">',
        '<media-image alt="A dog" source="https://media.psu.edu/m.jpg"></media-image>',
      ],
    );
    // the page's image list follows the moved media URL
    assert.deepEqual(page.metadata.images, [
      "https://media.psu.edu/m.jpg",
      "files/other.png",
    ]);
    assert.ok(page.metadata.updated > 0);
  });

  test("423 for a locked page, nothing written", async (t) => {
    const { file, commits } = makeSite(t, { locked: true });
    const res = stubRes();
    await routes.updateContentBlocks(
      makeReq(
        { idOrSlug: "one" },
        {
          ops: [
            {
              op: "setAttributes",
              tag: "img",
              index: 0,
              before: '<img src="files/a.png">',
              set: { alt: "x" },
            },
          ],
        },
      ),
      res,
    );
    assert.equal(res.statusCode, 423);
    assert.equal(res.body.data.reason, "locked");
    assert.equal(fs.readFileSync(file, "utf8"), PAGE);
    assert.equal(commits.length, 0);
  });

  test("409 when the block changed since it was read, nothing written", async (t) => {
    const { file, commits } = makeSite(t);
    const res = stubRes();
    await routes.updateContentBlocks(
      makeReq(
        { idOrSlug: "one" },
        {
          ops: [
            {
              op: "setAttributes",
              tag: "img",
              index: 0,
              before: '<img src="files/b.png">',
              set: { alt: "x" },
            },
          ],
        },
      ),
      res,
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.data.reason, "stale");
    assert.equal(res.body.data.op, 0);
    assert.equal(fs.readFileSync(file, "utf8"), PAGE);
    assert.equal(commits.length, 0);
  });

  test("400 for a refused op with its reason, nothing written", async (t) => {
    const { file, commits } = makeSite(t);
    const res = stubRes();
    await routes.updateContentBlocks(
      makeReq(
        { idOrSlug: "one" },
        {
          ops: [
            {
              op: "setAttributes",
              tag: "img",
              index: 0,
              before: '<img src="files/a.png">',
              set: { onerror: "x" },
            },
          ],
        },
      ),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.data.reason, "not-allowed");
    assert.match(res.body.data.message, /^Block 0 refused \(not-allowed\): /);
    assert.equal(fs.readFileSync(file, "utf8"), PAGE);
    assert.equal(commits.length, 0);
  });

  test("400 without ops", async (t) => {
    makeSite(t);
    const res = stubRes();
    await routes.updateContentBlocks(
      makeReq({ idOrSlug: "one" }, { ops: [] }),
      res,
    );
    assert.equal(res.statusCode, 400);
  });

  test("concurrent patches on one page apply in turn; the second sees the first", async (t) => {
    const { file, commits } = makeSite(t);
    const op = {
      op: "setAttributes",
      tag: "img",
      index: 0,
      before: '<img src="files/a.png">',
      set: { alt: "first" },
    };
    const a = stubRes();
    const b = stubRes();
    await Promise.all([
      routes.updateContentBlocks(
        makeReq({ idOrSlug: "one" }, { ops: [op] }),
        a,
      ),
      routes.updateContentBlocks(
        makeReq(
          { idOrSlug: "one" },
          { ops: [Object.assign({}, op, { set: { alt: "second" } })] },
        ),
        b,
      ),
    ]);
    // exactly one wins; the other read the updated page and is stale
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.equal(commits.length, 1);
    assert.ok(fs.readFileSync(file, "utf8").includes('alt="first"'));
  });

  test("summarize names attributes and counts per tag", () => {
    assert.equal(
      routes.summarize([
        { op: "setAttributes", tag: "img", set: { alt: "a" } },
        { op: "setAttributes", tag: "IMG", set: { alt: "b" } },
        { op: "replaceBlock", tag: "video-player" },
      ]),
      "alt on 2 img, block on 1 video-player",
    );
  });
});

test("normalizeNote keeps one line of plain text", () => {
  const { normalizeNote } = require("../../src/siteRoutes/v1/contentBlocks.js");
  assert.equal(
    normalizeNote("Reports: <b>alt</b>\ntext"),
    "Reports: balt/b text",
  );
  assert.equal(
    normalizeNote("<<script>script>alert(1)<</script>/script>"),
    "scriptscriptalert(1)/script/script",
  );
  assert.equal(normalizeNote("a\u0000b\u007f"), "ab");
  assert.equal(normalizeNote("x".repeat(200)).length, 120);
  assert.equal(normalizeNote(5), "");
});
