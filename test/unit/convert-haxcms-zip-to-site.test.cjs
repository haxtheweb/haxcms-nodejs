"use strict";

// convertHaxcmsToSite from an uploaded HAXcms site zip (haxtheweb/issues#3405).
// The zip path must give the URL import's result (items with contents, files
// staged under the bulk-import root) and never read outside the folder that
// holds site.json. CommonJS, node:test, no optional chaining.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs-extra");
const os = require("os");
const JSZip = require("jszip");

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "haxzip-"));
const CONFIG_DIR = path.join(TMP_BASE, "config");
const HAXCMSMod = require("../../src/lib/HAXCMS.js");
HAXCMSMod.HAXCMS.configDirectory = CONFIG_DIR;

const {
  convertHaxcmsToSite,
} = require("../../src/systemRoutes/v1/routes/imports/convertHaxcmsToSite.js");
const { siteRelativePath } = require("../../src/lib/siteZip.js");

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
      location: "pages/home/index.html",
      metadata: {
        files: [
          { url: "files/guestbook.gif" },
          { url: "files/missing.png" },
          { url: "../../etc/passwd" },
          { url: "https://example.com/a.png" },
        ],
      },
    },
    { id: "item-2", location: "../outside.html" },
  ],
};

async function makeZip(prefix, siteJson, extra) {
  const zip = new JSZip();
  zip.file(prefix + "site.json", JSON.stringify(siteJson || SITE_JSON));
  zip.file(prefix + "pages/home/index.html", "<p>Welcome to my homepage</p>");
  zip.file(prefix + "files/guestbook.gif", Buffer.from("GIF89a-fake"));
  zip.file("outside.html", "<p>outside the site folder</p>");
  if (extra) {
    extra(zip);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function upload(buffer, name) {
  const filePath = path.join(
    TMP_BASE,
    "upload-" + Math.random().toString(36).slice(2),
  );
  fs.writeFileSync(filePath, buffer);
  return { path: filePath, originalname: name || "site.zip" };
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

async function run(buffer) {
  const res = stubRes();
  await convertHaxcmsToSite(
    { body: {}, params: {}, headers: {}, query: {}, files: [upload(buffer)] },
    res,
  );
  return res;
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
      assert.deepEqual(data.siteFiles, {});
      assert.equal(data.items[0].contents, "<p>Welcome to my homepage</p>");
      // a location outside the site folder reads nothing
      assert.equal(data.items[1].contents, "");
      // only the file that exists inside the site folder is staged
      assert.deepEqual(Object.keys(data.files), ["files/guestbook.gif"]);
      const staged = data.files["files/guestbook.gif"];
      assert.ok(staged.startsWith(path.join(CONFIG_DIR, "tmp", "imports")));
      assert.equal(fs.readFileSync(staged, "utf8"), "GIF89a-fake");
    },
  );
}

test("a file that is not a zip is refused", async () => {
  const res = await run(Buffer.from("<html>not a zip</html>"));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.data.code, "NOT_A_ZIP");
});

test("a zip without site.json is refused", async () => {
  const zip = new JSZip();
  zip.file("index.html", "<p>hi</p>");
  const res = await run(await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.data.code, "INVALID_SITE");
});

test("site.json deeper than one folder is not a site zip", async () => {
  const zip = new JSZip();
  zip.file("a/b/site.json", JSON.stringify(SITE_JSON));
  const res = await run(await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.data.code, "INVALID_SITE");
});

test("site.json without items is refused", async () => {
  const res = await run(await makeZip("", { title: "x" }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.data.code, "INVALID_SITE");
});

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
