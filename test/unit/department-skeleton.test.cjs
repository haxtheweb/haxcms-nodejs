"use strict";

// The department skeleton (haxtheweb/issues#3368): a university department,
// office or center on polaris-flex-sidebar, with About, Services, People,
// News, Contact, and a Privacy page out of the menu. Same file in haxcms-php
// (DepartmentSkeletonTest).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const coreConfig = path.join(__dirname, "..", "..", "src", "coreConfig");
const themes = require(path.join(coreConfig, "themes.json"));
const skeleton = require(path.join(coreConfig, "skeletons", "department.json"));
const items = skeleton.build.items;
const bySlug = (slug) => items.find((item) => item.slug === slug);
const top = items.filter((item) => item.parent === null);

test("department skeleton uses the registered polaris-flex-sidebar", () => {
  assert.equal(skeleton.meta.name, "department");
  assert.equal(skeleton.meta.type, "skeleton");
  assert.equal(skeleton.site.theme, "polaris-flex-sidebar");
  assert.ok(themes["polaris-flex-sidebar"]);
  assert.equal(skeleton.build.structure, "from-skeleton");
  assert.ok(
    skeleton.meta.useCaseImage.includes("theme-polaris-flex-sidebar-thumb"),
  );
});

test("top level pages, in order", () => {
  assert.deepEqual(
    top.sort((a, b) => a.order - b.order).map((item) => item.slug),
    ["home", "about", "services", "people", "news", "contact", "privacy"],
  );
});

test("Services and News hold their pages, in order", () => {
  ["services", "news"].forEach((section) => {
    const parent = bySlug(section);
    const children = items.filter((item) => item.parent === parent.id);
    assert.ok(children.length >= 2, section);
    children.forEach((child, index) => {
      assert.ok(child.slug.startsWith(section + "/"));
      assert.equal(child.indent, 1);
      assert.equal(child.order, index);
    });
  });
});

test("Privacy is out of the menu and linked from Contact", () => {
  assert.equal(bySlug("privacy").metadata.hideInMenu, true);
  assert.ok(bySlug("contact").content.includes('href="privacy"'));
  assert.ok(bySlug("privacy").content.includes('href="contact"'));
});

test("every person on People uses the same card", () => {
  const people = bySlug("people").content;
  const cards = people.match(/<collection-item [^>]*>/g) || [];
  assert.ok(cards.length >= 3);
  cards.forEach((card) => {
    ["icon=", "line1=", "line2=", "line3=", 'url="mailto:'].forEach((attr) =>
      assert.ok(card.includes(attr), card),
    );
  });
});

test("ids and slugs are unique, every page is published with content, nothing is pulled from other sites", () => {
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.equal(new Set(items.map((item) => item.slug)).size, items.length);
  items.forEach((item) => {
    assert.equal(item.metadata.published, true);
    assert.ok(Array.isArray(item.metadata.tags));
    assert.notEqual(item.content, "");
    // links stay inside the site (relative to its base) or are mailto
    (item.content.match(/(href|link|src|source|image)="[^"]*"/g) || []).forEach(
      (attr) => {
        const value = attr.replace(/^[a-z]+="|"$/g, "");
        assert.ok(
          value.startsWith("mailto:") || !/^[a-z]+:|^\/\/|^\.\./i.test(value),
          item.slug + ": " + attr,
        );
      },
    );
  });
});
