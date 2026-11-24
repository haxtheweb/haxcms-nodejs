"use strict";

// Unit tests for src/lib/pptxToHtml.js (the .pptx importer's converter) and
// the importPptx / convertPptxToHtml routes that use it.
//
// Parity: haxcms-php runs the same fixture (tests/fixtures/pptx/rich-deck.pptx)
// and the same expected HTML in tests/Unit/PptxToHtmlTest.php.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");

const { convertPptxBufferToHtml } = require("../../src/lib/pptxToHtml.js");
const {
  importPptx,
} = require("../../src/systemRoutes/v1/routes/importPptx.js");

const RICH_DECK = path.join(
  __dirname,
  "..",
  "fixtures",
  "pptx",
  "rich-deck.pptx",
);
const RICH_EXPECTED =
  "<h1>Rich &amp; &lt;bold&gt;</h1>\n" +
  "<ol><li>Step one</li><li>Step two<ul><li>Sub bullet</li></ul></li></ol>\n" +
  "<p>Back to plain</p>\n" +
  '<ul><li><a href="https://hax.psu.edu">Linked</a> x<sup>2</sup></li></ul>\n' +
  "<h1>Merged table</h1>\n" +
  '<table><thead><tr><th>H1</th><th>H2</th><th>H3</th></tr></thead><tbody><tr><td colspan="2">Wide</td><td>0</td></tr></tbody></table>\n' +
  "<h1>Slide 3</h1>\n" +
  '<p><img src="data:image/png;base64,…" alt="A red square"></p>';

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

function slide(shapes) {
  return `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
}

function shape(type, paragraphs) {
  const ph = type
    ? `<p:nvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr>`
    : "<p:nvSpPr><p:nvPr/></p:nvSpPr>";
  return `<p:sp>${ph}<p:txBody>${paragraphs.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
}

async function zipOf(files) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (const name of Object.keys(files)) zip.file(name, files[name]);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("pptxToHtml: lists, links, sup, merged table, picture with alt", async () => {
  const html = await convertPptxBufferToHtml(fs.readFileSync(RICH_DECK));
  assert.equal(html.replace(/base64,[^"]*/g, "base64,…"), RICH_EXPECTED);
  assert.match(html, /data:image\/png;base64,iVBORw0KGgo/);
});

test("pptxToHtml: an h1 per slide, numeric order without presentation.xml", async () => {
  const buffer = await zipOf({
    "ppt/slides/slide10.xml": slide(shape("title", ["Ten &amp; &lt;More&gt;"])),
    "ppt/slides/slide2.xml": slide(shape("", ["two", "second line"])),
    "ppt/slides/slide1.xml": slide(shape("ctrTitle", ["One"])),
    "docProps/app.xml": "<props/>",
  });
  assert.equal(
    await convertPptxBufferToHtml(buffer),
    "<h1>One</h1>\n<h1>two</h1>\n<p>second line</p>\n<h1>Ten &amp; &lt;More&gt;</h1>",
  );
});

test("pptxToHtml: notes, slide numbers and footers are left out", async () => {
  const buffer = await zipOf({
    "ppt/slides/slide1.xml": slide(
      shape("title", ["Title"]) +
        shape("sldNum", ["7"]) +
        shape("ftr", ["Footer"]) +
        shape("body", ["Point"]),
    ),
  });
  assert.equal(
    await convertPptxBufferToHtml(buffer),
    "<h1>Title</h1>\n<ul><li>Point</li></ul>",
  );
});

test("pptxToHtml: refuses a non-zip and entity declarations", async () => {
  await assert.rejects(
    convertPptxBufferToHtml(Buffer.from("nope")),
    /missing ZIP signature/,
  );
  const buffer = await zipOf({
    "ppt/slides/slide1.xml":
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "a">]><p:sld/>',
  });
  await assert.rejects(
    convertPptxBufferToHtml(buffer),
    /not valid PowerPoint XML/,
  );
});

test("importPptx: each slide is a page, pictures inline for createNode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hax-pptx-"));
  const filePath = path.join(dir, "upload");
  await fs.copy(RICH_DECK, filePath);
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
  await importPptx(
    { files: [{ originalname: "rich.pptx", path: filePath }], body: {} },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.data.items.map((item) => item.title),
    ["Rich & <bold>", "Merged table", "Slide 3"],
  );
  assert.match(
    res.body.data.items[2].contents,
    /<img src="data:image\/png;base64,/,
  );
});
