"use strict";

// Accessibility invariants for exported documents (haxtheweb/issues#3376):
// exported HTML declares the site language and direction, and an embedded
// video frame always carries a title. Mirrored in haxcms-php ExportA11yTest.

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  getSiteExportLang,
  getExportLangDirAttributes,
  normalizeHtmlForDocumentExport,
} = require("../../src/siteRoutes/v1/exports.js");

function siteWithLang(lang) {
  return { manifest: { metadata: { site: { settings: { lang } } } } };
}

describe("export language and direction", () => {
  test("uses the site language", () => {
    assert.equal(getSiteExportLang(siteWithLang("es-MX")), "es-MX");
  });

  test("falls back to en when the site has no language", () => {
    assert.equal(getSiteExportLang({}), "en");
    assert.equal(getSiteExportLang(siteWithLang("")), "en");
  });

  test("keeps only BCP 47 characters", () => {
    assert.equal(getSiteExportLang(siteWithLang('fr"><script>')), "frscript");
  });

  test('right-to-left languages get dir="rtl"', () => {
    assert.equal(getExportLangDirAttributes("ar"), 'lang="ar" dir="rtl"');
    assert.equal(getExportLangDirAttributes("he-IL"), 'lang="he-IL" dir="rtl"');
    assert.equal(getExportLangDirAttributes("en"), 'lang="en" dir="ltr"');
  });
});

describe("exported video frames have a title", () => {
  test("uses the video title when there is one", () => {
    const html =
      '<video-player source="https://www.youtube.com/watch?v=abc123" media-title="Intro to HAX"></video-player>';
    const out = normalizeHtmlForDocumentExport(html, "/site/", [], "epub");
    assert.ok(out.indexOf("<iframe") !== -1, "iframe present");
    assert.ok(
      out.indexOf('title="Intro to HAX"') !== -1,
      "title from media-title",
    );
  });

  test("falls back to a generic title", () => {
    const html =
      '<video-player source="https://www.youtube.com/watch?v=abc123"></video-player>';
    const out = normalizeHtmlForDocumentExport(html, "/site/", [], "epub");
    assert.ok(out.indexOf('title="Video"') !== -1, "generic title");
  });

  test("escapes the title", () => {
    const html =
      '<video-player source="https://www.youtube.com/watch?v=abc123" media-title="a &quot;b&quot; <c>"></video-player>';
    const out = normalizeHtmlForDocumentExport(html, "/site/", [], "epub");
    assert.ok(out.indexOf("<c>") === -1, "no raw markup from title");
  });
});
