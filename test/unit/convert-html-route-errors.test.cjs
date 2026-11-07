"use strict";

// Security: the html-to-pdf / html-to-docx conversion routes must never echo
// raw library error text (which embeds absolute temp paths) to the client.
// Errors go through clientSafeErrorDetail, which strips paths.
//
// Constraints honored: CommonJS (.cjs), require(), no optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  convertHtmlToPdf,
} = require("../../src/systemRoutes/v1/routes/convertHtmlToPdf.js");
const {
  convertHtmlToDocx,
} = require("../../src/systemRoutes/v1/routes/convertHtmlToDocx.js");

function stubRes() {
  return {
    statusCode: null,
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

const MISSING_TEMP_FILE = "/var/lib/haxcms/_config/tmp/does-not-exist-0001";

test("html-to-pdf read failures do not leak the temp file path", async () => {
  const res = stubRes();
  await convertHtmlToPdf(
    {
      files: [{ originalname: "page.html", path: MISSING_TEMP_FILE }],
      body: {},
    },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.data.error.indexOf("Unable to read uploaded file") === 0);
  assert.equal(res.body.data.error.indexOf(MISSING_TEMP_FILE), -1);
  assert.equal(res.body.data.error.indexOf("/var/lib"), -1);
  assert.ok(res.body.data.error.indexOf("[path]") !== -1);
});

test("html-to-docx read failures do not leak the temp file path", async () => {
  const res = stubRes();
  await convertHtmlToDocx(
    {
      files: [{ originalname: "page.htm", path: MISSING_TEMP_FILE }],
      body: {},
    },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.data.error.indexOf("Unable to read uploaded file") === 0);
  assert.equal(res.body.data.error.indexOf(MISSING_TEMP_FILE), -1);
  assert.ok(res.body.data.error.indexOf("[path]") !== -1);
});
