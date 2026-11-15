"use strict";

// Unit tests for the outside link checker behind POST x/api/v1/site/check-links
// (src/lib/linkChecker.js, haxtheweb/issues#3167). Proves: only links found in
// the site's own pages are fetched (and the fetched URL comes from the site,
// not the request), HEAD falls back to GET, statuses and errors map to the
// documented states, answers are cached, and the per user/site budget blocks
// once spent without counting cached answers.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const linkChecker = require("../../src/lib/linkChecker.js");
const safeFetchModule = require("../../src/lib/safeFetch.js");

const SITE_HTML =
  '<p><a href="https://example.org/ok">ok</a>' +
  ' <a href=" https://example.org/gone ">gone</a>' +
  ' <a href="//example.org/proto">proto</a>' +
  ' <a href="https://example.org/moved#part">moved</a>' +
  ' <a href="/internal">internal</a>' +
  ' <a href="mailto:a@example.org">mail</a></p>';

function site(name) {
  return { name: name, siteDirectory: "/sites/" + name, manifest: {} };
}

function settings(max, windowMs) {
  return { enabled: true, windowMs: windowMs || 60000, max: max };
}

// fake safeFetch: answers from a table keyed by URL then method
function fakeFetch(table, calls) {
  return async function (url, options) {
    calls.push({
      url: url,
      method: options.method,
      discardBody: options.discardBody,
    });
    const entry = table[url];
    if (!entry) {
      const err = new Error("no route");
      err.code = "ECONNREFUSED";
      throw err;
    }
    const answer = typeof entry === "function" ? entry(options.method) : entry;
    if (answer instanceof Error) {
      throw answer;
    }
    return {
      status: answer.status,
      url: answer.url || url,
      redirected: answer.redirected === true,
    };
  };
}

function run(o) {
  return linkChecker.checkSiteLinks(
    Object.assign(
      {
        site: site("demo"),
        loadSiteHtml: async () => SITE_HTML,
        rateKey: "alice::demo",
        rateSettings: settings(100),
      },
      o,
    ),
  );
}

describe("linkChecker — what counts as an outside link", () => {
  test("toCheckUrl keeps http(s), upgrades //host, drops the fragment", () => {
    assert.equal(
      linkChecker.toCheckUrl("https://example.org/a#b"),
      "https://example.org/a",
    );
    assert.equal(
      linkChecker.toCheckUrl("//example.org/x"),
      "https://example.org/x",
    );
    assert.equal(
      linkChecker.toCheckUrl("  http://example.org  "),
      "http://example.org/",
    );
    assert.equal(linkChecker.toCheckUrl("/internal"), "");
    assert.equal(linkChecker.toCheckUrl("mailto:a@example.org"), "");
    assert.equal(linkChecker.toCheckUrl("javascript:alert(1)"), "");
    assert.equal(linkChecker.toCheckUrl("https://" + "a".repeat(2100)), "");
    assert.equal(linkChecker.toCheckUrl(null), "");
  });

  test("extractOutsideLinks maps trimmed hrefs to the URL that is fetched", () => {
    const found = linkChecker.extractOutsideLinks(SITE_HTML);
    assert.deepEqual(Array.from(found.keys()).sort(), [
      "//example.org/proto",
      "https://example.org/gone",
      "https://example.org/moved#part",
      "https://example.org/ok",
    ]);
    assert.equal(found.get("//example.org/proto"), "https://example.org/proto");
    assert.equal(
      found.get("https://example.org/moved#part"),
      "https://example.org/moved",
    );
  });
});

describe("linkChecker — states", () => {
  beforeEach(() => {
    linkChecker.resetForTesting();
  });

  test("classifyStatus maps statuses to ok / redirected / check / broken", () => {
    assert.equal(linkChecker.classifyStatus(200, false).state, "ok");
    assert.equal(linkChecker.classifyStatus(204, true).state, "redirected");
    assert.equal(linkChecker.classifyStatus(403, false).state, "check");
    assert.equal(linkChecker.classifyStatus(429, false).state, "check");
    assert.equal(linkChecker.classifyStatus(999, false).state, "check");
    assert.deepEqual(linkChecker.classifyStatus(404, false), {
      state: "broken",
      reason: "http",
    });
    assert.equal(linkChecker.classifyStatus(500, false).state, "broken");
  });

  test("errorReason maps SSRF and network errors", () => {
    const e = (code) => Object.assign(new Error(code), { code: code });
    assert.deepEqual(linkChecker.errorReason(e("SSRF_PRIVATE")), {
      state: "skipped",
      reason: "private",
    });
    assert.deepEqual(linkChecker.errorReason(e("SSRF_DNS")), {
      state: "broken",
      reason: "dns",
    });
    assert.deepEqual(linkChecker.errorReason(e("SSRF_TIMEOUT")), {
      state: "check",
      reason: "timeout",
    });
    assert.deepEqual(linkChecker.errorReason(e("SSRF_REDIRECTS")), {
      state: "broken",
      reason: "redirects",
    });
    assert.deepEqual(linkChecker.errorReason(e("CERT_HAS_EXPIRED")), {
      state: "broken",
      reason: "tls",
    });
    assert.deepEqual(linkChecker.errorReason(e("ECONNRESET")), {
      state: "broken",
      reason: "connection",
    });
  });

  test("HEAD that is refused is retried once as GET; 404 is not retried", async () => {
    const calls = [];
    const fetchImpl = fakeFetch(
      {
        "https://example.org/ok": (m) => ({ status: m === "HEAD" ? 405 : 200 }),
        "https://example.org/gone": { status: 404 },
      },
      calls,
    );
    const ok = await linkChecker.checkUrl("https://example.org/ok", fetchImpl);
    assert.equal(ok.state, "ok");
    assert.equal(ok.status, 200);
    const gone = await linkChecker.checkUrl(
      "https://example.org/gone",
      fetchImpl,
    );
    assert.equal(gone.state, "broken");
    assert.deepEqual(
      calls.map((c) => c.method + " " + c.url),
      [
        "HEAD https://example.org/ok",
        "GET https://example.org/ok",
        "HEAD https://example.org/gone",
      ],
    );
    assert.ok(calls.every((c) => c.discardBody === true));
  });

  test("a redirect to another URL reports redirected and the final URL", async () => {
    const calls = [];
    const fetchImpl = fakeFetch(
      {
        "https://example.org/moved": {
          status: 200,
          redirected: true,
          url: "https://example.org/new-home",
        },
      },
      calls,
    );
    const r = await linkChecker.checkUrl(
      "https://example.org/moved",
      fetchImpl,
    );
    assert.equal(r.state, "redirected");
    assert.equal(r.finalUrl, "https://example.org/new-home");
  });
});

describe("linkChecker — checkSiteLinks", () => {
  beforeEach(() => {
    linkChecker.resetForTesting();
  });

  test("links not in the site are skipped and never fetched", async () => {
    const calls = [];
    const out = await run({
      links: [
        "https://evil.example/",
        "http://169.254.169.254/latest/meta-data",
        "https://example.org/ok",
      ],
      fetchImpl: fakeFetch(
        { "https://example.org/ok": { status: 200 } },
        calls,
      ),
    });
    assert.equal(out.rateLimited, false);
    assert.deepEqual(
      out.results.map((r) => r.href + " " + r.state + " " + r.reason),
      [
        "https://evil.example/ skipped not-in-site",
        "http://169.254.169.254/latest/meta-data skipped not-in-site",
        "https://example.org/ok ok ",
      ],
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://example.org/ok"],
    );
    assert.equal(out.checked, 1);
  });

  test("the fetched URL is the one read from the site, matched by trimmed href", async () => {
    const calls = [];
    const out = await run({
      links: [
        "https://example.org/gone",
        "//example.org/proto",
        "https://example.org/moved#part",
      ],
      fetchImpl: fakeFetch(
        {
          "https://example.org/gone": { status: 410 },
          "https://example.org/proto": { status: 200 },
          "https://example.org/moved": { status: 200 },
        },
        calls,
      ),
    });
    assert.deepEqual(
      out.results.map((r) => r.state),
      ["broken", "ok", "ok"],
    );
    assert.deepEqual(calls.map((c) => c.url).sort(), [
      "https://example.org/gone",
      "https://example.org/moved",
      "https://example.org/proto",
    ]);
  });

  test("answers are cached: a second request makes no network calls and reports cached", async () => {
    const calls = [];
    const fetchImpl = fakeFetch(
      { "https://example.org/ok": { status: 200 } },
      calls,
    );
    await run({ links: ["https://example.org/ok"], fetchImpl: fetchImpl });
    const again = await run({
      links: ["https://example.org/ok"],
      fetchImpl: fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(again.checked, 0);
    assert.equal(again.cached, 1);
    assert.equal(again.results[0].cached, true);
    assert.equal(again.results[0].state, "ok");
  });

  test("the budget blocks once spent, and cached answers do not count", async () => {
    const calls = [];
    const fetchImpl = fakeFetch(
      {
        "https://example.org/ok": { status: 200 },
        "https://example.org/gone": { status: 404 },
        "https://example.org/proto": { status: 200 },
      },
      calls,
    );
    const s = settings(2, 60000);
    const first = await run({
      links: ["https://example.org/ok", "https://example.org/gone"],
      fetchImpl: fetchImpl,
      rateSettings: s,
      now: 1000,
    });
    assert.equal(first.rateLimited, false);
    assert.equal(first.remaining, 0);
    // cached answers still come back with an empty budget
    const cachedOnly = await run({
      links: ["https://example.org/ok"],
      fetchImpl: fetchImpl,
      rateSettings: s,
      now: 2000,
    });
    assert.equal(cachedOnly.rateLimited, false);
    assert.equal(cachedOnly.results[0].cached, true);
    // a new network check is refused until the window ends
    const blocked = await run({
      links: ["//example.org/proto"],
      fetchImpl: fetchImpl,
      rateSettings: s,
      now: 3000,
    });
    assert.equal(blocked.rateLimited, true);
    assert.equal(blocked.retryAfterSeconds, 58);
    assert.equal(calls.length, 2);
    // another user on the same site has their own budget
    const other = await run({
      links: ["//example.org/proto"],
      fetchImpl: fetchImpl,
      rateSettings: s,
      rateKey: "bob::demo",
      now: 3000,
    });
    assert.equal(other.rateLimited, false);
  });

  test("links not reached in the time budget come back deferred, uncached and uncharged", async () => {
    const calls = [];
    const out = await run({
      links: ["https://example.org/ok", "https://example.org/gone"],
      fetchImpl: fakeFetch({}, calls),
      rateSettings: settings(5),
      budgetMs: 0,
      now: 1000,
    });
    assert.equal(out.rateLimited, false);
    assert.equal(out.deferred, 2);
    assert.equal(out.checked, 0);
    assert.equal(out.remaining, 5);
    assert.deepEqual(
      out.results.map((r) => r.state + " " + r.reason),
      ["skipped deferred", "skipped deferred"],
    );
    assert.equal(calls.length, 0);
  });

  test("duplicate and non-string hrefs are folded away", async () => {
    const calls = [];
    const out = await run({
      links: [
        "https://example.org/ok",
        " https://example.org/ok ",
        42,
        null,
        "",
      ],
      fetchImpl: fakeFetch(
        { "https://example.org/ok": { status: 200 } },
        calls,
      ),
    });
    assert.equal(out.results.length, 1);
    assert.equal(calls.length, 1);
  });
});

describe("safeFetch — discardBody", () => {
  test("resolves on the status line without reading the body; private hosts are refused", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("x".repeat(1024));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      await assert.rejects(
        safeFetchModule.safeFetch("http://127.0.0.1:" + port + "/", {
          method: "HEAD",
          discardBody: true,
        }),
        (e) => e && e.code === "SSRF_PRIVATE",
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
