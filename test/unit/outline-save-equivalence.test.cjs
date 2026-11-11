"use strict";

// The outline designer's save-equivalence check (test/fuzz/save-equivalence.cjs,
// haxtheweb/issues#3248): two recordings of the same seeded session compare
// equal unless what the designer sent differs.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  firstDifference,
  normalizeSaves,
} = require("../fuzz/save-equivalence.cjs");

const fixtureItem = (n, extra) =>
  Object.assign(
    {
      id: "item-perf-60-0000" + n,
      title: "Page " + n,
      parent: null,
      order: n,
      indent: 0,
      location: "pages/item-perf-60-0000" + n + "/index.html",
      metadata: { created: 1700000000 + n, updated: 1700000100 + n },
    },
    extra || {},
  );

// one session with an added page (client id, then the server's id) and a
// child of it
function session(clientId, serverId, stamp) {
  return [
    [
      fixtureItem(1),
      {
        id: clientId,
        title: "Fuzz page 2",
        parent: "item-perf-60-00001",
        order: 0,
        indent: 1,
        location: "pages/" + clientId + "/index.html",
        metadata: { created: stamp, updated: stamp },
      },
    ],
    [
      fixtureItem(1),
      {
        id: serverId,
        title: "Fuzz page 2",
        parent: "item-perf-60-00001",
        order: 0,
        indent: 1,
        location: "pages/" + serverId + "/index.html",
        metadata: { created: stamp + 5, updated: stamp + 9 },
      },
      {
        id: "item-dup-" + serverId,
        title: "Child",
        parent: serverId,
        order: 0,
        indent: 2,
        metadata: {},
      },
    ],
  ];
}

test("two runs of one session normalize to the same thing", () => {
  const a = normalizeSaves(
    session(
      "item-1b2c3d4e-0000-4000-8000-000000000001",
      "item-aaaaaaaa-1111-4111-8111-111111111111",
      1800000000,
    ),
  );
  const b = normalizeSaves(
    session(
      "item-99999999-0000-4000-8000-000000000009",
      "item-bbbbbbbb-2222-4222-8222-222222222222",
      1900000000,
    ),
  );
  assert.equal(firstDifference(a, b), null);
  // fixture ids stay, new ids are renamed in order everywhere they occur
  assert.equal(a[0][0].id, "item-perf-60-00001");
  assert.equal(a[0][1].id, "new-1");
  assert.equal(a[0][1].location, "pages/new-1/index.html");
  assert.equal(a[1][1].id, "new-2");
  assert.equal(a[1][2].parent, "new-2");
  assert.equal(a[0][0].metadata.created, 0);
  assert.equal(a[1][1].metadata.updated, 0);
});

test("normalizing does not touch the recording it was given", () => {
  const raw = session("item-c1", "item-s1", 5);
  const copy = JSON.stringify(raw);
  normalizeSaves(raw);
  assert.equal(JSON.stringify(raw), copy);
});

test("names the first save, item and field that differ", () => {
  const a = normalizeSaves(session("item-c1", "item-s1", 5));
  const changed = session("item-c2", "item-s2", 7);
  changed[1][2].order = 3;
  const b = normalizeSaves(changed);
  assert.equal(
    firstDifference(a, b),
    "save 2, item 2 (new-3) order: expected 0, got 3",
  );
});

test("a different structure is a difference: parent, title, extra or missing items", () => {
  const base = () => session("item-c1", "item-s1", 5);
  const a = normalizeSaves(base());

  const reparented = base();
  reparented[0][1].parent = null;
  assert.match(
    firstDifference(a, normalizeSaves(reparented)),
    /^save 1, item 1 \(new-1\) parent: expected "item-perf-60-00001", got null$/,
  );

  const extra = base();
  extra[1].push(fixtureItem(3));
  assert.equal(
    firstDifference(a, normalizeSaves(extra)),
    "save 2: expected 3 items, got 4",
  );

  const fewerSaves = base().slice(0, 1);
  assert.equal(
    firstDifference(a, normalizeSaves(fewerSaves)),
    "saves: expected 2, got 1",
  );

  const deleted = base();
  deleted[1][1].delete = true;
  assert.match(
    firstDifference(a, normalizeSaves(deleted)),
    /^save 2, item 1 \(new-2\) delete: expected \(missing\), got true$/,
  );
});

test("pages added in a different order are a difference, not renamed away", () => {
  const two = (first, second) => [
    [
      fixtureItem(1),
      { id: first, title: "A", parent: null, order: 1, indent: 0 },
      { id: second, title: "B", parent: null, order: 2, indent: 0 },
    ],
  ];
  const a = normalizeSaves(two("item-x1", "item-x2"));
  const b = normalizeSaves([
    [
      fixtureItem(1),
      { id: "item-y1", title: "B", parent: null, order: 1, indent: 0 },
      { id: "item-y2", title: "A", parent: null, order: 2, indent: 0 },
    ],
  ]);
  assert.match(firstDifference(a, b), /^save 1, item 1 \(new-1\) title/);
});
