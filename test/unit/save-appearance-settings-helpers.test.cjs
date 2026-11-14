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
