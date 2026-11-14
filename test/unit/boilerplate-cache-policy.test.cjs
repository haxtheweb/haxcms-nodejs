"use strict";

// The site boilerplate is the source of truth for both backends: the ubiquity
// build copies it over haxcms-php's system/boilerplate. A PHP-served site reads
// its browser cache policy from the boilerplate .htaccess and index.php, so
// they must state the same policy haxcms-nodejs serves in code:
//  - build modules (build/...) are reused for at most an hour,
//  - everything else is revalidated on every use,
//  - nothing gets a blanket lifetime (no mod_expires default),
//  - responses PHP answers keep their own Cache-Control (setifempty).
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SITE = path.join(__dirname, "..", "..", "src", "boilerplate", "site");
const htaccess = fs.readFileSync(path.join(SITE, ".htaccess"), "utf8");
const indexPhp = fs.readFileSync(path.join(SITE, "index.php"), "utf8");

// the <If> expression that picks the hour-long responses, as JS regexes
function hourLongMatcher() {
  const rule = htaccess.match(
    /<If "([^"]*)">\s*Header setifempty Cache-Control "public, max-age=3600"\s*<\/If>\s*<Else>\s*Header setifempty Cache-Control "public, max-age=0"\s*<\/Else>/,
  );
  assert.ok(rule, "the hour-long / revalidate rule pair is present");
  const parts = rule[1].split("&&").map(function (part) {
    const m = part.trim().match(/^%\{REQUEST_URI\} (=~|!~) m#(.*)#$/);
    assert.ok(m, "condition is a REQUEST_URI match: " + part);
    return { negate: m[1] === "!~", regex: new RegExp(m[2]) };
  });
  return function (uri) {
    return parts.every(function (part) {
      return part.regex.test(uri) !== part.negate;
    });
  };
}

describe("site boilerplate browser cache policy", () => {
  test(".htaccess sets no blanket lifetime", () => {
    assert.equal(htaccess.includes("ExpiresDefault"), false);
    assert.equal(htaccess.includes("ExpiresActive On"), false);
  });

  test("only build modules are reused for an hour", () => {
    const hourLong = hourLongMatcher();
    const reused = [
      "/build/es6/node_modules/@haxtheweb/haxcms-elements/lib/core/haxcms-site-builder.js",
      "/sites/demo/build/es6/node_modules/lit/index.js",
    ];
    const revalidated = [
      "/site.json",
      "/sites/demo/site.json",
      "/sites/demo/pages/abc/index.html",
      "/sites/demo/files/build/photo.jpg",
      "/sites/demo/custom/build/custom.es6.js",
      "/sites/demo/build.js",
      "/wc-registry.json",
      "/build/es6/wc-registry.json",
      "/build/es6/wc-registry-graph.json",
    ];
    for (let i = 0; i < reused.length; i++) {
      assert.equal(hourLong(reused[i]), true, reused[i]);
    }
    for (let i = 0; i < revalidated.length; i++) {
      assert.equal(hourLong(revalidated[i]), false, revalidated[i]);
    }
  });

  test("index.php sends the uncached page headers when HAXCMS is loaded", () => {
    assert.match(
      indexPhp,
      /HAXCMS::sendUncachedResponseHeaders\(HAXCMS::requestCarriesCredentials\(\)\)/,
    );
  });
});
