"use strict";

// compactSiblingOrders numbers the pages under each parent 0..n-1 in the
// sequence they are shown in. The front end counts orders as positions when
// it loads the outline, so this keeps an order it sends meaning the same
// spot on the backend. Same cases as haxcms-php OperationsNodeOpsTest.

const test = require("node:test");
const assert = require("node:assert/strict");

const { compactSiblingOrders } = require("../../src/lib/outlineUpkeep.js");

const item = (id, parent, order) => ({ id, parent, order });

test("compactSiblingOrders numbers each group without gaps", () => {
  const items = [
    item("a", null, 0),
    item("b", null, 4),
    item("c", "a", 3),
    item("d", null, 4),
    item("e", "a", 9),
  ];
  assert.equal(compactSiblingOrders(items), true);
  // ties keep their array position (b before d)
  assert.deepEqual(
    Object.fromEntries(items.map((entry) => [entry.id, entry.order])),
    { a: 0, b: 1, c: 0, d: 2, e: 1 },
  );
  assert.equal(compactSiblingOrders(items), false);
  // a page left out keeps its order and is not counted
  items.push(item("new", null, 1));
  compactSiblingOrders(items, items[5]);
  assert.equal(items[5].order, 1);
  assert.equal(items[3].order, 2);
});
