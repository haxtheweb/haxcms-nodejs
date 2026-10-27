"use strict";

// Export -> import round trip for PDF (htmlToPdfBuffer -> convertPdfBufferToHtml).
//
// Regression for: a page with a tall photo exported to a 3-page PDF (the
// photo overflowed a page, so Chrome painted the same image object on two
// pages) in ~8pt Times, and importing that PDF produced two copies of the
// photo. The export now injects a print stylesheet (readable sans body text,
// images capped to half an A4 content area and kept on one page) and the
// importer skips an image it already extracted.
//
// The stylesheet helpers run everywhere; the round trip needs Chrome and is
// skipped without it (same convention as export-endpoints.integration).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const sharp = require("sharp");

const {
  PDF_EXPORT_PRINT_CSS,
  withPdfExportStyles,
  htmlToPdfBuffer,
  findChromeExecutable,
} = require("../../src/lib/convertUtils.js");
const {
  convertPdfBufferToHtml,
} = require("../../src/lib/pdfToSemanticHtml.js");

const CHROME_SKIP = findChromeExecutable()
  ? false
  : "PDF export needs Chrome/Chromium (install it or set PUPPETEER_EXECUTABLE_PATH)";

test("print stylesheet sets readable type and keeps images on one page", () => {
  assert.match(PDF_EXPORT_PRINT_CSS, /@page\s*\{[^}]*size:\s*A4/);
  assert.match(PDF_EXPORT_PRINT_CSS, /body\s*\{[^}]*font-size:\s*11\.5pt/);
  assert.match(PDF_EXPORT_PRINT_CSS, /body\s*\{[^}]*sans-serif/);
  const imgRule = /img,[^{]*\{([^}]*)\}/.exec(PDF_EXPORT_PRINT_CSS);
  assert.ok(imgRule, "has an img rule");
  assert.match(imgRule[1], /max-width:\s*100%/);
  assert.match(imgRule[1], /max-height:\s*130mm/);
  assert.match(imgRule[1], /break-inside:\s*avoid/);
});

test("withPdfExportStyles puts the stylesheet in the head", () => {
  const withHead = withPdfExportStyles(
    '<html><head lang="en"><title>t</title></head><body><p>x</p></body></html>',
  );
  assert.ok(
    withHead.indexOf('<head lang="en"><style>') !== -1,
    "inserted at the start of an existing head",
  );
  assert.equal(withHead.split("<style>").length, 2, "inserted once");
  const noHead = withPdfExportStyles("<p>x</p>");
  assert.ok(noHead.indexOf("<head><style>") === 0, "creates a head");
  assert.ok(noHead.endsWith("<p>x</p>"));
});

test(
  "a page with a tall photo exports to one page and imports with one image",
  { skip: CHROME_SKIP, timeout: 120000 },
  async () => {
    const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-pdf-rt-"));
    try {
      fs.ensureDirSync(path.join(siteDir, "files"));
      // portrait photo at the same aspect as a phone picture (3:4)
      await sharp({
        create: {
          width: 900,
          height: 1200,
          channels: 3,
          background: { r: 200, g: 60, b: 40 },
        },
      })
        .jpeg()
        .toFile(path.join(siteDir, "files", "photo.jpg"));
      const html =
        "<html><head></head><body>" +
        "<h1>Lesson 1: Conclusion</h1>" +
        "<h2>Lesson 1 Conclusion</h2>" +
        "<p>Wrap up Lesson 1 by revisiting the learning objectives.</p>" +
        '<p><img src="files/photo.jpg" alt="team photo"></p>' +
        "<p>Text after the image.</p>" +
        "</body></html>";
      const pdf = await htmlToPdfBuffer(html, "http://localhost/sites/rt/", {
        siteDir: siteDir,
        siteBasePath: "/sites/rt/",
        selfBaseUrl: "http://localhost/sites/rt/",
      });
      assert.ok(pdf.length > 0, "pdf rendered");

      const { getResolvedPDFJS } = require("unpdf");
      const pdfjs = await getResolvedPDFJS();
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(pdf),
        disableWorker: true,
      }).promise;
      assert.equal(
        doc.numPages,
        1,
        "photo is scaled to fit instead of splitting across pages",
      );
      await doc.destroy();

      const imported = await convertPdfBufferToHtml(pdf);
      const parts = imported.split("\n");
      const images = parts.filter((part) => part.indexOf("<img ") === 0);
      assert.equal(
        images.length,
        1,
        imported.replace(/base64,[^"]+/g, "base64,..."),
      );
      // headings survive and the image stays between the paragraphs
      assert.ok(parts.indexOf("<h2>Lesson 1 Conclusion</h2>") !== -1);
      const imageAt = parts.findIndex((part) => part.indexOf("<img ") === 0);
      const afterAt = parts.indexOf("<p>Text after the image.</p>");
      assert.ok(
        afterAt !== -1 && imageAt < afterAt,
        "image before trailing text",
      );
      assert.match(images[0], / width="450">$/);
    } finally {
      fs.removeSync(siteDir);
    }
  },
);
