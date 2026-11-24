"use strict";

// The overview report statistics have one definition in both backends
// (haxtheweb/issues#3394). test/fixtures/overview-stats-vectors.json is
// shared with haxcms-php tests/fixtures/overview-stats-vectors.json: the
// same pages must give the same numbers on both.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { courseStatsFromOutline } = require("../../src/lib/JOSHelpers.js");

const vectors = require("../fixtures/overview-stats-vectors.json");

function writeSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overview-stats-"));
  const items = vectors.items.map((item, order) => {
    const pageDir = path.join(dir, "pages", item.id);
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, "index.html"), item.content);
    const metadata = {};
    if (item.pageType !== undefined) {
      metadata.pageType = item.pageType;
    }
    if (item.published === false) {
      metadata.published = false;
    }
    return {
      id: item.id,
      indent: item.parent ? 1 : 0,
      location: `pages/${item.id}/index.html`,
      slug: item.id,
      order,
      parent: item.parent,
      title: item.title,
      metadata,
    };
  });
  fs.writeFileSync(
    path.join(dir, "site.json"),
    JSON.stringify({
      id: "s",
      title: "S",
      metadata: { site: { name: "s" } },
      items,
    }),
  );
  return dir;
}

test("overview statistics match the shared vectors", async (t) => {
  const dir = writeSite();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const vector of vectors.cases) {
    const stats = await courseStatsFromOutline(
      dir,
      null,
      vector.ancestor,
      Object.keys(vector.expected),
    );
    assert.deepEqual(stats, vector.expected, `ancestor ${vector.ancestor}`);
  }
});
