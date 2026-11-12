// Heap guard for sanitizeHTMLForStorage
// (https://github.com/haxtheweb/issues/issues/3271,
// https://github.com/haxtheweb/issues/issues/3320).
//
// Rules:
// 1. Repeated calls do not grow the heap once the event loop turns.
// 2. Within one synchronous run, each call keeps only its own parsed
//    documents reachable (released when the run ends), never a whole jsdom
//    window per call.
// Runs in a child process because measuring needs --expose-gc.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SANITIZE = path.join(__dirname, "../../src/lib/sanitizeContent.js");
const AWAITED_CALLS = 400;
const SYNC_CALLS = 100;
// Rule 1: a per-call leak of even 50 KB would grow the heap about 20 MB here.
const FLAT_LIMIT_MB = 10;
// Rule 2: this input keeps about 270 KB per call until the run ends; a jsdom
// window per call (the pre-2026-11 code) keeps about 1.3 MB.
const IN_RUN_LIMIT_KB_PER_CALL = 700;

const CHILD = `
const { sanitizeHTMLForStorage } = require(${JSON.stringify(SANITIZE)});
const html = (
  '<p>Hello <a href="https://example.com">link</a></p>' +
  '<div><template><b>t</b></template><img src="a.png" alt="x">' +
  '<iframe src="https://www.youtube.com/embed/x"></iframe>' +
  '<svg><iframe></iframe></svg></div>'
).repeat(5);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settledHeap() {
  for (let i = 0; i < 3; i++) {
    global.gc();
    await tick();
  }
  return process.memoryUsage().heapUsed;
}
(async () => {
  for (let i = 0; i < 50; i++) {
    sanitizeHTMLForStorage(html);
    await tick();
  }
  const before = await settledHeap();
  for (let i = 0; i < ${AWAITED_CALLS}; i++) {
    sanitizeHTMLForStorage(html);
    await tick();
  }
  const afterAwaited = await settledHeap();
  for (let i = 0; i < ${SYNC_CALLS}; i++) sanitizeHTMLForStorage(html);
  global.gc();
  const inRun = process.memoryUsage().heapUsed;
  const afterRun = await settledHeap();
  process.stdout.write(
    JSON.stringify({ before, afterAwaited, inRun, afterRun }),
  );
})();
`;

test("sanitizeHTMLForStorage heap stays flat and per-run retention stays bounded", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", "-e", CHILD], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { before, afterAwaited, inRun, afterRun } = JSON.parse(result.stdout);
  const mb = (bytes) => bytes / 1048576;
  assert.ok(
    mb(afterAwaited - before) < FLAT_LIMIT_MB,
    `heap grew ${mb(afterAwaited - before).toFixed(1)} MB over ${AWAITED_CALLS} awaited calls`,
  );
  const perCallKB = (inRun - afterAwaited) / 1024 / SYNC_CALLS;
  assert.ok(
    perCallKB < IN_RUN_LIMIT_KB_PER_CALL,
    `a synchronous run kept ${perCallKB.toFixed(0)} KB per call reachable`,
  );
  assert.ok(
    mb(afterRun - before) < FLAT_LIMIT_MB,
    `heap grew ${mb(afterRun - before).toFixed(1)} MB after a synchronous run ended`,
  );
});
