"use strict";

// The Academic and Landing Page skeletons (haxtheweb/issues#3365) start a
// site on al-folio-theme and astrowind-theme. Both themes list the pages
// under the active page, so each skeleton keeps one section page (Projects,
// Services) whose pages become that list. Same files in haxcms-php
// (HomageSkeletonsTest).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const coreConfig = path.join(__dirname, "..", "..", "src", "coreConfig");
const themes = require(path.join(coreConfig, "themes.json"));

const CASES = [
  {
    file: "academic.json",
    name: "academic",
    theme: "al-folio-theme",
    themePath: "@haxtheweb/papermod-theme/lib/al-folio-theme.js",
    top: [
      "about",
      "publications",
      "projects",
      "teaching",
      "people",
      "contact",
      "privacy",
    ],
    section: "projects",
  },
  {
    file: "landing-page.json",
    name: "landing-page",
    theme: "astrowind-theme",
    themePath: "@haxtheweb/papermod-theme/lib/astrowind-theme.js",
    top: ["home", "services", "pricing", "about", "contact", "privacy"],
    section: "services",
  },
];

for (const c of CASES) {
  const skeleton = require(path.join(coreConfig, "skeletons", c.file));
  const items = skeleton.build.items;
  const bySlug = (slug) => items.find((item) => item.slug === slug);

  test(`${c.name} skeleton uses the registered ${c.theme}`, () => {
    assert.equal(skeleton.meta.name, c.name);
    assert.equal(skeleton.meta.type, "skeleton");
    assert.equal(skeleton.site.theme, c.theme);
    assert.ok(themes[c.theme]);
    assert.equal(themes[c.theme].path, c.themePath);
    assert.equal(skeleton.build.structure, "from-skeleton");
    assert.match(
      skeleton.meta.useCaseImage,
      new RegExp(`theme-${c.theme}-thumb`),
    );
  });

  test(`${c.name}: top level pages, in order`, () => {
    assert.deepEqual(
      items
        .filter((item) => item.parent === null)
        .sort((a, b) => a.order - b.order)
        .map((item) => item.slug),
      c.top,
    );
  });

  // haxtheweb/issues#3368: Privacy stays out of the menu; Contact links to it
  test(`${c.name}: Privacy is out of the menu and linked from Contact`, () => {
    assert.equal(bySlug("privacy").metadata.hideInMenu, true);
    assert.equal(bySlug("contact").metadata.hideInMenu, false);
    assert.ok(bySlug("contact").content.includes('href="privacy"'));
    assert.ok(bySlug("privacy").content.includes('href="contact"'));
  });

  test(`${c.name}: the ${c.section} page has the pages the theme lists`, () => {
    const section = bySlug(c.section);
    const children = items.filter((item) => item.parent === section.id);
    assert.ok(children.length >= 3);
    children.forEach((child, index) => {
      assert.ok(child.slug.startsWith(`${c.section}/`));
      assert.equal(child.indent, 1);
      assert.equal(child.order, index);
    });
    // every other page is top level
    assert.equal(
      items.filter((item) => item.parent !== null).length,
      children.length,
    );
  });

  test(`${c.name}: ids and slugs are unique, every page is published with content`, () => {
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    assert.equal(new Set(items.map((item) => item.slug)).size, items.length);
    items.forEach((item) => {
      assert.equal(item.metadata.published, true);
      assert.ok(Array.isArray(item.metadata.tags));
      assert.ok(item.content.length > 0);
    });
  });

  // images aren't bundled with skeletons, and a starter must not hotlink them
  test(`${c.name}: no media is pulled from other sites`, () => {
    items.forEach((item) => {
      assert.doesNotMatch(item.content, /<(img|media-image|video|iframe)\b/);
      assert.doesNotMatch(item.content, /(src|source)="https?:/);
    });
  });
}

test("the landing page's home hides its title: its headline stands in for it", () => {
  const skeleton = require(
    path.join(coreConfig, "skeletons", "landing-page.json"),
  );
  const home = skeleton.build.items.find((item) => item.slug === "home");
  assert.equal(home.metadata.hideTitle, true);
});
