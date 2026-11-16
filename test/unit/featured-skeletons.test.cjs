"use strict";

// The new-site dashboard lists skeletons by priority (lowest first), then by
// title (app-hax-use-case-filter). Online Course and Blog are the featured
// starters, so they come first on every HAXcms, the hosted demo at
// browser.hax.cloud included. haxcms-php keeps the same skeleton files
// (CoreSkeletonOrderTest).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { discoverSkeletons } = require("../../src/lib/skeletonSettings.js");

const CORE = path.join(__dirname, "..", "..", "src", "coreConfig");

// the order the dashboard shows them in
function dashboardOrder(items) {
  return items
    .slice()
    .sort((a, b) =>
      a.priority !== b.priority
        ? a.priority - b.priority
        : String(a.title).localeCompare(String(b.title)),
    )
    .map((i) => i.machineName);
}

test("Online Course, then Blog, lead the new-site dashboard", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "featured-"));
  const items = await discoverSkeletons({
    configDirectory: empty,
    coreConfigPath: CORE,
    basePath: "/",
    systemRequestBase: "system/api/",
    generateMachineName: (v) => String(v).toLowerCase(),
  });
  const order = dashboardOrder(items);
  assert.deepEqual(order.slice(0, 2), ["online-course", "blog"], order.join());
  // every other core skeleton comes after the featured two
  const featured = new Set(["online-course", "blog"]);
  const blog = items.find((i) => i.machineName === "blog");
  for (const item of items)
    if (!featured.has(item.machineName))
      assert.ok(item.priority > blog.priority, item.machineName);
});
