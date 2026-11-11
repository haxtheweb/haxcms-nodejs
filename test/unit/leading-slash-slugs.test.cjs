"use strict";

// Page slugs and the leading "/" (haxtheweb/issues#3309)
//
// getUniqueSlugName builds a slug from its non-empty "/" segments, so a new
// slug never starts with "/" or holds "//". Sites saved before that can
// already hold a slug like "/child-1": they are not rewritten, and a lookup
// by the path without the leading "/" still finds the page (an exact slug
// match always wins).
//
// Parity: haxcms-php carries the same scenarios in LeadingSlashSlugsTest.php.
// CommonJS, NO optional chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.haxcms_middleware = "node-cli";

const {
  joinSlugSegments,
  legacySlugMatches,
} = require("../../src/lib/slugRules.js");
const {
  findItemByIdOrSlug,
} = require("../../src/siteRoutes/v1/siteRouteUtils.js");

function siteWith(items) {
  return {
    manifest: {
      items: items,
      getItemById(id) {
        return items.find((i) => i.id === id) || false;
      },
      getItemByProperty(prop, value) {
        return items.find((i) => i[prop] === value) || false;
      },
    },
  };
}

test("joinSlugSegments: empty segments are dropped", () => {
  assert.equal(joinSlugSegments("/child-1"), "child-1");
  assert.equal(joinSlugSegments("grand//child"), "grand/child");
  assert.equal(joinSlugSegments("//a///b/"), "a/b");
  assert.equal(joinSlugSegments("parent/child"), "parent/child");
  assert.equal(joinSlugSegments(""), "");
});

test("legacySlugMatches: only a stored slug with a leading '/' matches without it", () => {
  assert.equal(legacySlugMatches("/child-1", "child-1"), true);
  assert.equal(legacySlugMatches("/child-1", "/child-1"), true);
  assert.equal(legacySlugMatches("child-1", "child-1"), false);
  assert.equal(legacySlugMatches("/child-1", "child-2"), false);
  assert.equal(legacySlugMatches("/", ""), false);
  assert.equal(legacySlugMatches(undefined, "child-1"), false);
});

test("findItemByIdOrSlug: a page saved with a leading '/' slug is found", () => {
  const site = siteWith([
    { id: "a", slug: "parent" },
    { id: "b", slug: "/child-1" },
  ]);
  assert.equal(findItemByIdOrSlug(site, "child-1").id, "b");
  assert.equal(findItemByIdOrSlug(site, "/child-1").id, "b");
});

test("findItemByIdOrSlug: an exact slug match wins over a leading '/' one", () => {
  const site = siteWith([
    { id: "legacy", slug: "/child-1" },
    { id: "exact", slug: "child-1" },
  ]);
  assert.equal(findItemByIdOrSlug(site, "child-1").id, "exact");
});
