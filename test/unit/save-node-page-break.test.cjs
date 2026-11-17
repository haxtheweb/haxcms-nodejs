"use strict";

// saveNode only writes content that follows a <page-break>. A body without
// one must be refused rather than answered with 200 and silently dropped.

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

test("a body without a <page-break> is refused with 400 and nothing is written", async (t) => {
  let writes = 0;
  const page = {
    id: "item-1",
    title: "Page",
    metadata: {},
    writeLocation: async () => {
      writes++;
      return 1;
    },
  };
  const site = { loadNode: () => page, manifest: { metadata: { site: {} } } };
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const req = {
    headers: { "x-haxcms-site-token": "token" },
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: "demo",
    },
    body: {
      site: { name: "demo" },
      node: { id: "item-1", body: "<p>Hello</p>" },
    },
  };
  const res = stubRes();
  await saveNode(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.data.message, /<page-break>/);
  assert.equal(writes, 0);
});

test("a content save never moves the page: page-break parent, order and depth are ignored", async (t) => {
  const page = {
    id: "item-a",
    title: "Item A",
    slug: "item-a",
    parent: null,
    order: 2,
    indent: 0,
    location: "pages/item-a/index.html",
    metadata: {},
    writeLocation: async () => 1,
  };
  const items = [
    {
      id: "item-b",
      title: "Item B",
      slug: "item-b",
      parent: null,
      order: 0,
      indent: 0,
      metadata: {},
    },
    {
      id: "item-c",
      title: "Item C",
      slug: "item-c",
      parent: null,
      order: 1,
      indent: 0,
      metadata: {},
    },
    page,
  ];
  const site = {
    siteDirectory: "/tmp/does-not-matter",
    loadNode: (id) => items.find((item) => item.id === id) || null,
    getUniqueSlugName: (slug) => slug,
    updateNode: async () => true,
    writePageAlternateFormats: async () => true,
    updateAlternateFormats: async () => true,
    gitCommit: async () => true,
    manifest: {
      items,
      metadata: { site: {} },
      save: async () => true,
    },
  };
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const req = {
    headers: { "x-haxcms-site-token": "token" },
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: "demo",
    },
    body: {
      site: { name: "demo" },
      node: {
        id: "item-a",
        // the browser renumbers orders when it loads the outline, so the
        // page-break can carry any parent, order or depth; none of it counts
        body: '<page-break title="Item A" item-id="item-a" parent="item-b" order="0" depth="4"></page-break><p>Body</p>',
      },
    },
  };
  const res = stubRes();
  await saveNode(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(page.parent, null);
  assert.equal(page.order, 2);
  assert.equal(page.indent, 0);
  assert.deepEqual(
    items.map((item) => [item.id, item.parent, item.order]),
    [
      ["item-b", null, 0],
      ["item-c", null, 1],
      ["item-a", null, 2],
    ],
  );
});

test("a page-break titled null or blank saves the default title", async (t) => {
  for (const title of ["null", "", "  "]) {
    const page = {
      id: "item-a",
      title: "Item A",
      slug: "item-a",
      parent: null,
      order: 0,
      indent: 0,
      location: "pages/item-a/index.html",
      metadata: {},
      writeLocation: async () => 1,
    };
    const items = [page];
    const site = {
      siteDirectory: "/tmp/does-not-matter",
      loadNode: (id) => items.find((item) => item.id === id) || null,
      getUniqueSlugName: (slug) => slug,
      updateNode: async () => true,
      writePageAlternateFormats: async () => true,
      updateAlternateFormats: async () => true,
      gitCommit: async () => true,
      manifest: { items, metadata: { site: {} }, save: async () => true },
    };
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
    t.mock.method(HAXCMS, "loadSite", async () => site);
    const req = {
      headers: { "x-haxcms-site-token": "token" },
      haxcmsSiteApiAuth: {
        authenticated: true,
        securityLevel: "authenticated-site",
        userName: "tester",
        siteName: "demo",
      },
      body: {
        site: { name: "demo" },
        node: {
          id: "item-a",
          body: `<page-break title="${title}" item-id="item-a"></page-break><p>Body</p>`,
        },
      },
    };
    const res = stubRes();
    await saveNode(req, res);
    assert.equal(res.statusCode, 200, title);
    assert.equal(page.title, "New page", JSON.stringify(title));
    t.mock.restoreAll();
  }
});

test("a page-break title is saved without leading or trailing white space", async (t) => {
  for (const title of ["  Padded title  ", "Padded title\u00a0"]) {
    const page = {
      id: "item-a",
      title: "Item A",
      slug: "item-a",
      parent: null,
      order: 0,
      indent: 0,
      location: "pages/item-a/index.html",
      metadata: {},
      writeLocation: async () => 1,
    };
    const items = [page];
    const site = {
      siteDirectory: "/tmp/does-not-matter",
      loadNode: (id) => items.find((item) => item.id === id) || null,
      getUniqueSlugName: (slug) => slug,
      updateNode: async () => true,
      writePageAlternateFormats: async () => true,
      updateAlternateFormats: async () => true,
      gitCommit: async () => true,
      manifest: { items, metadata: { site: {} }, save: async () => true },
    };
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
    t.mock.method(HAXCMS, "loadSite", async () => site);
    const req = {
      headers: { "x-haxcms-site-token": "token" },
      haxcmsSiteApiAuth: {
        authenticated: true,
        securityLevel: "authenticated-site",
        userName: "tester",
        siteName: "demo",
      },
      body: {
        site: { name: "demo" },
        node: {
          id: "item-a",
          body: `<page-break title="${title}" item-id="item-a"></page-break><p>Body</p>`,
        },
      },
    };
    const res = stubRes();
    await saveNode(req, res);
    assert.equal(res.statusCode, 200, title);
    assert.equal(page.title, "Padded title", JSON.stringify(title));
    t.mock.restoreAll();
  }
});
