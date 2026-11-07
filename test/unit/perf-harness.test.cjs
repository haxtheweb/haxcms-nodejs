"use strict";

// Pure parts of the perf harness (test/perf): fixture generation, budget
// comparison and the scale report. The browser scenarios themselves run via
// `npm run perf` (haxtheweb/issues#3245).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  batchOutline,
  buildOutline,
  fixtureShape,
  seededRandom,
  slugify,
} = require("../perf/fixture.cjs");
const {
  budgetsForProfile,
  compareToBudgets,
  flatten,
  formatReport,
  median,
  normalizeBudget,
  perVisit,
  selectBudgets,
} = require("../perf/budgets.cjs");
const {
  formatResultsMarkdown,
  formatScaleMarkdown,
  growthLabel,
  scaleRows,
  scalingExponent,
} = require("../perf/report.cjs");
const { visitOrder } = require("../perf/memory.cjs");
const budgetsFile = require("../perf/budgets.json");

test("seededRandom is deterministic per seed and stays in [0, 1)", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const c = seededRandom(43);
  const seqA = [a(), a(), a(), a()];
  assert.deepEqual(seqA, [b(), b(), b(), b()]);
  assert.notDeepEqual(seqA, [c(), c(), c(), c()]);
  seqA.forEach((v) => assert.ok(v >= 0 && v < 1));
});

test("fixtureShape parses perf<N> and rejects anything else", () => {
  assert.deepEqual(fixtureShape("perf500"), {
    size: 500,
    modules: 20,
    lessons: 4,
    pages: 5,
    seed: 500,
  });
  assert.equal(fixtureShape("perf1000").modules, 40);
  assert.equal(fixtureShape("perf10000").modules, 400);
  assert.throws(() => fixtureShape("perf0"), /perf<N>/);
  assert.throws(() => fixtureShape("perf"), /perf<N>/);
  assert.throws(() => fixtureShape("site500"), /perf<N>/);
  assert.throws(() => fixtureShape("perf999999"), /perf<N>/);
});

test("buildOutline makes exactly N items, byte-identical across calls", () => {
  [10, 100, 500, 1000, 1234].forEach((size) => {
    const shape = fixtureShape("perf" + size);
    const first = buildOutline(shape);
    assert.equal(first.length, size);
    assert.equal(JSON.stringify(buildOutline(shape)), JSON.stringify(first));
  });
});

test("buildOutline produces a valid tree: unique ids and slugs, parents first", () => {
  const items = buildOutline(fixtureShape("perf1000"));
  const ids = new Set();
  const slugs = new Set();
  items.forEach((item) => {
    assert.ok(!ids.has(item.id), "duplicate id " + item.id);
    assert.ok(!slugs.has(item.slug), "duplicate slug " + item.slug);
    if (item.parent === null) {
      assert.equal(item.indent, 0);
    } else {
      assert.ok(ids.has(item.parent), item.id + " appears before its parent");
    }
    assert.ok(item.contents.length > 0);
    ids.add(item.id);
    slugs.add(item.slug);
  });
  assert.equal(items.filter((i) => i.indent === 0).length, 40);
  assert.equal(items.filter((i) => i.indent === 2).length, 800);
});

test("slugify lowercases and collapses punctuation", () => {
  assert.equal(slugify("Page 1.2.3 Theme, Memory!"), "page-1-2-3-theme-memory");
  assert.equal(slugify("  --Module 4:  x--  "), "module-4-x");
});

test("batchOutline keeps whole modules together and covers every item once", () => {
  const items = buildOutline(fixtureShape("perf1000"));
  const batches = batchOutline(items, 250);
  assert.equal(batches.length, 4);
  assert.equal(
    batches.reduce((n, b) => n + b.length, 0),
    items.length,
  );
  const seen = new Set();
  batches.forEach((batch) => {
    assert.equal(batch[0].indent, 0, "each batch starts at a module");
    batch.forEach((item) => {
      if (item.parent) {
        assert.ok(
          seen.has(item.parent),
          "parent created in this or an earlier batch",
        );
      }
      seen.add(item.id);
    });
  });
  assert.equal(batchOutline([], 250).length, 0);
  assert.equal(batchOutline(items.slice(0, 10), 250).length, 1);
});

test("perVisit and median", () => {
  assert.equal(perVisit(100, 340, 240), 1);
  assert.equal(perVisit(100, 50, 10), 0, "shrinking counts as 0, not negative");
  assert.equal(perVisit(1, 2, 0), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([NaN, "x", 5]), 5);
  assert.equal(median([]), null);
});

test("visitOrder spreads visits over the outline deterministically", () => {
  const order = visitOrder(500, 240, 0);
  assert.equal(order.length, 240);
  assert.ok(order.every((i) => i >= 0 && i < 500));
  assert.ok(new Set(order).size > 200, "mostly distinct pages");
  assert.deepEqual(visitOrder(500, 240, 0), order);
  assert.notDeepEqual(visitOrder(500, 10, 7), visitOrder(500, 10, 0));
});

test("normalizeBudget accepts a number, {max, slack} and {min, slack}", () => {
  assert.deepEqual(normalizeBudget(5), { kind: "max", value: 5, slack: 0 });
  assert.deepEqual(normalizeBudget({ max: 0, slack: 2 }), {
    kind: "max",
    value: 0,
    slack: 2,
  });
  assert.deepEqual(normalizeBudget({ min: 50 }), {
    kind: "min",
    value: 50,
    slack: 0,
  });
  assert.throws(() => normalizeBudget("5"), /invalid budget/);
  assert.throws(() => normalizeBudget({}), /invalid budget/);
});

test("compareToBudgets passes within tolerance and fails over, under and missing", () => {
  const results = {
    scenarios: {
      "reader.perf500": {
        heapKBPerVisit: 11,
        reactionsPerVisit: 0.5,
        navTimeouts: 0,
      },
      "mobile.deep.perf500": { lighthouseScore: 40, lcpMs: 4000 },
    },
  };
  const ok = compareToBudgets(results, {
    tolerance: 0.15,
    metrics: {
      "reader.perf500.heapKBPerVisit": 10,
      "reader.perf500.reactionsPerVisit": { max: 0, slack: 1 },
      "mobile.deep.perf500.lighthouseScore": { min: 45 },
    },
  });
  assert.equal(ok.pass, true, formatReport(ok));

  const bad = compareToBudgets(results, {
    tolerance: 0.15,
    metrics: {
      "reader.perf500.heapKBPerVisit": 9,
      "mobile.deep.perf500.lighthouseScore": { min: 50 },
      "editor.perf500.heapKBPerVisit": 100,
    },
  });
  assert.equal(bad.pass, false);
  const status = Object.fromEntries(bad.rows.map((r) => [r.key, r.status]));
  assert.deepEqual(status, {
    "editor.perf500.heapKBPerVisit": "missing",
    "mobile.deep.perf500.lighthouseScore": "under",
    "reader.perf500.heapKBPerVisit": "over",
  });
  const text = formatReport(bad);
  assert.match(text, /OVER/);
  assert.match(text, /UNDER/);
  assert.match(text, /MISS/);
  assert.match(text, /FAILED: 3/);
});

test("flatten skips non-numeric values", () => {
  assert.deepEqual(flatten({ scenarios: { a: { x: 1, y: "n", z: null } } }), {
    "a.x": 1,
  });
  assert.deepEqual(flatten(null), {});
});

test("selectBudgets keeps only what the command ran, on its fixture", () => {
  const metrics = {
    "reader.perf500.heapKBPerVisit": 1,
    "editor.perf500.heapKBPerVisit": 1,
    "outline.perf500.outlineOpenMs": 1,
    "site.perf500.siteJsonKB": 1,
    "mobile.deep.perf500.lcpMs": 1,
    "mobile.deep.perf500.lighthouseScore": { min: 1 },
    "reader.perf1000.heapKBPerVisit": 1,
  };
  assert.deepEqual(
    Object.keys(selectBudgets(metrics, "memory", false, "perf500")),
    ["reader.perf500.heapKBPerVisit", "editor.perf500.heapKBPerVisit"],
  );
  assert.deepEqual(
    Object.keys(selectBudgets(metrics, "lighthouse", false, "perf500")),
    ["mobile.deep.perf500.lcpMs"],
  );
  assert.deepEqual(
    Object.keys(selectBudgets(metrics, "lighthouse", true, "perf500")),
    ["mobile.deep.perf500.lcpMs", "mobile.deep.perf500.lighthouseScore"],
  );
  assert.deepEqual(
    Object.keys(selectBudgets(metrics, "outline", false, "perf500")),
    ["outline.perf500.outlineOpenMs"],
  );
  assert.equal(
    Object.keys(selectBudgets(metrics, "all", true, "perf500")).length,
    6,
  );
});

test("committed budgets.json is well formed for every profile", () => {
  assert.equal(typeof budgetsFile.tolerance, "number");
  ["full", "short"].forEach((profile) => {
    const budgets = budgetsForProfile(budgetsFile, profile);
    const keys = Object.keys(budgets.metrics);
    assert.ok(keys.length > 0, profile + " has budgets");
    keys.forEach((key) => {
      assert.match(
        key,
        /^[a-z]+(\.[a-z]+)?\.perf[0-9]+\.[A-Za-z][A-Za-z0-9]*$/,
        key,
      );
      normalizeBudget(budgets.metrics[key]);
    });
  });
  assert.throws(
    () => budgetsForProfile(budgetsFile, "nope"),
    /no "nope" profile/,
  );
});

test("scalingExponent and growthLabel classify growth", () => {
  const flat = scalingExponent([
    [100, 50],
    [500, 51],
    [1000, 50],
  ]);
  const linear = scalingExponent([
    [100, 10],
    [500, 50],
    [1000, 100],
  ]);
  const square = scalingExponent([
    [100, 1],
    [500, 25],
    [1000, 100],
  ]);
  assert.ok(Math.abs(flat) < 0.05);
  assert.ok(Math.abs(linear - 1) < 0.001);
  assert.ok(Math.abs(square - 2) < 0.001);
  assert.equal(growthLabel(flat), "flat");
  assert.equal(growthLabel(0.5), "sub-linear");
  assert.equal(growthLabel(-0.5), "falling");
  assert.equal(growthLabel(linear), "linear");
  assert.equal(growthLabel(square), "super-linear");
  assert.equal(
    scalingExponent([
      [100, 0],
      [500, 0],
    ]),
    null,
  );
  assert.equal(growthLabel(null), "-");
});

test("scale report groups by metric across sizes and projects to 10,000", () => {
  const results = {
    sizes: [100, 1000],
    meta: { frontEnd: "26.8.0", chrome: "x", node: "v22", profile: "scale" },
    scenarios: {
      "site.perf100": { siteJsonKB: 30 },
      "site.perf1000": { siteJsonKB: 300 },
      "outline.perf100": { outlineOpenMs: 100 },
      "outline.perf1000": { outlineOpenMs: 10000 },
      "reader.perf100": { reactionsPerVisit: 1, visits: 40 },
      "reader.perf1000": { reactionsPerVisit: 1, visits: 40 },
      "mobile.deep.perf100": { lighthouseScore: 90 },
      "mobile.deep.perf1000": { lighthouseScore: 0 },
    },
  };
  const rows = scaleRows(results);
  const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r]));
  assert.equal(byMetric["site.siteJsonKB"].growth, "linear");
  assert.ok(Math.abs(byMetric["site.siteJsonKB"].projected - 3000) < 0.001);
  assert.equal(byMetric["outline.outlineOpenMs"].growth, "super-linear");
  assert.equal(byMetric["reader.reactionsPerVisit"].growth, "flat");
  assert.equal(
    byMetric["reader.visits"],
    undefined,
    "run settings are not rows",
  );
  // score 90 -> 0 means what it loses goes 10 -> 100: linear, projected 0
  const score = byMetric["mobile.deep.lighthouseScore (fit on 100 - score)"];
  assert.equal(score.growth, "linear");
  assert.equal(score.projected, 0);
  const md = formatScaleMarkdown(results);
  assert.match(
    md,
    /\| site\.siteJsonKB \| 30 \| 300 \| linear \| 1 \| 3000 \|/,
  );
  assert.match(
    md,
    /Super-linear \(look here first\):\n- outline\.outlineOpenMs/,
  );
  assert.match(md, /projection, not a measurement/);
});

test("results report has one table per scenario", () => {
  const md = formatResultsMarkdown({
    meta: { profile: "short" },
    scenarios: { "reader.perf500": { heapKBPerVisit: 12.345 } },
  });
  assert.match(md, /## reader\.perf500/);
  assert.match(md, /\| heapKBPerVisit \| 12\.3 \|/);
});
