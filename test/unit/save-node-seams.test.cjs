"use strict";

// saveNode (PATCH /x/api/v1/content/{id}) is the busiest save the plugin
// platform wraps in page hooks. These pin what it does today in the paths the
// rest of the suite does not reach, so the hooks can be added without
// changing them:
//   - a locked page and a failed page write are refused, and nothing is
//     updated or committed (an after-save hook has nothing to report)
//   - page-break attributes that were set before and are not sent now are
//     removed from the page's metadata
//   - developer-theme sets a copy of the theme (never the shared entry), and
//     "_none_" or an unknown theme clears it
//   - media in the schema becomes metadata.images / metadata.videos
//
// Constraints honored: CommonJS (.cjs), require(), node:test +
// node:assert/strict, no optional chaining.

const test = require("node:test");
const assert = require("node:assert/strict");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const saveNode = require("../../src/siteRoutes/v1/routes/saveNode.js");

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

// a site with one page, recording what the save does to it
function makeSite(pageOver = {}, write = async () => 1) {
  const calls = { writes: 0, updates: 0, commits: [] };
  const page = Object.assign(
    {
      id: "item-a",
      title: "Item A",
      slug: "item-a",
      parent: null,
      order: 0,
      indent: 0,
      location: "pages/item-a/index.html",
      metadata: {},
      writeLocation: async (...args) => {
        calls.writes++;
        return write(...args);
      },
    },
    pageOver,
  );
  const items = [page];
  const site = {
    siteDirectory: "/tmp/does-not-matter",
    loadNode: (id) => items.find((item) => item.id === id) || null,
    getUniqueSlugName: (slug) => slug,
    updateNode: async () => {
      calls.updates++;
      return true;
    },
    writePageAlternateFormats: async () => true,
    updateAlternateFormats: async () => true,
    gitCommit: async (msg) => {
      calls.commits.push(msg);
      return true;
    },
    manifest: { items, metadata: { site: {} }, save: async () => true },
  };
  return { site, page, calls };
}

function mockSession(t, site, themes) {
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
  t.mock.method(HAXCMS, "loadSite", async () => site);
  if (themes) t.mock.method(HAXCMS, "getThemes", () => themes);
}

function save(body, schema) {
  const node = { id: "item-a", body };
  if (schema !== undefined) node.schema = schema;
  return {
    headers: { "x-haxcms-site-token": "token" },
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: "demo",
    },
    body: { site: { name: "demo" }, node },
  };
}

const BREAK = (attrs = "") =>
  `<page-break title="Item A" item-id="item-a" ${attrs}></page-break><p>Body</p>`;

test("a locked page is refused with 423; nothing is written, updated or committed", async (t) => {
  const { site, calls } = makeSite({ metadata: { locked: true } });
  mockSession(t, site);
  const res = stubRes();
  await saveNode(save(BREAK()), res);
  assert.equal(res.statusCode, 423);
  assert.equal(res.body.data.reason, "locked");
  assert.deepEqual(calls, { writes: 0, updates: 0, commits: [] });
});

test("a page write that fails is 500; the page is not updated or committed", async (t) => {
  const { site, page, calls } = makeSite({}, async () => false);
  mockSession(t, site);
  const res = stubRes();
  await saveNode(save(BREAK('tags="new"')), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.data.message, "failed to write");
  assert.equal(calls.writes, 1);
  assert.equal(calls.updates, 0);
  assert.deepEqual(calls.commits, []);
  assert.equal(page.metadata.tags, undefined, "metadata untouched");
});

test("page-break attributes not sent this time are removed from the page", async (t) => {
  const { site, page } = makeSite({
    metadata: {
      pageType: "lesson",
      relatedItems: "item-b",
      tags: "old",
      accentColor: "pink",
      icon: "icons:star",
      image: "files/old.png",
      linkUrl: "https://example.org",
      linkTarget: "_blank",
    },
  });
  mockSession(t, site);
  const res = stubRes();
  await saveNode(save(BREAK()), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  for (const key of [
    "pageType",
    "relatedItems",
    "tags",
    "accentColor",
    "icon",
    "image",
    "linkUrl",
    "linkTarget",
  ])
    assert.equal(key in page.metadata, false, key + " removed");
});

test("developer-theme sets a copy of the theme; _none_ and an unknown theme clear it", async (t) => {
  const themes = {
    "clean-one": { element: "clean-one", name: "Clean One" },
  };
  const { site, page } = makeSite();
  mockSession(t, site, themes);
  let res = stubRes();
  await saveNode(save(BREAK('developer-theme="clean-one"')), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(page.metadata.theme, {
    element: "clean-one",
    name: "Clean One",
    key: "clean-one",
  });
  // the shared theme list is not changed by the page's copy
  assert.equal("key" in themes["clean-one"], false);

  for (const value of ["_none_", "no-such-theme"]) {
    page.metadata.theme = { element: "clean-one", key: "clean-one" };
    res = stubRes();
    await saveNode(save(BREAK(`developer-theme="${value}"`)), res);
    assert.equal(res.statusCode, 200);
    assert.equal("theme" in page.metadata, false, value + " clears it");
  }

  // not sent at all: a theme set before is removed too
  page.metadata.theme = { element: "clean-one", key: "clean-one" };
  res = stubRes();
  await saveNode(save(BREAK()), res);
  assert.equal("theme" in page.metadata, false);
});

test("media in the schema becomes the page's images and videos, list or keyed", async (t) => {
  const schema = [
    { tag: "img", properties: { src: "files/a.png" } },
    { tag: "a11y-gif-player", properties: { src: "files/b.gif" } },
    { tag: "media-image", properties: { source: "files/c.jpg" } },
    { tag: "video-player", properties: { source: "https://v.example/1" } },
    { tag: "img" },
    { tag: "p", properties: { src: "ignored" } },
    null,
  ];
  for (const shape of [schema, Object.assign({}, schema)]) {
    const { site, page } = makeSite({
      metadata: { images: ["stale.png"], videos: ["stale"] },
    });
    mockSession(t, site);
    const res = stubRes();
    await saveNode(save(BREAK(), shape), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(page.metadata.images, [
      "files/a.png",
      "files/b.gif",
      "files/c.jpg",
    ]);
    assert.deepEqual(page.metadata.videos, ["https://v.example/1"]);
  }
});
