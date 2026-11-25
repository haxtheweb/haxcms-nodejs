"use strict";

// POST /system/api/v1/actions/website-metadata: the on-premises replacement
// for the open-apis metadata service (link previews, insert link by URL).

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  websiteMetadata,
  readWebsiteMetadata,
} = require("../../src/systemRoutes/v1/routes/websiteMetadata.js");

function fakeRes() {
  return {
    code: 200,
    payload: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test("reads title, meta by name or property and JSON-LD, keeping the asked url", () => {
  const html = `<html><head><title>Field day</title>
    <meta name="description" content="A day outside">
    <meta property="og:title" content="Field day!">
    <meta property="og:image" content="https://example.com/a.jpg">
    <meta name="empty">
    <meta name="__proto__" content="x">
    <script type="application/ld+json">{"@type":"Event"}</script>
    <script type="application/ld+json">not json</script>
    </head><body></body></html>`;
  const data = readWebsiteMetadata(html, "https://example.com/day");
  assert.equal(data.title, "Field day");
  assert.equal(data.description, "A day outside");
  assert.equal(data["og:title"], "Field day!");
  assert.equal(data["og:image"], "https://example.com/a.jpg");
  assert.equal(data.url, "https://example.com/day");
  assert.equal(Object.prototype.hasOwnProperty.call(data, "empty"), false);
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
  // the last valid JSON-LD block wins, a broken one is skipped
  assert.deepEqual(data["ld+json"], { "@type": "Event" });
});

test("a missing, non-http or overlong q is a 400", async () => {
  for (const q of [
    undefined,
    "",
    "ftp://example.com",
    "javascript:alert(1)",
    "https://" + "a".repeat(2100),
  ]) {
    const res = fakeRes();
    await websiteMetadata({ body: { q } }, res);
    assert.equal(res.code, 400, String(q).slice(0, 30));
  }
});

test("a private or loopback address is never fetched: only the url comes back", async () => {
  for (const q of [
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
  ]) {
    const res = fakeRes();
    await websiteMetadata({ body: { q } }, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.payload, { status: 200, data: { url: q } });
  }
});
