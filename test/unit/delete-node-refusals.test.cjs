"use strict";

// deleteNode (DELETE /x/api/v1/items/{id}) refusals and failures change
// nothing: the plugin platform fires page.after.delete only for a delete that
// happened. Same statuses as haxcms-php (OperationsNodeOpsTest:
// testDeleteNodeOfAnUnknownPageIs500AndChangesNothing,
// testDeleteNodeWhoseDeleteFailsIs500AndCommitsNothing).
//
// Constraints honored: CommonJS (.cjs), require(), node:test +
// node:assert/strict, no optional chaining.

const test = require("node:test");
const assert = require("node:assert/strict");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const deleteNode = require("../../src/siteRoutes/v1/routes/deleteNode.js");

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

function makeSite(opts = {}) {
  const calls = { deletes: 0, saves: 0, commits: [] };
  const items = [
    {
      id: "item-a",
      title: "A",
      parent: null,
      order: 0,
      indent: 0,
      metadata: {},
    },
    {
      id: "item-b",
      title: "B",
      parent: null,
      order: 1,
      indent: 0,
      metadata: {},
    },
  ];
  const site = {
    loadNode: (id) => items.find((item) => item.id === id) || null,
    deleteNode: async () => {
      calls.deletes++;
      return opts.deleteFails ? false : true;
    },
    updateAlternateFormats: async () => true,
    gitCommit: async (msg) => {
      calls.commits.push(msg);
    },
    manifest: {
      items,
      metadata: { site: { name: "demo" }, platform: opts.platform },
      save: async () => {
        calls.saves++;
      },
    },
  };
  return { site, items, calls };
}

function del(t, site, id) {
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const res = stubRes();
  return deleteNode(
    {
      headers: { "x-haxcms-site-token": "token" },
      haxcmsSiteApiAuth: {
        authenticated: true,
        securityLevel: "authenticated-site",
        userName: "tester",
        siteName: "demo",
      },
      body: { site: { name: "demo" }, node: { id } },
    },
    res,
  ).then(() => res);
}

test("an unknown page is 500 and nothing is deleted, saved or committed", async (t) => {
  const { site, items, calls } = makeSite();
  const before = JSON.stringify(items);
  const res = await del(t, site, "no-such-page");
  assert.equal(res.statusCode, 500);
  assert.deepEqual(calls, { deletes: 0, saves: 0, commits: [] });
  assert.equal(JSON.stringify(items), before);
});

test("a delete that fails is 500 and nothing is saved or committed", async (t) => {
  const { site, items, calls } = makeSite({ deleteFails: true });
  const before = JSON.stringify(items);
  const res = await del(t, site, "item-a");
  assert.equal(res.statusCode, 500);
  assert.equal(calls.deletes, 1);
  assert.equal(calls.saves, 0);
  assert.deepEqual(calls.commits, []);
  assert.equal(JSON.stringify(items), before);
});

test("a site with deletePage off refuses with 403 and deletes nothing", async (t) => {
  const { site, calls } = makeSite({
    platform: { features: { deletePage: false } },
  });
  const res = await del(t, site, "item-a");
  assert.equal(res.statusCode, 403);
  assert.deepEqual(calls, { deletes: 0, saves: 0, commits: [] });
});
