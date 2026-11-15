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

// ---------------------------------------------------------------------------
// Characterization: the indexed orderTree walk must return exactly what the
// original O(n^2) orderRecurse returned (same objects, same order) for any
// outline, including ties, orphans, cycles, duplicate ids and filtered lists.
// The reference below is the pre-change orderTree/orderRecurse, verbatim
// apart from being free functions.
// ---------------------------------------------------------------------------
const usortImport = require("locutus/php/array/usort");
const arraySearchImport = require("locutus/php/array/array_search");
const usort = usortImport.usort || usortImport;
const array_search = arraySearchImport.array_search || arraySearchImport;

function referenceOrderRecurse(manifestItems, currentItems, sorted, idList) {
  for (var key in currentItems) {
    let item = currentItems[key];
    if (!array_search(item.id, idList)) {
      idList.push(item.id);
      sorted.push(item);
      let children = [];
      for (var key2 in manifestItems) {
        let child = manifestItems[key2];
        if (child.parent == item.id) {
          children.push(child);
        }
      }
      usort(children, function (a, b) {
        return a.order - b.order;
      });
      if (children.length > 0) {
        referenceOrderRecurse(manifestItems, children, sorted, idList);
      }
    }
  }
}
function referenceOrderTree(manifestItems, items) {
  let sorted = [];
  const byOrder = Array.isArray(items) ? items.slice() : Object.values(items);
  usort(byOrder, function (a, b) {
    return a.order - b.order;
  });
  referenceOrderRecurse(manifestItems, byOrder, sorted, []);
  if (sorted.length == items.length) {
    return sorted;
  }
  return items;
}

function makeRandom(seedValue) {
  let seed = seedValue;
  return function next(max) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };
}

function randomOutline(next, options) {
  const jos = new JSONOutlineSchema();
  const count = next(options.maxItems) + 1;
  const ids = [];
  for (let i = 0; i < count; i++) {
    // occasional duplicate ids
    ids.push(
      next(20) === 0 && ids.length > 0 ? ids[next(ids.length)] : "item-" + i,
    );
  }
  for (let i = 0; i < count; i++) {
    const item = jos.newItem();
    item.id = ids[i];
    const roll = next(10);
    if (roll < 3 || i === 0) {
      item.parent = roll === 0 ? undefined : null; // root
    } else if (roll === 3) {
      item.parent = "missing-" + next(5); // orphan
    } else if (roll === 4) {
      item.parent = ids[next(count)]; // anywhere: cycles, self-parent
    } else {
      item.parent = ids[next(i)]; // earlier item: a real tree
    }
    // narrow order range so ties are common; some negative / missing
    const orderRoll = next(12);
    item.order = orderRoll === 0 ? undefined : next(options.orderRange) - 1;
    if (options.mixedTypes && next(15) === 0) {
      // non-string ids/parents must take the original (fallback) path
      if (next(2) === 0) {
        item.id = i;
      } else {
        item.parent = next(3);
      }
    }
    jos.items.push(item);
  }
  return jos;
}

function assertSameOrder(jos, items, label) {
  const expected = referenceOrderTree(jos.items, items);
  const actual = jos.orderTree(items);
  assert.equal(actual.length, expected.length, label + " length");
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i], expected[i], label + " position " + i);
  }
}

test("orderTree matches the original algorithm on random outlines", () => {
  const next = makeRandom(20261106);
  for (let run = 0; run < 3000; run++) {
    const jos = randomOutline(next, {
      maxItems: 40,
      orderRange: 4,
      mixedTypes: false,
    });
    assertSameOrder(jos, jos.items, "full run " + run);
    // routes call orderTree on filtered lists; children still come from
    // the whole manifest
    const subset = jos.items.filter(() => next(3) !== 0);
    assertSameOrder(jos, subset, "subset run " + run);
  }
});

test("orderTree matches the original algorithm with mixed id/parent types", () => {
  const next = makeRandom(31415);
  for (let run = 0; run < 1500; run++) {
    const jos = randomOutline(next, {
      maxItems: 30,
      orderRange: 3,
      mixedTypes: true,
    });
    assertSameOrder(jos, jos.items, "mixed run " + run);
  }
});

test("orderTree matches the original algorithm on a large deep outline", () => {
  const next = makeRandom(4242);
  const jos = new JSONOutlineSchema();
  for (let i = 0; i < 2000; i++) {
    const item = jos.newItem();
    item.id = "page-" + i;
    // mostly deep chains with frequent branching back up
    item.parent =
      i === 0 || next(8) === 0
        ? null
        : "page-" + (i - 1 - next(Math.min(i, 5)));
    item.order = next(6);
    jos.items.push(item);
  }
  assertSameOrder(jos, jos.items, "large");
});

test("orderTree uses the indexed walk for string ids and the original walk otherwise", (t) => {
  const stringIds = schema();
  const original = t.mock.method(stringIds, "orderRecurse");
  stringIds.orderTree(stringIds.items);
  assert.equal(original.mock.callCount(), 0);

  const numericIds = schema();
  numericIds.items[0].id = 7;
  const fallback = t.mock.method(numericIds, "orderRecurse");
  numericIds.orderTree(numericIds.items);
  assert.ok(fallback.mock.callCount() > 0);
});
