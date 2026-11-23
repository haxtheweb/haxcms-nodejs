"use strict";

// The magic script loaders (build.js, build-haxcms.js) come from the
// webcomponents build, which writes them to exactly two places here: the
// server's own copy (src/public) and the copy stamped into every site
// (src/boilerplate/site). Any other copy is never rebuilt, so it goes stale
// while still being served (haxtheweb/issues#3337).
//  - the two places hold the same bytes,
//  - no other copy exists outside the build/ module tree,
//  - build.js fails over on a timeout as well as on an error,
//  - build-haxcms.js does not add theme/theme.css.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "src");
const LOADERS = ["build.js", "build-haxcms.js"];
const HOMES = ["public", "boilerplate/site"];

// every loader-named file under dir, as paths relative to src/, skipping the
// build/ module tree (its files are modules that happen to share a name)
function findLoaders(dir, found) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "build" && entry.name !== "node_modules") {
        findLoaders(full, found);
      }
    } else if (LOADERS.indexOf(entry.name) !== -1) {
      found.push(path.relative(SRC, full).split(path.sep).join("/"));
    }
  }
  return found;
}

function read(relativePath) {
  return fs.readFileSync(path.join(SRC, relativePath), "utf8");
}

describe("magic script loader copies", () => {
  test("only the server copy and the site boilerplate copy exist", () => {
    const expected = [];
    for (const home of HOMES) {
      for (const loader of LOADERS) {
        expected.push(home + "/" + loader);
      }
    }
    const found = findLoaders(path.join(SRC, "public"), []).concat(
      findLoaders(path.join(SRC, "boilerplate"), []),
    );
    assert.deepEqual(found.sort(), expected.sort());
  });

  for (const loader of LOADERS) {
    test(loader + " is the same file in both places", () => {
      assert.equal(
        read("public/" + loader),
        read("boilerplate/site/" + loader),
      );
    });
  }

  test("build.js moves to the next CDN on a timeout", () => {
    assert.ok(read("public/build.js").indexOf("WCGlobalCDNTimeout") !== -1);
  });

  test("build-haxcms.js does not add theme/theme.css", () => {
    assert.equal(read("public/build-haxcms.js").indexOf("theme/theme.css"), -1);
  });
});
