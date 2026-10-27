"use strict";

// CodeQL triage follow-up: URL host matching instead of substring checks,
// global bracket stripping, and linear-time trailing-slash trimming.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("node-html-parser");
const { urlHostMatches } = require("../../src/lib/urlHost.js");
const { htmlFromEl } = require("../../src/lib/convertUtils.js");
const {
  getServerBaseUrl,
} = require("../../src/siteRoutes/discovery/openapi.js");

function el(text) {
  return parse(`<div id="w"><p>${text}</p></div>`).querySelector("#w")
    .firstChild;
}

test("urlHostMatches matches the host and its subdomains only", () => {
  const hosts = ["youtube.com", "youtu.be"];
  assert.equal(urlHostMatches("https://youtube.com/watch?v=x", hosts), true);
  assert.equal(
    urlHostMatches("https://www.youtube.com/watch?v=x", hosts),
    true,
  );
  assert.equal(urlHostMatches("//m.youtube.com/embed/x", hosts), true);
  assert.equal(urlHostMatches("https://youtu.be/x", hosts), true);
  assert.equal(urlHostMatches("https://YOUTUBE.COM/x", hosts), true);
});

test("urlHostMatches rejects look-alikes, non-http schemes and junk", () => {
  const hosts = ["youtube.com"];
  assert.equal(
    urlHostMatches("https://evil.example/?u=youtube.com", hosts),
    false,
  );
  assert.equal(
    urlHostMatches("https://youtube.com.evil.example/x", hosts),
    false,
  );
  assert.equal(urlHostMatches("https://notyoutube.com/x", hosts), false);
  assert.equal(urlHostMatches("javascript:alert('youtube.com')", hosts), false);
  assert.equal(urlHostMatches("/embed/youtube.com", hosts), false);
  assert.equal(urlHostMatches("", hosts), false);
  assert.equal(urlHostMatches(undefined, hosts), false);
});

test("htmlFromEl only maps real video hosts to <video-player>", () => {
  assert.match(
    htmlFromEl(el("https://www.youtube.com/watch?v=abc")),
    /^<video-player source="https:\/\/www\.youtube\.com\/watch\?v=abc">/,
  );
  assert.doesNotMatch(
    htmlFromEl(el("https://evil.example/page?next=youtube.com")),
    /<video-player/,
  );
});

test("htmlFromEl strips every bracket from a bracketed URL", () => {
  assert.match(
    htmlFromEl(el("[[https://youtu.be/abc]]")),
    /^<video-player source="https:\/\/youtu\.be\/abc">/,
  );
});

test("getServerBaseUrl trims a long run of trailing slashes quickly", () => {
  const req = {
    originalUrl: "/_sites/x" + "/".repeat(100000) + "/x/api",
    baseUrl: "",
    url: "/x/api",
    headers: {},
  };
  const start = Date.now();
  try {
    getServerBaseUrl(req);
  } catch (e) {
    // request shape is only a stand-in; the point is the time bound below
  }
  assert.ok(Date.now() - start < 1000);
});

test("getApiBasePathFromRequestPath matches the old regex and is linear", () => {
  const {
    getApiBasePathFromRequestPath,
  } = require("../../src/siteRoutes/v1/siteRouteUtils.js");
  const oldImpl = (p) => {
    const m = String(p || "").match(/^(.*\/x\/api)(?:\/.*)?$/);
    return m && m[1] ? m[1] : "/x/api";
  };
  const cases = [
    "",
    "/x/api",
    "/x/api/",
    "/x/api/v1/items",
    "/a/x/api/b/x/api/c",
    "/a/x/apix/b",
    "/x/apiary",
    "/foo/x/api/v1/x/api",
    "/foo/x/api\nbar",
    "/foo\n/x/api/v1",
    "/foo/x/api/v1\n",
    "no-slash",
  ];
  for (const c of cases) {
    assert.equal(
      getApiBasePathFromRequestPath(c),
      oldImpl(c),
      JSON.stringify(c),
    );
  }
  const long = "/x/apx".repeat(50000);
  const start = Date.now();
  assert.equal(getApiBasePathFromRequestPath(long), "/x/api");
  assert.ok(Date.now() - start < 1000);
});

test("[type: text] placeholders drop only the outer brackets", () => {
  const out = htmlFromEl(el("[text: a[1]+b]"));
  assert.match(out, /text="a\[1\]\+b"/);
});
