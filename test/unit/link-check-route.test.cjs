"use strict";

// Direct handler tests for src/siteRoutes/v1/linkChecks.js
// (POST x/api/v1/site/check-links, haxtheweb/issues#3167): request
// validation, links read from the site's real page files on disk, the 429 +
// Retry-After answer once the per user/site budget is spent, and that a
// link that is not in the site never reaches the network.
//
// Site resolution runs through the real resolveSiteForRequest with
// HAXCMS.loadSite mocked; safeFetch's network boundary (dns + http.request)
// is stubbed so no real request leaves the test.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dns = require("node:dns");
const https = require("node:https");
const { EventEmitter } = require("node:events");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const linkChecker = require("../../src/lib/linkChecker.js");
const { checkSiteLinks } = require("../../src/siteRoutes/v1/linkChecks.js");

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

function makeReq(body) {
  return {
    method: "POST",
    headers: { "x-haxcms-site-token": "token", accept: "application/json" },
    query: {},
    params: {},
    body: body,
    originalUrl: "/_sites/demo/x/api/v1/site/check-links",
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: "demo",
    },
  };
}

function makeSite(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-link-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "pages", "item-1"), { recursive: true });
  fs.mkdirSync(path.join(dir, "pages", "item-2"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pages", "item-1", "index.html"),
    '<p><a href="https://example.org/ok">ok</a></p>',
  );
  // unpublished pages are still checked: an author fixes drafts too
  fs.writeFileSync(
    path.join(dir, "pages", "item-2", "index.html"),
    '<p><a href="https://example.org/gone">gone</a></p>',
  );
  return {
    siteDirectory: dir,
    name: "demo",
    manifest: {
      items: [
        {
          id: "item-1",
          title: "One",
          slug: "one",
          location: "pages/item-1/index.html",
          order: 0,
          metadata: {},
        },
        {
          id: "item-2",
          title: "Two",
          slug: "two",
          location: "pages/item-2/index.html",
          order: 1,
          metadata: { published: false },
        },
      ],
      metadata: { site: { name: "demo" }, theme: {} },
    },
  };
}

// network boundary: every host resolves public, https.request answers from
// the path table (HEAD and GET alike) and records what was asked for
function useNetwork(t, statusByPath) {
  const prevLookup = dns.promises.lookup;
  const prevRequest = https.request;
  const calls = [];
  dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  https.request = function (options, cb) {
    calls.push(options.method + " " + options.headers.host + options.path);
    const req = new EventEmitter();
    req.write = function () {};
    req.destroy = function () {};
    req.end = function () {
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = statusByPath[options.path] || 500;
        res.statusMessage = "";
        res.headers = {};
        res.destroy = function () {};
        cb(res);
      });
    };
    return req;
  };
  t.after(() => {
    dns.promises.lookup = prevLookup;
    https.request = prevRequest;
  });
  return calls;
}

describe("POST x/api/v1/site/check-links", () => {
  beforeEach(() => {
    linkChecker.resetForTesting();
  });

  test("400 without links, or with more than the per-request cap", async (t) => {
    t.mock.method(HAXCMS, "loadSite", async () => makeSite(t));
    const none = stubRes();
    await checkSiteLinks(makeReq({}), none);
    assert.equal(none.statusCode, 400);
    const tooMany = stubRes();
    const links = [];
    for (let i = 0; i <= linkChecker.LINK_CHECK_MAX_LINKS; i++) {
      links.push("https://example.org/" + i);
    }
    await checkSiteLinks(makeReq({ links: links }), tooMany);
    assert.equal(tooMany.statusCode, 400);
  });

  test("404 when the site cannot be resolved", async (t) => {
    t.mock.method(HAXCMS, "loadSite", async () => null);
    const res = stubRes();
    await checkSiteLinks(makeReq({ links: ["https://example.org/ok"] }), res);
    assert.equal(res.statusCode, 404);
  });

  test("checks links from the site pages, skips anything else without fetching it", async (t) => {
    t.mock.method(HAXCMS, "loadSite", async () => makeSite(t));
    const calls = useNetwork(t, { "/ok": 200, "/gone": 404 });
    const res = stubRes();
    await checkSiteLinks(
      makeReq({
        links: [
          "https://example.org/ok",
          "https://example.org/gone",
          "https://elsewhere.test/",
        ],
      }),
      res,
    );
    assert.equal(res.statusCode, 200);
    const data = res.body && res.body.data ? res.body.data : res.body;
    assert.deepEqual(
      data.results.map((r) => r.href + " " + r.state + " " + r.reason),
      [
        "https://example.org/ok ok ",
        "https://example.org/gone broken http",
        "https://elsewhere.test/ skipped not-in-site",
      ],
    );
    assert.equal(data.checked, 2);
    assert.equal(data.limits.maxLinks, linkChecker.LINK_CHECK_MAX_LINKS);
    assert.deepEqual(calls.slice().sort(), [
      "HEAD example.org/gone",
      "HEAD example.org/ok",
    ]);
  });

  test("429 with Retry-After once the budget is spent", async (t) => {
    t.mock.method(HAXCMS, "loadSite", async () => makeSite(t));
    t.mock.method(HAXCMS, "getLinkCheckRateLimitSettings", () => ({
      enabled: true,
      windowMs: 60000,
      max: 1,
    }));
    useNetwork(t, { "/ok": 200, "/gone": 404 });
    const first = stubRes();
    await checkSiteLinks(makeReq({ links: ["https://example.org/ok"] }), first);
    assert.equal(first.statusCode, 200);
    const second = stubRes();
    await checkSiteLinks(
      makeReq({ links: ["https://example.org/gone"] }),
      second,
    );
    assert.equal(second.statusCode, 429);
    assert.ok(Number(second.headers["Retry-After"]) > 0);
    assert.match(second.body.data.message, /Link check limit reached/);
  });
});
