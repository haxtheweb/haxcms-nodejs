"use strict";

// Outline designer fuzz smoke test (runs with npm run test:e2e). One seeded
// session of 60 random edits in the real designer with a save + full check
// every 15 edits, plus a self-test that the checks catch a save that does not
// match what the designer showed. Longer runs: npm run fuzz:outline.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  setupE2ERuntime,
  teardownE2ERuntime,
} = require("./helpers/harness.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const { createFixtureSite } = require("../perf/fixture.cjs");
const { runOutlineFuzz } = require("../fuzz/outline-designer.cjs");

let runtime = null;
let browser = null;

test.before(async () => {
  runtime = await setupE2ERuntime();
  browser = await launchBrowser();
});

test.after(async () => {
  if (browser) {
    await browser.close();
  }
  await teardownE2ERuntime(runtime);
});

async function session(siteName, extra) {
  await createFixtureSite(
    runtime.baseUrl,
    runtime.credentials,
    "perf40",
    siteName,
  );
  return runOutlineFuzz(
    browser,
    Object.assign(
      {
        baseUrl: runtime.baseUrl,
        site: siteName,
        credentials: runtime.credentials,
        siteDirectory: path.join(runtime.runtimeRoot, "_sites", siteName),
        seed: 7,
        ops: 60,
        saveEvery: 15,
      },
      extra || {},
    ),
  );
}

test(
  "60 random designer edits save exactly what the designer showed",
  { timeout: 600000 },
  async () => {
    const result = await session("fuzz-smoke");
    assert.equal(result.failure, null);
    assert.equal(result.ok, true);
    assert.equal(result.saves, 4);
    assert.ok(result.applied > 30, "most edits applied: " + result.applied);
  },
);

test(
  "the checks catch a save that differs from what the designer showed",
  { timeout: 600000 },
  async () => {
    const result = await session("fuzz-selftest", {
      ops: 5,
      saveEvery: 5,
      // move the last top-level page to the front of the outline behind the
      // designer's back
      tamperPayload: (items) => {
        const roots = items.filter((i) => !i.parent && !i.delete);
        roots[roots.length - 1].order = -1;
        return items;
      },
    });
    assert.equal(result.ok, false);
    assert.match(
      result.failure,
      /stored outline differs from what the designer showed/,
    );
  },
);
