"use strict";

// Pure parts of the outline designer fuzzer (test/fuzz, haxtheweb/issues#3252):
// how a stored outline is read back for comparison, the soundness checks,
// and the seeded edit choice. The browser sessions run via npm run fuzz:outline
// and test/e2e/outline-fuzz.e2e.test.cjs.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  OPS,
  outlineProblems,
  pickWeighted,
  storedTree,
} = require("../fuzz/outline-designer.cjs");
const { seededRandom } = require("../perf/fixture.cjs");

const item = (id, title, parent, order, indent, extra) =>
  Object.assign(
    {
      id,
      title,
      parent,
      order,
      indent,
      slug: id,
      location: "pages/" + id + "/index.html",
    },
    extra || {},
  );

test("storedTree reads the outline depth first, siblings by order then position", () => {
  const items = [
    item("b", "B", null, 1, 0),
    item("a", "A", null, 0, 0),
    item("a2", "A2", "a", 1, 1),
    item("a1", "A1", "a", 0, 1),
    // same order as A1: position in site.json breaks the tie
    item("a1b", "A1b", "a", 0, 1),
    item("a1x", "A1x", "a1", 0, 2),
  ];
  assert.deepEqual(storedTree(items), [
    "A<root",
    "A1<A",
    "A1x<A1",
    "A1b<A",
    "A2<A",
    "B<root",
  ]);
});

test("outlineProblems passes a sound outline and names each kind of problem", () => {
  const sound = [item("a", "A", null, 0, 0), item("b", "B", "a", 0, 1)];
  assert.deepEqual(outlineProblems(sound, null), []);

  const problems = outlineProblems(
    [
      item("a", "A", null, 0, 0),
      item("a", "A again", null, 1, 0),
      item("c", "C", "missing", 0, 1),
      item("d", "D", "a", 0, 2),
      item("e", "E", "f", 0, 1, { slug: "a" }),
      item("f", "F", "e", 0, 1),
    ],
    null,
  );
  const text = problems.join("\n");
  assert.match(text, /duplicate id a/);
  assert.match(text, /c has missing parent missing/);
  assert.match(text, /d indent 2 but depth 1/);
  assert.match(text, /duplicate slug a/);
  assert.match(text, /cycle through e/);
});

test("outlineProblems checks page files when given the site directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outline-fuzz-unit-"));
  try {
    fs.mkdirSync(path.join(dir, "pages", "a"), { recursive: true });
    fs.writeFileSync(path.join(dir, "pages", "a", "index.html"), "<p>a</p>");
    const problems = outlineProblems(
      [item("a", "A", null, 0, 0), item("b", "B", null, 1, 0)],
      dir,
    );
    assert.deepEqual(problems, ["b has no page file pages/b/index.html"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pickWeighted is deterministic per seed and roughly follows the weights", () => {
  const a = seededRandom(5);
  const b = seededRandom(5);
  const first = [];
  const second = [];
  for (let i = 0; i < 50; i++) {
    first.push(pickWeighted(a, OPS));
    second.push(pickWeighted(b, OPS));
  }
  assert.deepEqual(first, second);
  const counts = {};
  const rand = seededRandom(9);
  for (let i = 0; i < 5000; i++) {
    const op = pickWeighted(rand, OPS);
    counts[op] = (counts[op] || 0) + 1;
  }
  OPS.forEach(([name]) => assert.ok(counts[name] > 0, name + " is chosen"));
  // moves (weight 10) come up far more often than add-at-top (weight 2)
  assert.ok(counts.moveDown > counts.addTop * 2.5);
});
