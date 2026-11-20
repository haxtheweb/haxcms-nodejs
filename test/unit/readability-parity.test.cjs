"use strict";

// Readability contract shared with haxcms-php: the overview report must
// answer exactly the values in test/fixtures/readability-parity.json, which
// haxcms-php checks too (system/backend/php/tests/fixtures/, identical copy).
// The pages go through the real report route with the real text-readability
// module; only the page loader is stubbed so each case feeds its own HTML.
// A last test reads real page files to check unpublished pages are skipped.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const fixture = require("../fixtures/readability-parity.json");
const josHelpers = require("../../src/lib/JOSHelpers.js");
const { readabilityTextFromHTML } = require("../../src/lib/readabilityText.js");

const realReadabilityPages = josHelpers.siteReadabilityPages;
let pagesFixture = [];
josHelpers.courseStatsFromOutline = async () => ({});
josHelpers.siteReadabilityPages = async (...args) =>
  pagesFixture === null ? realReadabilityPages(...args) : pagesFixture;

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const { reportDetail } = require("../../src/siteRoutes/v1/reports.js");

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
  };
}

function overviewReq() {
  return {
    headers: {},
    query: {},
    params: { report: "overview" },
    body: {},
    originalUrl: "/_sites/demo/x/api/v1/reports/overview",
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: "demo",
    },
  };
}

function makeSite(siteDirectory, items) {
  return {
    siteDirectory: siteDirectory,
    name: "demo",
    manifest: {
      items: items,
      getItemById(id) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].id === id) {
            return items[i];
          }
        }
        return false;
      },
      metadata: { site: { name: "demo", settings: { lang: "en" } } },
    },
  };
}

async function overview(t, site) {
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const res = stubRes();
  await reportDetail(overviewReq(), res);
  assert.equal(res.statusCode, 200);
  return res.body.data.data.readability;
}

describe("readability parity contract (shared with haxcms-php)", () => {
  for (let i = 0; i < fixture.cases.length; i++) {
    const testCase = fixture.cases[i];
    test(testCase.name, async (t) => {
      assert.equal(readabilityTextFromHTML(testCase.pages), testCase.text);
      pagesFixture = testCase.pages;
      t.after(() => {
        pagesFixture = [];
      });
      const readability = await overview(t, makeSite(os.tmpdir(), []));
      assert.deepEqual(readability, testCase.readability);
    });
  }
});

describe("readability page selection", () => {
  test("only published pages are scored, in outline order", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "readability-pages-"));
    t.after(() => {
      fs.removeSync(root);
    });
    const pages = {
      a: "<p>The cat sat on the mat.</p>",
      b: "<p>Hidden draft words must never be counted anywhere.</p>",
      c: "<p>It was a good day for reading.</p>",
    };
    const items = [];
    const ids = Object.keys(pages);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      fs.outputFileSync(path.join(root, "pages", id, "index.html"), pages[id]);
      items.push({
        id: id,
        title: id,
        slug: id,
        parent: null,
        indent: 0,
        order: i,
        location: "pages/" + id + "/index.html",
        metadata: id === "b" ? { published: false } : {},
      });
    }
    pagesFixture = null;
    t.after(() => {
      pagesFixture = [];
    });
    const readability = await overview(t, makeSite(root, items));
    // same numbers as the one-short-paragraph case: page b is not read
    const expected = fixture.cases.find(
      (c) => c.name === "one short paragraph",
    );
    assert.deepEqual(readability, expected.readability);
  });
});

describe("readability text extraction stays linear", () => {
  test("pages full of unclosed markup are read quickly", () => {
    const pages = [
      "<".repeat(200000),
      "<!--".repeat(50000),
      "<script".repeat(30000),
      "<script>" + "</script".repeat(30000),
    ];
    const started = Date.now();
    for (let i = 0; i < pages.length; i++) {
      assert.equal(readabilityTextFromHTML([pages[i]]), "");
    }
    // a backtracking pattern takes minutes here; the scan takes milliseconds
    assert.ok(Date.now() - started < 2000);
  });
});
