"use strict";

// pageTimestamps (src/lib/sanitizePageMetadata.js) and its use by addPage:
// a page brought in from another site keeps its created / updated times,
// anything else gets the time it was added. PHP twin:
// SanitizeContent::pageTimestamps (tests/Unit/PageTimestampsTest.php).

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "page-timestamps-"));
process.env.HAXCMS_ROOT = testRoot + "/";

const { pageTimestamps } = require("../../src/lib/sanitizePageMetadata.js");
const { HAXCMS } = require("../../src/lib/HAXCMS.js");

test.after(() => {
  fs.removeSync(testRoot);
});

const NOW = 1800000000;

describe("pageTimestamps", () => {
  test("a new page (no metadata) gets now for both", () => {
    assert.deepEqual(pageTimestamps(null, NOW), { created: NOW, updated: NOW });
    assert.deepEqual(pageTimestamps({}, NOW), { created: NOW, updated: NOW });
  });
  test("imported created and updated are kept", () => {
    assert.deepEqual(
      pageTimestamps({ created: 1700000000, updated: 1750000000 }, NOW),
      {
        created: 1700000000,
        updated: 1750000000,
      },
    );
  });
  test("created alone: updated follows it", () => {
    assert.deepEqual(pageTimestamps({ created: 1700000000 }, NOW), {
      created: 1700000000,
      updated: 1700000000,
    });
  });
  test("digit strings count, as they would arrive from a form", () => {
    assert.deepEqual(
      pageTimestamps({ created: "1700000000" }, NOW).created,
      1700000000,
    );
  });
  test("updated earlier than created is raised to created", () => {
    assert.deepEqual(
      pageTimestamps({ created: 1700000000, updated: 1600000000 }, NOW),
      {
        created: 1700000000,
        updated: 1700000000,
      },
    );
  });
  test("future, zero, negative, fractional and non-number values are ignored", () => {
    for (const bad of [
      NOW + 1,
      0,
      -5,
      1700000000.5,
      "17e8",
      "yesterday",
      true,
      [1],
      { a: 1 },
      NaN,
    ]) {
      assert.deepEqual(
        pageTimestamps({ created: bad }, NOW),
        { created: NOW, updated: NOW },
        String(bad),
      );
    }
    // a valid created with a bad updated keeps created for both
    assert.deepEqual(
      pageTimestamps({ created: 1700000000, updated: NOW + 60 }, NOW),
      {
        created: 1700000000,
        updated: 1700000000,
      },
    );
  });
});

describe("addPage keeps imported times", () => {
  test("items-import style pages keep created / updated; new pages get now", async () => {
    const site = await HAXCMS.loadSite("timestamps-site", true);
    const before = Math.floor(Date.now() / 1000);
    const imported = await site.addPage(
      null,
      "Old letter",
      "html",
      "old-letter",
      null,
      0,
      "<p>x</p>",
      1,
      {
        created: 1700000000,
        updated: 1710000000,
        image: "files/a.svg",
      },
    );
    const fresh = await site.addPage(
      null,
      "New letter",
      "html",
      "new-letter",
      null,
      0,
      "<p>y</p>",
      2,
      {
        image: "files/b.svg",
      },
    );
    assert.equal(imported.metadata.created, 1700000000);
    assert.equal(imported.metadata.updated, 1710000000);
    assert.equal(imported.metadata.image, "files/a.svg");
    assert.ok(fresh.metadata.created >= before);
    assert.equal(fresh.metadata.updated, fresh.metadata.created);
    // written to site.json as well
    const saved = JSON.parse(
      fs.readFileSync(path.join(site.siteDirectory, "site.json"), "utf8"),
    );
    const row = saved.items.find((i) => i.slug === "old-letter");
    assert.equal(row.metadata.created, 1700000000);
  });
});
