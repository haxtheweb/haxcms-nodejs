"use strict";

// docx-to-html with the page the document goes into (haxtheweb/issues#3058).
//
// "Insert docx contents in Page" posts a document for the open page. With
// siteName + itemId naming a real page, images in the document are saved as
// files of that site, named after the page, and the HTML points at them.
// Without a page (or with one that does not resolve) images stay inline data
// URIs, as before.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs-extra");
const os = require("os");

const { HAXCMS, HAXCMSSite } = require("../../src/lib/HAXCMS.js");
// the library itself: the export helper drops data: images on purpose
const HTMLtoDOCX = require("html-to-docx");
const {
  convertDocxToHtml,
} = require("../../src/systemRoutes/v1/routes/convertDocxToHtml.js");

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function makeTempSite() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hax-docx-"));
  const siteDirectory = path.join(tmpRoot, "testsite");
  await fs.ensureDir(path.join(siteDirectory, "files"));
  const site = new HAXCMSSite();
  site.name = "testsite";
  site.siteDirectory = siteDirectory;
  site.manifest = {
    metadata: { site: { name: "testsite" } },
    items: [{ id: "item-1", title: "Intro to HAX", metadata: {} }],
  };
  return { tmpRoot, site, siteDirectory };
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };
  res.json = function (body) {
    res.body = body;
    return res;
  };
  return res;
}

async function docxWithImage(dir) {
  const buffer = await HTMLtoDOCX(
    '<p>Before</p><p><img alt="Red" src="data:image/png;base64,' +
      PNG_BASE64 +
      '" width="1" height="1"></p>',
    null,
    {},
  );
  const file = path.join(dir, "upload.docx");
  await fs.writeFile(file, buffer);
  return file;
}

function savedImages(siteDirectory) {
  return fs
    .readdirSync(path.join(siteDirectory, "files"))
    .filter((name) => /\.(png|jpg|gif|webp)$/.test(name));
}

describe("docx-to-html page images — #3058", () => {
  let ctx;
  let uploadPath;
  let realLoadSite;

  beforeEach(async () => {
    ctx = await makeTempSite();
    uploadPath = await docxWithImage(ctx.tmpRoot);
    realLoadSite = HAXCMS.loadSite;
    HAXCMS.loadSite = async (name) => (name === "testsite" ? ctx.site : false);
  });

  afterEach(async () => {
    HAXCMS.loadSite = realLoadSite;
    try {
      await fs.remove(ctx.tmpRoot);
    } catch {
      // intentionally ignored
    }
  });

  function request(body) {
    return {
      files: [{ originalname: "upload.docx", path: uploadPath }],
      body: body,
    };
  }

  test("the document has an inline image to work with", async () => {
    const res = mockRes();
    await convertDocxToHtml(request({}), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.data.contents, /src="data:image\/png;base64,/);
  });

  test("with a page, images are saved as site files named after it", async () => {
    const res = mockRes();
    await convertDocxToHtml(
      request({ siteName: "testsite", itemId: "item-1" }),
      res,
    );
    assert.equal(res.statusCode, 200);
    const html = res.body.data.contents;
    assert.doesNotMatch(html, /data:image/);
    const files = savedImages(ctx.siteDirectory);
    assert.equal(files.length, 1);
    assert.match(files[0], /^intro-to-hax\./);
    assert.ok(html.includes(files[0]), "the HTML points at the saved file");
  });

  test("an item that is not in the site leaves images inline", async () => {
    const res = mockRes();
    await convertDocxToHtml(
      request({ siteName: "testsite", itemId: "nope" }),
      res,
    );
    assert.match(res.body.data.contents, /src="data:image\/png;base64,/);
    assert.equal(savedImages(ctx.siteDirectory).length, 0);
  });

  test("a site that does not load leaves images inline", async () => {
    const res = mockRes();
    await convertDocxToHtml(
      request({ siteName: "other", itemId: "item-1" }),
      res,
    );
    assert.match(res.body.data.contents, /src="data:image\/png;base64,/);
    assert.equal(savedImages(ctx.siteDirectory).length, 0);
  });

  test("only siteName, or only itemId, is no page", async () => {
    for (const body of [{ siteName: "testsite" }, { itemId: "item-1" }]) {
      const res = mockRes();
      await convertDocxToHtml(request(body), res);
      assert.match(res.body.data.contents, /src="data:image\/png;base64,/);
    }
    assert.equal(savedImages(ctx.siteDirectory).length, 0);
  });
});
