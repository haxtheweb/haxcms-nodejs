"use strict";

// lifecycle: archive site (+ site info)
//
// POST /system/api/v1/sites/{siteName}/archive is HAXcms's "delete": it moves
// _sites/<name> into _archived/. The route module
// (src/systemRoutes/v1/routes/archiveSite.js) had no direct coverage; the
// lifecycle collision fallback was only tested with a stubbed delegate. This
// runs the REAL lifecycle.archiveSite -> archiveSite.js path against REAL
// sites created in a temp HAXCMS_ROOT:
//   - archive moves the directory (contents intact), creates _archived when
//     missing, and the site no longer loads
//   - repeat archives of the same name land at name-1, name-2 (existing
//     archives untouched)
//   - the route param wins over a body site name
//   - an unknown site is a 500 that moves nothing
//   - a traversal name never moves anything outside _sites
// and GET /system/api/v1/sites/{siteName} (siteInfo.js): 400 without a name,
// 404 for an unknown site, and the 200 shape with its lifecycle links.
//
// Parity: haxcms-php carries a test under the same name.
// CommonJS, globalThis, NO optional chaining, node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-archive-"));
// HAXCMS reads HAXCMS_ROOT at require time; trailing slash is required
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const lifecycle = require("../../src/systemRoutes/v1/lifecycle.js");

const sitesRoot = path.join(testRoot, HAXCMS.sitesDirectory);
const archivedRoot = path.join(testRoot, HAXCMS.archivedDirectory);

test.after(() => {
  fs.removeSync(testRoot);
});

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    send(obj) {
      this.body = obj;
      return this;
    },
  };
}

let siteCounter = 0;
async function makeSite(base) {
  siteCounter += 1;
  const name = base + siteCounter;
  const site = await HAXCMS.createSite(name);
  assert.ok(site, "site " + name + " is created");
  assert.ok(fs.existsSync(path.join(sitesRoot, name, "site.json")));
  // a marker proves the same directory (not a copy) is what got moved
  fs.writeFileSync(path.join(sitesRoot, name, "marker.txt"), name);
  return name;
}

async function archive(siteName, bodyName) {
  const res = stubRes();
  await lifecycle.archiveSite(
    {
      params: { siteName: siteName },
      body: bodyName ? { site: { name: bodyName } } : {},
      headers: {},
      query: {},
    },
    res,
  );
  return res;
}

describe("lifecycle: archive site", () => {
  test("archiving moves the site into _archived (created on demand) and it no longer loads", async () => {
    fs.removeSync(archivedRoot);
    const name = await makeSite("arch");
    const res = await archive(name);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 200);
    assert.equal(res.body.data.name, name);
    assert.equal(res.body.data.archivedName, name);
    assert.equal(res.body.data.detail, "Site archived");
    assert.equal(
      fs.existsSync(path.join(sitesRoot, name)),
      false,
      "source is gone",
    );
    assert.equal(
      fs.readFileSync(path.join(archivedRoot, name, "marker.txt"), "utf8"),
      name,
      "the site directory itself moved, contents intact",
    );
    assert.ok(fs.existsSync(path.join(archivedRoot, name, "site.json")));
    assert.equal(
      await HAXCMS.loadSite(name),
      false,
      "an archived site does not load",
    );
  });

  test("repeat archives of one name land at name-1 then name-2, older archives untouched", async () => {
    const name = await makeSite("again");
    assert.equal((await archive(name)).body.data.archivedName, name);
    // recreate under the same name, twice
    for (let i = 1; i <= 2; i++) {
      await HAXCMS.createSite(name);
      fs.writeFileSync(path.join(sitesRoot, name, "marker.txt"), "round-" + i);
      const res = await archive(name);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.archivedName, name + "-" + i);
      assert.equal(
        fs.readFileSync(
          path.join(archivedRoot, name + "-" + i, "marker.txt"),
          "utf8",
        ),
        "round-" + i,
      );
    }
    assert.equal(
      fs.readFileSync(path.join(archivedRoot, name, "marker.txt"), "utf8"),
      name,
      "the first archive was not overwritten",
    );
    assert.equal(fs.existsSync(path.join(sitesRoot, name)), false);
  });

  // parity with haxcms-php archiveSite.php: a renamed archive says so
  test("a renamed archive says so in detail", async () => {
    const name = await makeSite("detail");
    await archive(name);
    await HAXCMS.createSite(name);
    const res = await archive(name);
    assert.equal(res.body.data.archivedName, name + "-1");
    assert.equal(
      res.body.data.detail,
      "Site archived as " +
        name +
        "-1 because an archived copy already existed",
    );
  });

  test("the route param wins over a different body site name", async () => {
    const target = await makeSite("param");
    const bystander = await makeSite("bystander");
    const res = await archive(target, bystander);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.archivedName, target);
    assert.equal(
      fs.existsSync(path.join(sitesRoot, bystander, "site.json")),
      true,
      "body name untouched",
    );
    assert.equal(fs.existsSync(path.join(sitesRoot, target)), false);
  });

  test("an unknown site is a 500 that moves nothing", async () => {
    const before = fs.existsSync(archivedRoot)
      ? fs.readdirSync(archivedRoot).sort()
      : [];
    const res = await archive("no-such-site-here");
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, {
      status: 500,
      data: { message: "Site does not exist" },
    });
    const after = fs.existsSync(archivedRoot)
      ? fs.readdirSync(archivedRoot).sort()
      : [];
    assert.deepEqual(after, before);
  });

  test("a traversal site name never moves anything outside _sites", async () => {
    // a sibling of _sites that a naive join would reach
    const victim = path.join(testRoot, "victim");
    fs.ensureDirSync(victim);
    fs.writeFileSync(path.join(victim, "keep.txt"), "keep");
    const names = ["../victim", "..%2Fvictim", "%2e%2e/victim", "..\\victim"];
    for (let i = 0; i < names.length; i++) {
      let res = stubRes();
      try {
        res = await archive(names[i]);
      } catch {
        // a thrown error is also a refusal; only the filesystem matters here
      }
      assert.ok(
        !(res.body && res.body.status === 200),
        names[i] + " must not archive",
      );
      assert.equal(
        fs.readFileSync(path.join(victim, "keep.txt"), "utf8"),
        "keep",
        names[i],
      );
    }
    assert.equal(fs.existsSync(path.join(archivedRoot, "victim")), false);
  });
});

describe("lifecycle: site info", () => {
  test("no site name is a 400", async () => {
    const res = stubRes();
    await lifecycle.siteInfo(
      { params: {}, body: {}, query: {}, headers: {} },
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      status: 400,
      data: { message: "siteName is required" },
    });
  });

  test("an unknown site is a 404", async () => {
    const res = stubRes();
    await lifecycle.siteInfo(
      {
        params: { siteName: "missing-site" },
        body: {},
        query: {},
        headers: {},
      },
      res,
    );
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, {
      status: 404,
      data: { message: "Site not found" },
    });
  });

  test("a real site answers its summary and lifecycle links", async () => {
    const name = await makeSite("info");
    const res = stubRes();
    await lifecycle.siteInfo(
      { params: { siteName: name }, body: {}, query: {}, headers: {} },
      res,
    );
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.name, name);
    assert.equal(typeof data.id, "string");
    assert.equal(typeof data.title, "string");
    assert.ok(
      data.location.endsWith("/" + HAXCMS.sitesDirectory + "/" + name + "/"),
    );
    assert.equal(typeof data.metadata.pageCount, "number");
    assert.ok(
      data.metadata.pageCount >= 1,
      "createSite seeds at least one page",
    );
    assert.ok(
      data.metadata.created === null ||
        !Number.isNaN(Date.parse(data.metadata.created)),
    );
    const base = "/system/api/v1/sites/" + name;
    assert.ok(data.links.self.endsWith(base));
    assert.ok(data.links.clone.endsWith(base + "/clone"));
    assert.ok(data.links.archive.endsWith(base + "/archive"));
    assert.ok(data.links.download.endsWith(base + "/download"));
    assert.ok(
      data.links.downloadSkeleton.endsWith(base + "/download-skeleton"),
    );
    assert.ok(data.links.saveAsTemplate.endsWith(base + "/save-as-template"));
    assert.ok(
      data.links.siteApi.endsWith(
        "/" + HAXCMS.sitesDirectory + "/" + name + "/x/api",
      ),
    );
  });

  test("the site name is also read from the body or the query", async () => {
    const name = await makeSite("infosrc");
    const viaBody = stubRes();
    await lifecycle.siteInfo(
      { body: { site: { name: name } }, query: {}, headers: {} },
      viaBody,
    );
    assert.equal(viaBody.statusCode, 200);
    assert.equal(viaBody.body.data.name, name);
    const siteInfoRoute = require("../../src/systemRoutes/v1/routes/siteInfo.js");
    const viaQuery = stubRes();
    await siteInfoRoute(
      { body: {}, query: { siteName: "/" + name + "/" }, headers: {} },
      viaQuery,
    );
    assert.equal(viaQuery.statusCode, 200);
    assert.equal(
      viaQuery.body.data.name,
      name,
      "slashes around the name are trimmed",
    );
  });
});
