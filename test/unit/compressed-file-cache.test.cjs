const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const http = require("http");
const express = require("express");
const compression = require("compression");
const cache = require("../../src/lib/compressedFileCache.js");

// a small app that serves a folder the way the site routes do: the cache
// first, res.sendFile when the cache declines
function startServer(root, { useCache = true } = {}) {
  const app = express();
  app.use(compression());
  app.use(async (req, res) => {
    const filePath = decodeURIComponent(req.url.split("?")[0]);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (useCache && (await cache.trySend(req, res, root, filePath))) {
      return;
    }
    res.sendFile(filePath, { root }, (err) => {
      if (err && !res.headersSent) {
        res.status(err.status || 500).end();
      }
    });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function get(server, urlPath, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path: urlPath,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function decode(response) {
  const encoding = response.headers["content-encoding"];
  if (encoding === "br") {
    return zlib.brotliDecompressSync(response.body).toString("utf8");
  }
  if (encoding === "gzip") {
    return zlib.gunzipSync(response.body).toString("utf8");
  }
  return response.body.toString("utf8");
}

function makeSite(items = 200) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-cfc-"));
  fs.mkdirSync(path.join(root, "mysite"));
  const manifest = {
    title: "Cache test",
    items: Array.from({ length: items }, (_, i) => ({
      id: "item-" + i,
      title: "Page " + i,
      slug: "page-" + i,
    })),
  };
  const file = path.join(root, "mysite", "site.json");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return { root, file };
}

test("pickEncoding prefers br, then gzip, and honors q=0", () => {
  assert.equal(cache.pickEncoding("gzip, deflate, br"), "br");
  assert.equal(cache.pickEncoding("gzip, deflate"), "gzip");
  assert.equal(cache.pickEncoding("br;q=0, gzip"), "gzip");
  assert.equal(cache.pickEncoding("br;q=0, gzip;q=0"), "");
  assert.equal(cache.pickEncoding("identity"), "");
  assert.equal(cache.pickEncoding(""), "");
  assert.equal(cache.pickEncoding(undefined), "");
});

test("only a site's site.json is cacheable", () => {
  assert.equal(cache.isCacheableRequestPath("/mysite/site.json"), true);
  assert.equal(cache.isCacheableRequestPath("/site.json"), true);
  assert.equal(cache.isCacheableRequestPath("/mysite/xsite.json"), false);
  assert.equal(cache.isCacheableRequestPath("/mysite/site.json.bak"), false);
  assert.equal(
    cache.isCacheableRequestPath("/mysite/pages/a/index.html"),
    false,
  );
});

test("site.json is served compressed, and the same bytes are reused", async () => {
  cache.resetForTesting();
  const { root, file } = makeSite();
  const server = await startServer(root);
  try {
    const expected = fs.readFileSync(file, "utf8");
    for (const encoding of ["br", "gzip"]) {
      const first = await get(server, "/mysite/site.json", {
        "accept-encoding": encoding,
      });
      const second = await get(server, "/mysite/site.json", {
        "accept-encoding": encoding,
      });
      assert.equal(first.status, 200);
      assert.equal(first.headers["content-encoding"], encoding);
      assert.equal(
        first.headers["content-type"],
        "application/json; charset=utf-8",
      );
      assert.match(first.headers.vary, /Accept-Encoding/i);
      assert.equal(Number(first.headers["content-length"]), first.body.length);
      assert.equal(decode(first), expected);
      assert.deepEqual(second.body, first.body);
    }
    assert.equal(cache.stats().files, 1);
    assert.ok(cache.stats().bytes > 0);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validators match what res.sendFile sends, and 304s work", async () => {
  cache.resetForTesting();
  const { root } = makeSite();
  const cached = await startServer(root);
  const plain = await startServer(root, { useCache: false });
  try {
    const viaCache = await get(cached, "/mysite/site.json", {
      "accept-encoding": "gzip",
    });
    const viaSendFile = await get(plain, "/mysite/site.json", {
      "accept-encoding": "identity",
    });
    assert.equal(viaCache.headers.etag, viaSendFile.headers.etag);
    assert.equal(
      viaCache.headers["last-modified"],
      viaSendFile.headers["last-modified"],
    );
    assert.equal(
      viaCache.headers["cache-control"],
      viaSendFile.headers["cache-control"],
    );
    const byEtag = await get(cached, "/mysite/site.json", {
      "accept-encoding": "gzip",
      "if-none-match": viaCache.headers.etag,
    });
    assert.equal(byEtag.status, 304);
    assert.equal(byEtag.body.length, 0);
    assert.equal(byEtag.headers.etag, viaCache.headers.etag);
    const byDate = await get(cached, "/mysite/site.json", {
      "accept-encoding": "gzip",
      "if-modified-since": viaCache.headers["last-modified"],
    });
    assert.equal(byDate.status, 304);
    const stale = await get(cached, "/mysite/site.json", {
      "accept-encoding": "gzip",
      "if-none-match": 'W/"something-else"',
    });
    assert.equal(stale.status, 200);
  } finally {
    cached.close();
    plain.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a saved site.json is served fresh on the next request", async () => {
  cache.resetForTesting();
  const { root, file } = makeSite();
  const server = await startServer(root);
  try {
    const before = await get(server, "/mysite/site.json", {
      "accept-encoding": "br",
    });
    const manifest = JSON.parse(decode(before));
    manifest.title = "Changed after a save";
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    // same length rewrite still differs by modified time
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    const after = await get(server, "/mysite/site.json", {
      "accept-encoding": "br",
    });
    assert.equal(JSON.parse(decode(after)).title, "Changed after a save");
    assert.notEqual(after.headers.etag, before.headers.etag);
    const oldValidator = await get(server, "/mysite/site.json", {
      "accept-encoding": "br",
      "if-none-match": before.headers.etag,
    });
    assert.equal(oldValidator.status, 200);
    assert.equal(cache.stats().files, 1);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requests the cache cannot answer exactly go the usual way", async () => {
  cache.resetForTesting();
  const { root, file } = makeSite();
  fs.writeFileSync(path.join(root, "mysite", "other.json"), "x".repeat(5000));
  fs.mkdirSync(path.join(root, "tiny"));
  fs.writeFileSync(path.join(root, "tiny", "site.json"), '{"items":[]}');
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, ".hidden", "site.json"), "x".repeat(5000));
  const server = await startServer(root);
  try {
    const expected = fs.readFileSync(file, "utf8");
    const identity = await get(server, "/mysite/site.json", {
      "accept-encoding": "identity",
    });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers["content-encoding"], undefined);
    assert.equal(identity.body.toString("utf8"), expected);
    const ranged = await get(server, "/mysite/site.json", {
      "accept-encoding": "identity",
      range: "bytes=0-9",
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.body.length, 10);
    const head = await get(
      server,
      "/mysite/site.json",
      { "accept-encoding": "gzip" },
      "HEAD",
    );
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    await get(server, "/mysite/other.json", { "accept-encoding": "gzip" });
    await get(server, "/tiny/site.json", { "accept-encoding": "gzip" });
    const missing = await get(server, "/nowhere/site.json", {
      "accept-encoding": "gzip",
    });
    assert.equal(missing.status, 404);
    // dot folders are never answered from the cache
    await get(server, "/.hidden/site.json", { "accept-encoding": "gzip" });
    const climbing = await get(server, "/mysite/%2e%2e/%2e%2e/site.json", {
      "accept-encoding": "gzip",
    });
    assert.notEqual(climbing.status, 200);
    assert.equal(cache.stats().files, 0);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requests arriving together share one compression", async () => {
  cache.resetForTesting();
  const { root, file } = makeSite(2000);
  const server = await startServer(root);
  try {
    const expected = fs.readFileSync(file, "utf8");
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        get(server, "/mysite/site.json", { "accept-encoding": "br" }),
      ),
    );
    responses.forEach((response) => {
      assert.equal(response.status, 200);
      assert.equal(decode(response), expected);
    });
    assert.equal(cache.stats().files, 1);
    assert.equal(cache.stats().bytes, responses[0].body.length);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// haxcms-browser bundles this server with a zlib that has no brotli; loading
// this file there must not throw, and br must not be offered
test("loads and falls back to gzip when zlib has no brotli", () => {
  const modulePath = require.resolve("../../src/lib/compressedFileCache.js");
  const zlibPath = require.resolve("zlib");
  const realZlib = require.cache[zlibPath];
  const savedModule = require.cache[modulePath];
  const noBrotli = Object.assign({}, zlib, {
    brotliCompress: undefined,
    brotliCompressSync: undefined,
  });
  delete require.cache[modulePath];
  const Module = require("module");
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "zlib") {
      return noBrotli;
    }
    return realLoad.call(this, request, ...rest);
  };
  try {
    let browserCache;
    assert.doesNotThrow(() => {
      browserCache = require(modulePath);
    });
    assert.equal(browserCache.pickEncoding("br, gzip"), "gzip");
    assert.equal(browserCache.pickEncoding("br"), "");
  } finally {
    Module._load = realLoad;
    delete require.cache[modulePath];
    if (savedModule) {
      require.cache[modulePath] = savedModule;
    }
    if (realZlib) {
      require.cache[zlibPath] = realZlib;
    }
  }
});
