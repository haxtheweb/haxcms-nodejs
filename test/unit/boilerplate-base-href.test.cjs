"use strict";

// haxtheweb/issues#3202: the boilerplate's first inline script picks the
// site's <base href>. On *.github.io it used the first path segment, so a
// site one folder down (org.github.io/repo/folder/) got /repo/ and loaded
// nothing, and a user/org site at the root got "//". This runs that script
// from both index.html and ghpages.html against sample URLs.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SITE = path.join(__dirname, "..", "..", "src", "boilerplate", "site");

// the first <script> in the file is the base-href script
function baseScript(file) {
  const html = fs.readFileSync(path.join(SITE, file), "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, file + " has an inline base script");
  return match[1];
}

function baseFor(file, url) {
  const u = new URL(url);
  let written = "";
  const location = {
    hostname: u.hostname,
    host: u.host,
    pathname: u.pathname,
    href: u.href,
  };
  const document = {
    location: location,
    write: function (s) {
      written += s;
    },
    querySelectorAll: function () {
      return [];
    },
  };
  vm.runInNewContext(baseScript(file), {
    document: document,
    globalThis: { location: location },
  });
  const m = written.match(/<base href='([^']*)'/);
  assert.ok(m, "wrote a <base> for " + url);
  return m[1];
}

for (const file of ["ghpages.html", "index.html"]) {
  describe(file + " base href", () => {
    test("a project page at the repo root keeps /repo/", () => {
      assert.equal(baseFor(file, "https://org.github.io/repo/"), "/repo/");
      assert.equal(
        baseFor(file, "https://org.github.io/repo/?p=/some/page"),
        "/repo/",
      );
      assert.equal(
        baseFor(file, "https://org.github.io/repo/index.html"),
        "/repo/",
      );
    });

    test("a site in a subfolder of a project page gets its own folder", () => {
      assert.equal(
        baseFor(file, "https://haxtheweb.github.io/art/hax-art/"),
        "/art/hax-art/",
      );
      assert.equal(
        baseFor(file, "https://haxtheweb.github.io/art/hax-art/?p=/brand"),
        "/art/hax-art/",
      );
      assert.equal(
        baseFor(file, "https://org.github.io/repo/a/b/site/"),
        "/repo/a/b/site/",
      );
    });

    test("a user or org site at the root gets / (it used to get //)", () => {
      assert.equal(baseFor(file, "https://org.github.io/"), "/");
      assert.equal(baseFor(file, "https://org.github.io/?p=/page"), "/");
    });

    test("other hosts are unchanged", () => {
      assert.equal(baseFor(file, "https://example.test/"), "/");
      assert.equal(
        baseFor(file, "https://example.test/_sites/mysite/page"),
        "/_sites/mysite/",
      );
      assert.equal(
        baseFor(file, "https://example.test/sites/mysite/"),
        "/sites/mysite/",
      );
      // a look-alike host is not GitHub Pages
      assert.equal(
        baseFor(file, "https://github.io.example.test/repo/folder/"),
        "/",
      );
    });
  });
}
