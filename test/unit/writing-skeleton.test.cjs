"use strict";

// The writing skeleton (haxtheweb/issues#3062) sets up the structure
// writing-theme reads: Home, About and Archive as the nav row, and a Posts
// page (out of the menu) that every post goes under. Same file in haxcms-php.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const coreConfig = path.join(__dirname, "..", "..", "src", "coreConfig");
const skeleton = require(path.join(coreConfig, "skeletons", "writing.json"));
const themes = require(path.join(coreConfig, "themes.json"));

const items = skeleton.build.items;
const top = items.filter((item) => item.parent === null);
const bySlug = (slug) => items.find((item) => item.slug === slug);

test("writing skeleton uses the registered writing-theme", () => {
  assert.equal(skeleton.meta.name, "writing");
  assert.equal(skeleton.site.theme, "writing-theme");
  assert.ok(themes["writing-theme"]);
  assert.equal(
    themes["writing-theme"].path,
    "@haxtheweb/writing-theme/writing-theme.js",
  );
  assert.equal(skeleton.build.structure, "from-skeleton");
});

test("top level is Home, About, Archive, then Posts out of the menu", () => {
  assert.deepEqual(
    top.sort((a, b) => a.order - b.order).map((item) => item.slug),
    ["home", "about", "archive", "posts"],
  );
  assert.equal(bySlug("posts").metadata.hideInMenu, true);
  // the home page's content stands in for a title, so the title is hidden
  assert.equal(bySlug("home").metadata.hideTitle, true);
});

// posts carry no dates: a new site's pages are all created when the site is,
// and the outline order keeps the newest first
test("every other page is a post under Posts", () => {
  const posts = items.filter((item) => item.parent !== null);
  assert.ok(posts.length >= 3);
  const postsId = bySlug("posts").id;
  posts.forEach((post) => {
    assert.equal(post.parent, postsId);
    assert.ok(post.slug.startsWith("posts/"));
    assert.ok(Array.isArray(post.metadata.tags));
  });
});

test("ids are unique", () => {
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
});

// New installs offer the new blocks in the block picker: the picker's list is
// the appStore autoloader in the system setup config (not
// dynamicElementLoader.json), copied into _config/config.json on install.
test("new installs offer a11y-footnote and ddd-hero in the block picker", () => {
  const config = require(
    path.join(
      __dirname,
      "..",
      "..",
      "src",
      "boilerplate",
      "systemsetup",
      "config.json",
    ),
  );
  const autoloader = config.appStore.autoloader;
  assert.equal(
    autoloader["a11y-footnote"],
    "@haxtheweb/a11y-footnote/a11y-footnote.js",
  );
  assert.equal(autoloader["ddd-hero"], "@haxtheweb/d-d-d/lib/ddd-hero.js");
});
