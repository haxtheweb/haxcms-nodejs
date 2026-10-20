const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const {
  createRequestRateLimiter,
} = require("../../src/lib/requestRateLimiter.js");

function get(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path: "/" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });
}
async function withServer(settings, fn) {
  const app = express();
  app.use(createRequestRateLimiter(settings));
  app.get("/", (req, res) => res.send("ok"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(server.address().port);
  } finally {
    server.close();
  }
}

test("returns 429 once the per-window max is exceeded", async () => {
  await withServer({ enabled: true, windowMs: 60000, max: 3 }, async (port) => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push(await get(port));
    assert.deepStrictEqual(codes, [200, 200, 200, 429, 429]);
  });
});

test("disabled setting never throttles", async () => {
  await withServer(
    { enabled: false, windowMs: 60000, max: 1 },
    async (port) => {
      for (let i = 0; i < 5; i++) assert.strictEqual(await get(port), 200);
    },
  );
});

test("HAXCMS settings default generous and clamp config", () => {
  const { HAXCMS } = require("../../src/lib/HAXCMS.js");
  const saved = HAXCMS.config;
  try {
    HAXCMS.config = { security: {} };
    assert.deepStrictEqual(HAXCMS.getRequestRateLimitSettings(), {
      enabled: true,
      windowMs: 60000,
      max: 1500,
    });
    HAXCMS.config = {
      security: { requestRateLimit: { enabled: false, max: "x", windowMs: 5 } },
    };
    const s = HAXCMS.getRequestRateLimitSettings();
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.max, 1500);
    assert.strictEqual(s.windowMs, 1000);
  } finally {
    HAXCMS.config = saved;
  }
});
