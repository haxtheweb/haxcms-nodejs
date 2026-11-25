"use strict";

// convertHaxcmsToSite from an uploaded HAXcms site zip (haxtheweb/issues#3405).
// The zip path must give the URL import's result (items with contents, files
// staged under the bulk-import root), refuse anything that is not a HAX site
// outline, never read outside the folder that holds site.json, and answer
// only while site zip import is on. CommonJS, node:test, no optional chaining.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs-extra");
const os = require("os");
const JSZip = require("jszip");

// off unless turned on: this suite turns it on and checks the off answer on
// its own
process.env.HAXCMS_SITE_ZIP_IMPORT = "true";

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "haxzip-"));
const CONFIG_DIR = path.join(TMP_BASE, "config");
const HAXCMSMod = require("../../src/lib/HAXCMS.js");
HAXCMSMod.HAXCMS.configDirectory = CONFIG_DIR;

const {
  convertHaxcmsToSite,
} = require("../../src/systemRoutes/v1/routes/imports/convertHaxcmsToSite.js");
const { siteRelativePath, isSiteOutline } = require("../../src/lib/siteZip.js");

const SITE_JSON = {
  title: "My 90s page",
  description: "Under construction",
  metadata: {
    site: { name: "my-90s-page" },
    theme: { element: "clean-one" },
  },
  items: [
    {
      id: "item-1",
      title: "Home",
      location: "pages/home/index.html",
      parent: null,
      indent: 0,
      order: 0,
      metadata: {
        files: [{ url: "files/guestbook.gif" }, { url: "files/missing.png" }],
      },
    },
  ],
};

async function makeZip(prefix, siteJson, extra) {
  const zip = new JSZip();
  zip.file(prefix + "site.json", JSON.stringify(siteJson || SITE_JSON));
  zip.file(prefix + "pages/home/index.html", "<p>Welcome to my homepage</p>");
  zip.file(prefix + "files/guestbook.gif", Buffer.from("GIF89a-fake"));
  zip.file(
    prefix + "custom/build/custom.es6.js",
    "// custom comment script here",
  );
  zip.file("outside.html", "<p>outside the site folder</p>");
  if (extra) {
    extra(zip, prefix);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function upload(buffer) {
  const filePath = path.join(
    TMP_BASE,
    "upload-" + Math.random().toString(36).slice(2),
  );
  fs.writeFileSync(filePath, buffer);
  return { path: filePath, originalname: "site.zip", size: buffer.length };
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

async function runFile(file) {
  const res = stubRes();
  await convertHaxcmsToSite(
    { body: {}, params: {}, headers: {}, query: {}, files: [file] },
    res,
  );
  return res;
}

function run(buffer) {
  return runFile(upload(buffer));
}

for (const prefix of ["", "my-90s-page/"]) {
  test(
    "site zip " +
      (prefix ? "inside a folder" : "at the top") +
      " imports like the URL import",
    async () => {
      const res = await run(await makeZip(prefix));
      assert.equal(res.statusCode, 200);
      const data = res.body.data;
      assert.equal(data.filename, "my-90s-page");
      assert.deepEqual(data.site, {
        title: "My 90s page",
        description: "Under construction",
        theme: "clean-one",
      });
      assert.equal(data.items[0].contents, "<p>Welcome to my homepage</p>");
      // only the file that exists in the zip is staged
      assert.deepEqual(Object.keys(data.files), ["files/guestbook.gif"]);
      const staged = data.files["files/guestbook.gif"];
      assert.ok(staged.startsWith(path.join(CONFIG_DIR, "tmp", "imports")));
      assert.equal(fs.readFileSync(staged, "utf8"), "GIF89a-fake");
      // the untouched boilerplate custom build carries nothing
      assert.deepEqual(data.siteFiles, {});
    },
  );
}

test("the site's custom build comes back staged in siteFiles", async () => {
  const res = await run(
    await makeZip("", null, (zip) => {
      zip.file("custom/build/custom.es6.js", "export class GeoTheme {}");
    }),
  );
  assert.equal(res.statusCode, 200);
  const staged = res.body.data.siteFiles["custom/build/custom.es6.js"];
  assert.ok(staged.startsWith(path.join(CONFIG_DIR, "tmp", "imports")));
  assert.equal(fs.readFileSync(staged, "utf8"), "export class GeoTheme {}");
});

test("site zip import is off unless the operator turns it on", async () => {
  delete process.env.HAXCMS_SITE_ZIP_IMPORT;
  const config = HAXCMSMod.HAXCMS.config;
  try {
    const res = await run(await makeZip(""));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.data.reason, "DISABLED");
    assert.equal(res.body.data.error, "site-zip-import is disabled");
    // config security.siteZipImport turns it on too
    HAXCMSMod.HAXCMS.config = Object.assign({}, config, {
      security: Object.assign({}, (config && config.security) || {}, {
        siteZipImport: true,
      }),
    });
    assert.equal((await run(await makeZip(""))).statusCode, 200);
  } finally {
    HAXCMSMod.HAXCMS.config = config;
    process.env.HAXCMS_SITE_ZIP_IMPORT = "true";
  }
});

test("an upload over the conversion cap is refused before it is read", async () => {
  const file = upload(await makeZip(""));
  file.size = 10 * 1024 * 1024 * 1024;
  const res = await runFile(file);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.data.reason, "ZIP_BUDGET");
});

test("a file that is not a zip is refused", async () => {
  const res = await run(Buffer.from("<html>not a zip</html>"));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.data.reason, "NOT_A_ZIP");
});

test("a zip without site.json is refused", async () => {
  const zip = new JSZip();
  zip.file("index.html", "<p>hi</p>");
  const res = await run(await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.data.reason, "INVALID_SITE");
});

test("site.json deeper than one folder is not a site zip", async () => {
  const zip = new JSZip();
  zip.file("a/b/site.json", JSON.stringify(SITE_JSON));
  const res = await run(await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.data.reason, "INVALID_SITE");
});

const NOT_A_SITE = [
  ["no items", (site) => delete site.items],
  ["no pages", (site) => (site.items = [])],
  [
    "a page outside pages/",
    (site) => (site.items[0].location = "../outside.html"),
  ],
  [
    "a page that is not .html",
    (site) => (site.items[0].location = "pages/home/index.php"),
  ],
  [
    "a file outside files/",
    (site) => site.items[0].metadata.files.push({ url: "../../etc/passwd" }),
  ],
  [
    "a file given as an address",
    (site) =>
      site.items[0].metadata.files.push({ url: "https://example.com/a.png" }),
  ],
  [
    "two pages with one id",
    (site) => site.items.push(Object.assign({}, site.items[0])),
  ],
  ["an id with unsafe characters", (site) => (site.items[0].id = "../item")],
  ["a title that is not text", (site) => (site.items[0].title = { a: 1 })],
];
for (const [label, change] of NOT_A_SITE) {
  test(
    "a site.json with " + label + " is not a HAX site and is refused whole",
    async () => {
      const site = JSON.parse(JSON.stringify(SITE_JSON));
      change(site);
      assert.equal(isSiteOutline(site), false);
      const res = await run(await makeZip("", site));
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.data.reason, "INVALID_SITE");
    },
  );
}

test("page content comes back as written; sanitizing is createSite's", async () => {
  const res = await run(
    await makeZip("", null, (zip) => {
      zip.file("pages/home/index.html", "<p>hi</p><script>alert(1)</script>");
    }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(
    res.body.data.items[0].contents,
    "<p>hi</p><script>alert(1)</script>",
  );
});

test("siteRelativePath keeps paths inside the site folder", () => {
  assert.equal(siteRelativePath("files/a.png"), "files/a.png");
  assert.equal(siteRelativePath("./files/a.png?x=1#y"), "files/a.png");
  assert.equal(siteRelativePath("files/../files/a.png"), "files/a.png");
  assert.equal(siteRelativePath("../a.png"), "");
  assert.equal(siteRelativePath("files/../../a.png"), "");
  assert.equal(siteRelativePath("/etc/passwd"), "");
  assert.equal(siteRelativePath("https://example.com/a.png"), "");
  assert.equal(siteRelativePath("files\\a.png"), "");
  assert.equal(siteRelativePath(""), "");
  assert.equal(siteRelativePath(null), "");
});

test.after(() => {
  fs.removeSync(TMP_BASE);
});
