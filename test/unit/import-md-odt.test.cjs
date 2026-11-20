"use strict";

// Unit tests for the Markdown / plain text and OpenDocument Text importers:
// src/lib/markdownImport.js, src/lib/odtToHtml.js and the importMd,
// importOdt and convertOdtToHtml route handlers. ODT fixtures are built at
// runtime with JSZip in the shape LibreOffice writes (mimetype entry,
// content.xml, styles.xml, Pictures/*).
//
// Parity: haxcms-php runs the same cases in
// system/backend/php/tests/Unit/SystemRoutesImportMdOdtTest.php and must
// produce the same HTML for the same documents.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");

const {
  decodeTextBuffer,
  splitFrontMatter,
  renderMarkdown,
} = require("../../src/lib/markdownImport.js");
const {
  convertOdtBufferToHtml,
  convertOdpBufferToHtml,
} = require("../../src/lib/odtToHtml.js");
const { importMd } = require("../../src/systemRoutes/v1/routes/importMd.js");
const { importOdt } = require("../../src/systemRoutes/v1/routes/importOdt.js");
const {
  convertOdtToHtml,
} = require("../../src/systemRoutes/v1/routes/convertOdtToHtml.js");
const { importOdp } = require("../../src/systemRoutes/v1/routes/importOdp.js");
const {
  convertOdpToHtml,
} = require("../../src/systemRoutes/v1/routes/convertOdpToHtml.js");
const {
  importXlsx,
} = require("../../src/systemRoutes/v1/routes/importXlsx.js");

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS}><office:styles>
<style:style style:name="Heading" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_1" style:family="paragraph" style:parent-style-name="Heading" style:default-outline-level="1"/>
<style:style style:name="Heading_20_2" style:family="paragraph" style:parent-style-name="Heading" style:default-outline-level="2"/>
<style:style style:name="Strong_20_Emphasis" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
</office:styles></office:document-styles>`;

const BODY_XML = `
<text:sequence-decls><text:sequence-decl text:name="Figure"/></text:sequence-decls>
<text:table-of-content><text:index-body><text:p>Unit One ..... 1</text:p></text:index-body></text:table-of-content>
<text:p text:style-name="P1">Before any heading.</text:p>
<text:h text:style-name="Heading_20_1" text:outline-level="1">Unit One</text:h>
<text:p>Plain <text:span text:style-name="Strong_20_Emphasis">bold</text:span>, <text:span text:style-name="T1">italic</text:span>, <text:span text:style-name="T2">under</text:span>, <text:span text:style-name="T3">gone</text:span>, x<text:span text:style-name="T4">2</text:span> &amp; &lt;tags&gt;<text:s text:c="2"/>end<text:line-break/>next<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>note</text:p></text:note-body></text:note>.</text:p>
<text:p><text:a xlink:href="https://hax.psu.edu">safe</text:a> and <text:a xlink:href="javascript:alert(1)">unsafe</text:a></text:p>
<text:p text:style-name="Heading_20_2">Styled as heading</text:p>
<text:list text:style-name="L1"><text:list-item><text:p>one</text:p></text:list-item><text:list-item><text:p>two</text:p></text:list-item></text:list>
<text:list text:style-name="L2"><text:list-item><text:list><text:list-item><text:p>nested</text:p></text:list-item></text:list></text:list-item></text:list>
<text:list text:style-name="L1" text:continue-numbering="true"><text:list-item><text:p>three</text:p></text:list-item></text:list>
<text:p/>
<table:table><table:table-column table:number-columns-repeated="2"/>
<table:table-header-rows><table:table-row><table:table-cell><text:p>Name</text:p></table:table-cell><table:table-cell><text:p>Value</text:p></table:table-cell></table:table-row></table:table-header-rows>
<table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>Merged</text:p></table:table-cell><table:covered-table-cell/></table:table-row>
</table:table>
<text:p><draw:frame><draw:image xlink:href="Pictures/a.png"/><svg:title>A dot</svg:title></draw:frame></text:p>
<text:p><draw:frame><draw:image xlink:href="Pictures/a.svg"/></draw:frame></text:p>
<office:annotation><text:p>comment</text:p></office:annotation>
<text:section><text:h text:outline-level="1">Unit Two</text:h><text:p>Last.</text:p></text:section>`;

const AUTO_STYLES = `<office:automatic-styles>
<style:style style:name="T1" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="T2" style:family="text"><style:text-properties style:text-underline-style="solid"/></style:style>
<style:style style:name="T3" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
<style:style style:name="T4" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>
<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"/>
<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1"/></text:list-style>
<text:list-style style:name="L2"><text:list-level-style-bullet text:level="1"/><text:list-level-style-bullet text:level="2"/></text:list-style>
</office:automatic-styles>`;

const EXPECTED_HTML =
  "<p>Before any heading.</p>\n" +
  "<h1>Unit One</h1>\n" +
  "<p>Plain <strong>bold</strong>, <em>italic</em>, <em>under</em>, <del>gone</del>, x<sup>2</sup> &amp; &lt;tags&gt;  end<br>next.</p>\n" +
  '<p><a href="https://hax.psu.edu">safe</a> and unsafe</p>\n' +
  "<h2>Styled as heading</h2>\n" +
  "<ol><li>one</li><li>two<ul><li>nested</li></ul></li><li>three</li></ol>\n" +
  '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td colspan="2">Merged</td></tr></tbody></table>\n' +
  `<p><img src="data:image/png;base64,${PNG.toString("base64")}" alt="A dot"></p>\n` +
  "<h1>Unit Two</h1>\n" +
  "<p>Last.</p>";

async function buildOdt(options) {
  const opts = options || {};
  const zip = new JSZip();
  zip.file(
    "mimetype",
    opts.mimetype || "application/vnd.oasis.opendocument.text",
    {
      compression: "STORE",
    },
  );
  zip.file(
    "content.xml",
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}>${AUTO_STYLES}<office:body><office:text>${opts.body || BODY_XML}</office:text></office:body></office:document-content>`,
  );
  zip.file("styles.xml", STYLES_XML);
  zip.file("Pictures/a.png", PNG);
  zip.file("Pictures/a.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

async function uploadReq(name, contents, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hax-import-"));
  const filePath = path.join(dir, "upload");
  await fs.writeFile(filePath, contents);
  return { files: [{ originalname: name, path: filePath }], body: body || {} };
}

test("odtToHtml: headings, styles, lists, tables, images, skips", async () => {
  const html = await convertOdtBufferToHtml(await buildOdt());
  assert.equal(html, EXPECTED_HTML);
});

test("odtToHtml: rejects a non-zip, a zip without content.xml and other ODF types", async () => {
  await assert.rejects(
    convertOdtBufferToHtml(Buffer.from("not a zip")),
    /ZIP signature/,
  );
  const empty = new JSZip();
  empty.file("mimetype", "application/vnd.oasis.opendocument.text");
  await assert.rejects(
    convertOdtBufferToHtml(await empty.generateAsync({ type: "nodebuffer" })),
    /content\.xml/,
  );
  await assert.rejects(
    convertOdtBufferToHtml(
      await buildOdt({
        mimetype: "application/vnd.oasis.opendocument.spreadsheet",
      }),
    ),
    /not an OpenDocument text file/,
  );
});

test("odtToHtml: accepts Writer variants (web / template)", async () => {
  const html = await convertOdtBufferToHtml(
    await buildOdt({ mimetype: "application/vnd.oasis.opendocument.text-web" }),
  );
  assert.equal(html, EXPECTED_HTML);
});

test("odtToHtml: refuses DTD / entity declarations", async () => {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text");
  zip.file(
    "content.xml",
    `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><office:document-content ${NS}><office:body><office:text><text:p>&a;</text:p></office:text></office:body></office:document-content>`,
  );
  await assert.rejects(
    convertOdtBufferToHtml(await zip.generateAsync({ type: "nodebuffer" })),
    /not valid OpenDocument XML/,
  );
});

test("odtToHtml: numbered headings inside a list stay headings", async () => {
  const body =
    '<text:list text:style-name="L1"><text:list-item><text:h text:outline-level="1">First</text:h></text:list-item>' +
    '<text:list-item><text:h text:outline-level="1">Second</text:h><text:p>Body</text:p></text:list-item></text:list>';
  const html = await convertOdtBufferToHtml(await buildOdt({ body: body }));
  assert.equal(html, "<h1>First</h1>\n<h1>Second</h1>\n<p>Body</p>");
});

test("markdownImport: front matter, BOM, CRLF and Windows-1252", () => {
  const md = '﻿---\r\ntitle: "My Notes"\r\nauthor: me\r\n---\r\n# Hi\r\n';
  const decoded = decodeTextBuffer(Buffer.from(md, "utf8"));
  assert.equal(decoded.indexOf("\r"), -1);
  const split = splitFrontMatter(decoded);
  assert.equal(split.title, "My Notes");
  assert.equal(split.body, "# Hi\n");
  assert.equal(decodeTextBuffer(Buffer.from([0x63, 0x61, 0x66, 0xe9])), "café");
  assert.equal(splitFrontMatter("# No front matter").title, "");
  assert.match(renderMarkdown("```js\nx\n```"), /class="language-js"/);
});

test("markdownImport: front matter title is linear-time (SEC-DOS)", () => {
  // a long run of spaces inside the title line used to backtrack
  // quadratically and block the event loop
  const md = "---\ntitle: a" + " ".repeat(400000) + "b\u000b\n---\nbody";
  const start = Date.now();
  const split = splitFrontMatter(md);
  assert.ok(Date.now() - start < 250);
  assert.ok(split.title === "a" + " ".repeat(400000) + "b");
  assert.equal(split.body, "body");
  // a bare "title:" is skipped; spaces and tabs around a value are trimmed
  assert.equal(
    splitFrontMatter("---\ntitle:\ntitle: \tz \t\n---\n").title,
    "z",
  );
  assert.equal(splitFrontMatter("---\ntitle: \t \n---\n").title, "");
});

test("importMd: builds pages from headings and strips scripts", async () => {
  const md =
    "---\ntitle: Notes\n---\n# Chapter One\n\nIntro.\n\n## Part A\n\nA text.\n\n# Chapter Two\n\n<script>alert(1)</script><p>ok</p>\n";
  const res = stubRes();
  await importMd(await uploadReq("notes.md", md), res);
  assert.equal(res.statusCode, 200);
  const items = res.body.data.items;
  assert.deepEqual(
    items.map((item) => [item.title, item.slug, item.indent || 0]),
    [
      ["Chapter One", "chapter-one", 0],
      ["Part A", "chapter-one/part-a", 1],
      ["Chapter Two", "chapter-two", 0],
    ],
  );
  assert.equal(items[1].parent, items[0].id);
  assert.equal(items[2].contents.indexOf("<script"), -1);
  assert.equal(res.body.data.filename, "notes.md");
});

test("importMd: a .txt with no headings is one page named by the file", async () => {
  const res = stubRes();
  await importMd(
    await uploadReq("My notes.txt", "Line one.\n\nLine two.\n"),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.items.length, 1);
  assert.equal(res.body.data.items[0].title, "My notes");
  assert.equal(
    res.body.data.items[0].contents,
    "<p>Line one.</p><p>Line two.</p>",
  );
});

test("importMd: front matter title names a single page", async () => {
  const res = stubRes();
  await importMd(
    await uploadReq("a.markdown", "---\ntitle: Welcome\n---\nJust text.\n"),
    res,
  );
  assert.equal(res.body.data.items[0].title, "Welcome");
});

test("importMd: refuses wrong types, empty and binary files", async () => {
  let res = stubRes();
  await importMd({ files: [], body: {} }, res);
  assert.equal(res.statusCode, 400);
  res = stubRes();
  await importMd(await uploadReq("a.odt", "x"), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.data.error, /Invalid file type/);
  res = stubRes();
  await importMd(await uploadReq("a.md", ""), res);
  assert.equal(res.statusCode, 400);
  res = stubRes();
  await importMd(
    await uploadReq("a.txt", Buffer.from([0x50, 0x4b, 0x00, 0x01])),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.data.error, /not a valid text file/);
});

test("importOdt: site, branch and page methods", async () => {
  const buffer = await buildOdt();
  let res = stubRes();
  await importOdt(
    await uploadReq("course.odt", buffer, { method: "site" }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.data.items.map((item) => item.title),
    ["Unit One", "Styled as heading", "Unit Two"],
  );
  assert.match(res.body.data.items[1].contents, /data:image\/png;base64/);
  res = stubRes();
  await importOdt(
    await uploadReq("course.odt", buffer, { method: "branch", parentId: "p1" }),
    res,
  );
  assert.deepEqual(
    res.body.data.items.map((item) => [item.title, item.parent]),
    [
      ["Unit One", "p1"],
      ["Unit Two", "p1"],
    ],
  );
  res = stubRes();
  await importOdt(
    await uploadReq("course.odt", buffer, { method: "page" }),
    res,
  );
  assert.equal(res.body.data.items.length, 1);
  assert.equal(res.body.data.items[0].title, "course");
});

test("importOdt: refuses wrong types and broken files", async () => {
  let res = stubRes();
  await importOdt(await uploadReq("a.docx", "x"), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.data.error, /Invalid file type/);
  res = stubRes();
  await importOdt(await uploadReq("a.odt", "not a zip"), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.data.error, /ZIP signature/);
});

test("convertOdtToHtml: returns the document as one HTML string", async () => {
  const res = stubRes();
  await convertOdtToHtml(await uploadReq("a.odt", await buildOdt()), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.contents, EXPECTED_HTML);
  assert.equal(res.body.data.filename, "a.odt");
});

// ---- OpenDocument Presentation (.odp) ----
// Each slide is an <h1> (title frame, else first text, else "Slide N") then
// its content; notes, page numbers and empty slides are left out.

const ODP_SLIDES = `<draw:page><draw:frame presentation:class="title"><draw:text-box><text:p>Course Intro</text:p></draw:text-box></draw:frame><draw:frame presentation:class="subtitle"><draw:text-box><text:p>Welcome</text:p></draw:text-box></draw:frame><presentation:notes><draw:frame presentation:class="notes"><draw:text-box><text:p>Speaker notes</text:p></draw:text-box></draw:frame></presentation:notes></draw:page><draw:page><draw:frame presentation:class="title"><draw:text-box><text:p>Unit One</text:p></draw:text-box></draw:frame><draw:frame presentation:class="outline"><draw:text-box><text:list text:style-name="L2"><text:list-item><text:p>First</text:p></text:list-item></text:list><text:list text:style-name="L2"><text:list-item><text:list><text:list-item><text:p>Nested</text:p></text:list-item></text:list></text:list-item></text:list></draw:text-box></draw:frame><draw:frame presentation:class="page-number"><draw:text-box><text:p>2</text:p></draw:text-box></draw:frame></draw:page><draw:page><draw:frame presentation:class="title"><draw:text-box><text:p>Table slide</text:p></draw:text-box></draw:frame><draw:frame><table:table><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell><table:table-cell><text:p>1</text:p></table:table-cell></table:table-row></table:table><draw:image xlink:href="Pictures/preview.svm"/></draw:frame></draw:page><draw:page><draw:g><draw:custom-shape><text:p>Grouped heading</text:p><text:p><text:span text:style-name="T2"><text:a xlink:href="https://hax.psu.edu">a link</text:a></text:span></text:p></draw:custom-shape></draw:g></draw:page><draw:page><draw:frame><draw:image xlink:href="Pictures/a.png"/><svg:desc>A dot</svg:desc></draw:frame></draw:page><draw:page/>`;

const ODP_EXPECTED =
  "<h1>Course Intro</h1>\n" +
  "<p>Welcome</p>\n" +
  "<h1>Unit One</h1>\n" +
  "<ul><li>First<ul><li>Nested</li></ul></li></ul>\n" +
  "<h1>Table slide</h1>\n" +
  "<table><tbody><tr><td>A</td><td>1</td></tr></tbody></table>\n" +
  "<h1>Grouped heading</h1>\n" +
  '<p><a href="https://hax.psu.edu">a link</a></p>\n' +
  "<h1>Slide 5</h1>\n" +
  `<p><img src="data:image/png;base64,${PNG.toString("base64")}" alt="A dot"></p>`;

async function buildOdp(mimetype) {
  const zip = new JSZip();
  zip.file(
    "mimetype",
    mimetype || "application/vnd.oasis.opendocument.presentation",
    {
      compression: "STORE",
    },
  );
  zip.file(
    "content.xml",
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0">${AUTO_STYLES}<office:body><office:presentation>${ODP_SLIDES}</office:presentation></office:body></office:document-content>`,
  );
  zip.file("styles.xml", STYLES_XML);
  zip.file("Pictures/a.png", PNG);
  zip.file("Pictures/preview.svm", "not an image");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("odpToHtml: one h1 per slide, notes and empty slides left out", async () => {
  assert.equal(await convertOdpBufferToHtml(await buildOdp()), ODP_EXPECTED);
});

test("odpToHtml: refuses an .odt and a non-zip", async () => {
  await assert.rejects(
    convertOdpBufferToHtml(
      await buildOdp("application/vnd.oasis.opendocument.text"),
    ),
    /not an OpenDocument presentation file/,
  );
  await assert.rejects(
    convertOdpBufferToHtml(Buffer.from("nope")),
    /valid \.odp file/,
  );
});

test("importOdp: each slide is a page", async () => {
  const res = stubRes();
  await importOdp(await uploadReq("deck.odp", await buildOdp()), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.data.items.map((item) => item.title),
    ["Course Intro", "Unit One", "Table slide", "Grouped heading", "Slide 5"],
  );
  const wrong = stubRes();
  await importOdp(await uploadReq("deck.pptx", "x"), wrong);
  assert.equal(wrong.statusCode, 400);
  assert.match(wrong.body.data.error, /Expected \.odp/);
});

test("convertOdpToHtml: returns the deck as one HTML string", async () => {
  const res = stubRes();
  await convertOdpToHtml(await uploadReq("deck.odp", await buildOdp()), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.contents, ODP_EXPECTED);
});

// ---- OpenDocument Spreadsheet (.ods) through the spreadsheet importer ----

async function buildOds() {
  const cell = (text) =>
    `<table:table-cell office:value-type="string"><text:p>${text}</text:p></table:table-cell>`;
  const row = (cells) =>
    `<table:table-row>${cells.map(cell).join("")}</table:table-row>`;
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet", {
    compression: "STORE",
  });
  zip.file(
    "content.xml",
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:body><office:spreadsheet><table:table table:name="Outline">` +
      row(["Title", "Slug", "Parent", "Content"]) +
      row(["Unit One", "unit-one", "", "&lt;p&gt;One&lt;/p&gt;"]) +
      row(["Lesson A", "lesson-a", "unit-one", "&lt;p&gt;A&lt;/p&gt;"]) +
      `</table:table></office:spreadsheet></office:body></office:document-content>`,
  );
  zip.file(
    "styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}/>`,
  );
  zip.file(
    "meta.xml",
    '<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"><office:meta/></office:document-meta>',
  );
  zip.file(
    "META-INF/manifest.xml",
    '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("importXlsx: reads an .ods outline like an .xlsx one", async () => {
  const res = stubRes();
  await importXlsx(await uploadReq("outline.ods", await buildOds()), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.data.items.map((item) => [
      item.title,
      item.slug,
      item.indent || 0,
      item.contents,
    ]),
    [
      ["Unit One", "unit-one", 0, "<p>One</p>"],
      ["Lesson A", "lesson-a", 1, "<p>A</p>"],
    ],
  );
  assert.equal(res.body.data.items[1].parent, res.body.data.items[0].id);
});
