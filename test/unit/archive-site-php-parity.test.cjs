// archiveSite response parity with haxcms-php (haxtheweb/issues#3254).
//
// PHP (operations/archiveSite.php) explains a renamed archive in `detail`
// ("Site archived as <name>-N because an archived copy already existed") and
// answers a site that doesn't exist with 500 "Site does not exist". Node's
// route said "Site archived" for every archive and "Server error" for a
// missing site.
//
// CommonJS, NO optional chaining, node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "haxcms-archive-parity-"),
);
// HAXCMS reads HAXCMS_ROOT at require time; trailing slash is required
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const archiveSiteRoute = require("../../src/systemRoutes/v1/routes/archiveSite.js");
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
  assert.ok(await HAXCMS.createSite(name), "site " + name + " is created");
  assert.ok(fs.existsSync(path.join(sitesRoot, name, "site.json")));
  return name;
}

async function archive(siteName) {
  const res = stubRes();
  await lifecycle.archiveSite(
    {
      params: { siteName: siteName },
      body: {},
      headers: {},
      query: {},
    },
    res,
  );
  return res;
}

describe("archiveSite (PHP parity)", () => {
  test("a first archive keeps its name and says Site archived", async () => {
    const name = await makeSite("first");
    const res = await archive(name);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.archivedName, name);
    assert.equal(res.body.data.detail, "Site archived");
  });

  test("a renamed archive says so in detail", async () => {
    const name = await makeSite("again");
    assert.equal((await archive(name)).body.data.archivedName, name);
    await HAXCMS.createSite(name);
    const second = await archive(name);
    assert.equal(second.statusCode, 200, JSON.stringify(second.body));
    assert.equal(second.body.data.archivedName, name + "-1");
    assert.equal(
      second.body.data.detail,
      "Site archived as " +
        name +
        "-1 because an archived copy already existed",
    );
    await HAXCMS.createSite(name);
    const third = await archive(name);
    assert.equal(third.body.data.archivedName, name + "-2");
    assert.equal(
      third.body.data.detail,
      "Site archived as " +
        name +
        "-2 because an archived copy already existed",
    );
    // every copy is still there
    [name, name + "-1", name + "-2"].forEach((dir) => {
      assert.ok(fs.existsSync(path.join(archivedRoot, dir, "site.json")), dir);
    });
  });

  test("the route answers a site with no manifest name with 500 Site does not exist", async () => {
    const realLoadSite = HAXCMS.loadSite;
    HAXCMS.loadSite = async () => ({ name: "", manifest: null });
    try {
      const res = stubRes();
      await archiveSiteRoute({ body: { site: { name: "missing" } } }, res);
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.status, 500);
      assert.equal(res.body.data.message, "Site does not exist");
    } finally {
      HAXCMS.loadSite = realLoadSite;
    }
  });
});
