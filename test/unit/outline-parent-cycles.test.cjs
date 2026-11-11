"use strict";

// Parent cycles in an outline (haxtheweb/issues#3287, FI-PAY-07/08):
// saveOutline rejects a payload that would create one before writing
// anything (validateOutlineItems), and the parent walk in
// getUniqueSlugName stops on a cycle that is already on disk instead of
// looping forever. haxcms-php mirrors both (OutlineParentCyclesTest.php).
//
// CommonJS, no optional chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outline-cycles-"));
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMSSite } = require("../../src/lib/HAXCMS.js");
const JSONOutlineSchema = require("../../src/lib/JSONOutlineSchema.js");
const saveOutline = require("../../src/siteRoutes/v1/routes/saveOutline.js");

test.after(() => {
  fs.removeSync(testRoot);
});

// a site whose outline is the given [id, parent, slug] rows
function siteWith(rows) {
  const site = new HAXCMSSite();
  site.manifest = new JSONOutlineSchema();
  rows.forEach((row) => {
    const item = site.manifest.newItem();
    item.id = row[0];
    item.parent = row[1];
    item.slug = row[2] || row[0];
    site.manifest.addItem(item);
  });
  site.loadNode = (id) => site.manifest.getItemById(id);
  return site;
}

const sent = (id, parent) => ({ id: id, parent: parent, title: id });
const validate = saveOutline.validateOutlineItems;
const CYCLE = "Outline item parents cannot form a cycle";

test("a valid outline passes, including a parent that does not exist", () => {
  const site = siteWith([
    ["a", null],
    ["b", "a"],
  ]);
  assert.equal(validate(site, [sent("a", null), sent("b", "a")]), null);
  assert.equal(validate(site, [sent("b", "no-such-page")]), null);
  assert.equal(
    validate(site, [sent("new-1", "a"), sent("new-2", "new-1")]),
    null,
  );
  // an existing id twice is one page (the last entry wins)
  assert.equal(validate(site, [sent("a", null), sent("a", null)]), null);
});

test("self-parent and cycles are rejected, through sent and existing pages", () => {
  const site = siteWith([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
  ]);
  assert.equal(validate(site, [sent("a", "a")]), CYCLE);
  assert.equal(validate(site, [sent("a", "b"), sent("b", "a")]), CYCLE);
  // a moved under its own grandchild c (c stays where it is on disk)
  assert.equal(validate(site, [sent("a", "c")]), CYCLE);
  // two new pages under each other
  assert.equal(validate(site, [sent("x", "y"), sent("y", "x")]), CYCLE);
});

test("items that are not objects and repeated new ids are rejected", () => {
  const site = siteWith([["a", null]]);
  [null, 42, "a", [1], true].forEach((bad) => {
    assert.equal(
      validate(site, [sent("a", null), bad]),
      "Each outline item must be an object",
    );
  });
  assert.equal(
    validate(site, [sent("n", null), sent("n", null)]),
    "Each new outline item requires its own id",
  );
  [undefined, null, "", "  ", true, {}, [], NaN].forEach((badId) => {
    assert.equal(
      validate(site, [sent("a", null), { id: badId, title: "x" }]),
      "Each outline item requires an id",
      "id " + String(badId),
    );
  });
  assert.equal(
    validate(site, [{ title: "no id at all" }]),
    "Each outline item requires an id",
  );
  // checked over every item before repeated new ids are looked for
  assert.equal(
    validate(site, [sent("n", null), sent("n", null), { title: "x" }]),
    "Each outline item requires an id",
  );
  // a numeric id is still an id here (haxcms-php only accepts strings)
  assert.equal(validate(site, [sent(7, null)]), null);
  assert.equal(
    validate(site, "not-an-array"),
    "Outline payload requires an items array",
  );
});

test("getUniqueSlugName stops on a parent cycle already on disk", () => {
  const site = siteWith([
    ["a", "b", "a"],
    ["b", "a", "b"],
    ["s", "s", "s"],
  ]);
  assert.equal(
    site.getUniqueSlugName("child", { id: "c", parent: "a" }, true),
    "b/a/child",
  );
  assert.equal(
    site.getUniqueSlugName("self", { id: "s", parent: "s" }, true),
    "self",
  );
});
