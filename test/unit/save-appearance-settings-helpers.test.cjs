"use strict";

// Unit tests for the pure module-scope helper functions attached as named
// properties on the saveAppearanceSettings handler export.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require("node:test");
const { describe } = require("node:test");
const assert = require("node:assert/strict");

const saveAppearanceSettings = require("../../src/siteRoutes/v1/routes/saveAppearanceSettings.js");

const { normalizeCssVariable, sanitizeRegionIds } = saveAppearanceSettings;

describe("saveAppearanceSettings.normalizeCssVariable", () => {
  test("strips the --simple-colors-default-theme- prefix and trailing -7", () => {
    assert.equal(
      normalizeCssVariable("--simple-colors-default-theme-blue-7"),
      "blue",
    );
  });

  test("lowercases the resulting value", () => {
    assert.equal(
      normalizeCssVariable("--simple-colors-default-theme-BLUE-7"),
      "blue",
    );
  });

  test("handles a value without the known prefix/suffix", () => {
    assert.equal(normalizeCssVariable("purple"), "purple");
  });

  test("rejects values that contain invalid characters after normalization", () => {
    assert.equal(
      normalizeCssVariable("--simple-colors-default-theme-blue!!-7"),
      null,
    );
    assert.equal(normalizeCssVariable("has spaces"), null);
    assert.equal(normalizeCssVariable(""), null);
  });

  test("rejects non-string input", () => {
    assert.equal(normalizeCssVariable(null), null);
    assert.equal(normalizeCssVariable(undefined), null);
    assert.equal(normalizeCssVariable(42), null);
    assert.equal(normalizeCssVariable({}), null);
  });
});

describe("saveAppearanceSettings.sanitizeRegionIds", () => {
  test("dedups repeated ids via Set", () => {
    assert.deepEqual(sanitizeRegionIds(["a", "b", "a"]), ["a", "b"]);
  });

  test("trims whitespace around ids", () => {
    assert.deepEqual(sanitizeRegionIds([" a ", "b"]), ["a", "b"]);
  });

  test("rejects non-array input", () => {
    assert.equal(sanitizeRegionIds("a,b"), null);
    assert.equal(sanitizeRegionIds(null), null);
    assert.equal(sanitizeRegionIds(undefined), null);
    assert.equal(sanitizeRegionIds({}), null);
  });

  test("rejects an array containing any non-string element", () => {
    assert.equal(sanitizeRegionIds(["a", 1]), null);
    assert.equal(sanitizeRegionIds(["a", null]), null);
    assert.equal(sanitizeRegionIds(["a", {}]), null);
  });

  test("rejects an array containing an empty-string element (after trim)", () => {
    assert.equal(sanitizeRegionIds(["a", ""]), null);
    assert.equal(sanitizeRegionIds(["a", "   "]), null);
  });

  test("returns an empty array for an empty input array", () => {
    assert.deepEqual(sanitizeRegionIds([]), []);
  });
});

describe("saveAppearanceSettings.normalizeDesignSystem", () => {
  const { normalizeDesignSystem } = saveAppearanceSettings;

  test("keeps a lowercase design system name", () => {
    assert.equal(normalizeDesignSystem("carbon"), "carbon");
    assert.equal(normalizeDesignSystem(" PatternFly "), "patternfly");
    assert.equal(normalizeDesignSystem("web-awesome-2"), "web-awesome-2");
  });

  test('treats empty, null and "ddd" as DDD (no value stored)', () => {
    assert.equal(normalizeDesignSystem(""), "");
    assert.equal(normalizeDesignSystem(null), "");
    assert.equal(normalizeDesignSystem("DDD"), "");
  });

  test("rejects anything that is not a plain name", () => {
    assert.equal(normalizeDesignSystem("../carbon"), null);
    assert.equal(normalizeDesignSystem("@haxtheweb/carbon-theme"), null);
    assert.equal(normalizeDesignSystem("a".repeat(65)), null);
    assert.equal(normalizeDesignSystem(42), null);
    assert.equal(normalizeDesignSystem({ name: "carbon" }), null);
  });
});

describe("saveAppearanceSettings.normalizeAnnouncement", () => {
  const { normalizeAnnouncement } = saveAppearanceSettings;
  const f = (key) => "manifest-metadata-theme-announcement-" + key;

  test("builds a full announcement with defaults", () => {
    assert.deepEqual(
      normalizeAnnouncement(
        {
          [f("title")]: "Spring sections open Monday.",
          [f("text")]: "Registration closes January 9.",
          [f("link")]: "https://example.com/dates",
          [f("linkText")]: "See dates",
          [f("ends")]: "2027-01-09",
        },
        null,
      ),
      {
        title: "Spring sections open Monday.",
        text: "Registration closes January 9.",
        link: "https://example.com/dates",
        linkText: "See dates",
        variant: "brand",
        ends: "2027-01-09",
      },
    );
  });

  test("keeps text plain: no angle brackets or control characters", () => {
    const a = normalizeAnnouncement(
      { [f("title")]: "<b>Open</b>\nnow", [f("text")]: "Q&A" },
      null,
    );
    assert.equal(a.title, "b Open /b now");
    assert.equal(a.text, "Q&A");
  });

  test("caps text lengths", () => {
    const a = normalizeAnnouncement({ [f("text")]: "x".repeat(900) }, null);
    assert.equal(a.text.length, 500);
  });

  test("drops unsafe links", () => {
    const a = normalizeAnnouncement(
      { [f("title")]: "Hi", [f("link")]: "javascript:alert(1)" },
      null,
    );
    assert.equal(a.link, "");
  });

  test("updates only the fields sent", () => {
    const a = normalizeAnnouncement(
      { [f("variant")]: "warning" },
      {
        title: "Hi",
        text: "",
        link: "",
        linkText: "",
        variant: "brand",
        ends: "",
      },
    );
    assert.equal(a.title, "Hi");
    assert.equal(a.variant, "warning");
  });

  test("no title and no text means no announcement", () => {
    assert.equal(
      normalizeAnnouncement(
        { [f("title")]: "", [f("text")]: "" },
        { title: "Hi" },
      ),
      null,
    );
  });

  test("refuses bad variants, dates and types", () => {
    assert.equal(
      normalizeAnnouncement({ [f("variant")]: "pink" }, null),
      false,
    );
    assert.equal(
      normalizeAnnouncement({ [f("ends")]: "next week" }, null),
      false,
    );
    assert.equal(normalizeAnnouncement({ [f("title")]: 42 }, null), false);
    assert.equal(normalizeAnnouncement({ [f("link")]: {} }, null), false);
  });
});
