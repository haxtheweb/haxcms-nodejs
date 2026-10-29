"use strict";

// orderTree() gives the same order as the PHP backend for the same items,
// and leaves the array it is given alone. locutus' usort sorts in place
// (PHP's sorts its own copy), so orderTree(site.manifest.items), which
// building llms.txt does, used to re-sort the live manifest by order and
// change which pages later feeds and saves listed first among ties. Mirrors
// haxcms-php JSONOutlineSchemaTest::testOrderTreeWhenTheFirstPageIsASubPage.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const JSONOutlineSchema = require("../../src/lib/JSONOutlineSchema.js");

function schema() {
  const jos = new JSONOutlineSchema();
  [
    ["p", null, 1],
    ["c", "p", 0],
    ["d", "r", 1],
    ["r", null, 0],
  ].forEach(([id, parent, order]) => {
    const item = jos.newItem();
    item.id = id;
    item.parent = parent;
    item.order = order;
    jos.addItem(item);
  });
  return jos;
}

test("orderTree returns the tree order the PHP backend returns", () => {
  const jos = schema();
  const ids = jos.orderTree(jos.items).map((i) => i.id);
  assert.deepEqual(ids, ["c", "r", "d", "p"]);
});

test("orderTree leaves the array it is given in its order", () => {
  const jos = schema();
  jos.orderTree(jos.items);
  assert.deepEqual(
    jos.items.map((i) => i.id),
    ["p", "c", "d", "r"],
  );
});
