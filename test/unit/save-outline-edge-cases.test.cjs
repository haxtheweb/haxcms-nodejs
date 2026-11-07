"use strict";

// saveOutline: outline bulk-op edge cases
//
// saveOutline (src/siteRoutes/v1/routes/saveOutline.js) is the outline
// designer's bulk write and is mission-critical: a regression in it rewrites
// many pages at once. The existing suites cover batching, failure parity,
// the designer contract and large outlines; this file pins the branches they
// leave untested, against a REAL site in a temp HAXCMS_ROOT:
//   - auth gates: missing site token, a token that does not validate, or no
//     authenticated user is a 403 and site.json is byte-for-byte unchanged
//   - a site whose platform disables outlineDesigner refuses with 403 and
//     writes nothing
//   - an item sent without `order` takes its position in the request
//   - pathauto off: a client slug change on an existing page is saved
//     normalized, and a clash with a sibling's slug is made unique
//   - an existing page whose file went missing is re-created at
//     pages/<id>/index.html and the save succeeds
//   - a page created and flagged delete in the same request is gone
//   - when the structure pass crashes AND the checkpoint write also fails,
//     the original crash is the error reported
//
// Parity: haxcms-php carries a test under the same name for the same
// behaviors. CommonJS, globalThis, NO optional chaining, node:test +
// node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saveoutline-edge-"));
// HAXCMS reads HAXCMS_ROOT at require time; trailing slash is required
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const saveOutline = require("../../src/siteRoutes/v1/routes/saveOutline.js");

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
  };
}

function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "saveoutline-edge-config-"),
  );
  const originalConfigDirectory = HAXCMS.configDirectory;
  HAXCMS.configDirectory = tmpDir;
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory;
    fs.removeSync(tmpDir);
  });
}

function makeReq(siteName, items, overrides) {
  return Object.assign(
    {
      headers: { "x-haxcms-site-token": "site-token-under-test" },
      haxcmsSiteApiAuth: {
        authenticated: true,
        securityLevel: "authenticated-site",
        userName: "tester",
        siteName: siteName,
      },
      body: { site: { name: siteName }, items: items },
    },
    overrides || {},
  );
}

function siteJsonPath(siteName) {
  return path.join(testRoot, "_sites", siteName, "site.json");
}

function readItems(siteName) {
  return JSON.parse(fs.readFileSync(siteJsonPath(siteName), "utf8")).items;
}

// a real site holding pages A and B at the top level (the boilerplate page
// createSite adds is removed so only these remain)
async function buildSite(t, siteName, settings) {
  useTempConfigDirectory(t);
  assert.ok(await HAXCMS.createSite(siteName), "site is created");
  const site = await HAXCMS.loadSite(siteName);
  site.manifest.items = [];
  site.manifest.metadata.site.settings = Object.assign(
    {},
    site.manifest.metadata.site.settings || {},
    settings || {},
  );
  await site.manifest.save();
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
  const res = stubRes();
  await saveOutline(
    makeReq(siteName, [
      {
        id: "a",
        title: "A",
        parent: null,
        indent: 0,
        order: 0,
        metadata: {},
        contents: "<p>A</p>",
        new: true,
      },
      {
        id: "b",
        title: "B",
        parent: null,
        indent: 0,
        order: 1,
        metadata: {},
        contents: "<p>B</p>",
        new: true,
      },
    ]),
    res,
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return {
    idOf: (title) => readItems(siteName).find((i) => i.title === title).id,
    item: (title) => readItems(siteName).find((i) => i.title === title),
  };
}

// the request an outline designer sends for an unchanged page
function sent(item, extra) {
  return Object.assign(
    {
      id: item.id,
      title: item.title,
      parent: item.parent,
      indent: item.indent,
      order: item.order,
      slug: item.slug,
      metadata: {},
    },
    extra || {},
  );
}

test("auth gates: no token, a bad token, or no user is a 403 that writes nothing", async (t) => {
  const siteName = "edge-auth";
  const ctx = await buildSite(t, siteName);
  const before = fs.readFileSync(siteJsonPath(siteName), "utf8");
  const items = [sent(ctx.item("A"), { title: "Hijacked" })];
  const expected = {
    status: 403,
    data: { message: "Authentication required" },
  };

  const noToken = stubRes();
  await saveOutline(makeReq(siteName, items, { headers: {} }), noToken);
  assert.equal(noToken.statusCode, 403);
  assert.deepEqual(noToken.body, expected);

  const noUser = stubRes();
  await saveOutline(
    makeReq(siteName, items, { haxcmsSiteApiAuth: null }),
    noUser,
  );
  assert.equal(noUser.statusCode, 403);
  assert.deepEqual(noUser.body, expected);

  // the token is checked against "<user>:<site>"
  const seen = [];
  t.mock.method(HAXCMS, "validateRequestToken", (token, value) => {
    seen.push(value);
    return false;
  });
  const badToken = stubRes();
  await saveOutline(makeReq(siteName, items), badToken);
  assert.equal(badToken.statusCode, 403);
  assert.deepEqual(badToken.body, expected);
  assert.deepEqual(seen, ["tester:" + siteName]);

  assert.equal(
    fs.readFileSync(siteJsonPath(siteName), "utf8"),
    before,
    "site.json untouched",
  );
});

test("a site with outlineDesigner disabled refuses with 403 and writes nothing", async (t) => {
  const siteName = "edge-feature-off";
  const ctx = await buildSite(t, siteName);
  const site = await HAXCMS.loadSite(siteName);
  site.manifest.metadata.platform = { features: { outlineDesigner: false } };
  await site.manifest.save();
  const before = fs.readFileSync(siteJsonPath(siteName), "utf8");
  const res = stubRes();
  await saveOutline(
    makeReq(siteName, [sent(ctx.item("A"), { title: "Renamed" })]),
    res,
  );
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    status: 403,
    data: { message: "Outline operations are disabled for this site" },
  });
  assert.equal(
    fs.readFileSync(siteJsonPath(siteName), "utf8"),
    before,
    "site.json untouched",
  );
});

test("an item sent without an order takes its position in the request", async (t) => {
  const siteName = "edge-no-order";
  const ctx = await buildSite(t, siteName);
  const b = sent(ctx.item("B"));
  const a = sent(ctx.item("A"));
  delete b.order;
  delete a.order;
  const res = stubRes();
  // B first, A second, neither carries an order
  await saveOutline(makeReq(siteName, [b, a]), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(ctx.item("B").order, 0);
  assert.equal(ctx.item("A").order, 1);
});

test("pathauto off: a slug change is saved normalized and a clash is made unique", async (t) => {
  const siteName = "edge-slug";
  const ctx = await buildSite(t, siteName, { pathauto: false });
  const res = stubRes();
  await saveOutline(
    makeReq(siteName, [
      sent(ctx.item("A"), { slug: "Brand New Slug" }),
      sent(ctx.item("B")),
    ]),
    res,
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const renamed = ctx.item("A").slug;
  assert.equal(renamed, HAXCMS.generateSlugName("Brand New Slug"));
  // now ask for B to take A's slug
  const clash = stubRes();
  await saveOutline(
    makeReq(siteName, [
      sent(ctx.item("A")),
      sent(ctx.item("B"), { slug: renamed }),
    ]),
    clash,
  );
  assert.equal(clash.statusCode, 200, JSON.stringify(clash.body));
  assert.equal(
    ctx.item("A").slug,
    renamed,
    "the page that had the slug keeps it",
  );
  assert.notEqual(
    ctx.item("B").slug,
    renamed,
    "the clashing page gets a unique slug",
  );
  assert.ok(
    ctx.item("B").slug.indexOf(renamed) === 0,
    "derived from the requested slug",
  );
});

test("an existing page whose file went missing is re-created and the save succeeds", async (t) => {
  const siteName = "edge-missing-file";
  const ctx = await buildSite(t, siteName, { pathauto: false });
  const a = ctx.item("A");
  const pageFile = path.join(testRoot, "_sites", siteName, a.location);
  fs.removeSync(path.dirname(pageFile));
  assert.equal(fs.existsSync(pageFile), false);
  const res = stubRes();
  await saveOutline(makeReq(siteName, [sent(a), sent(ctx.item("B"))]), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const after = ctx.item("A");
  assert.equal(after.id, a.id);
  assert.equal(after.location, "pages/" + a.id + "/index.html");
  assert.ok(
    fs.existsSync(path.join(testRoot, "_sites", siteName, after.location)),
    "the page file exists again",
  );
});

test("a page created and flagged delete in the same request is gone", async (t) => {
  const siteName = "edge-create-delete";
  const ctx = await buildSite(t, siteName);
  const res = stubRes();
  await saveOutline(
    makeReq(siteName, [
      sent(ctx.item("A")),
      sent(ctx.item("B")),
      {
        id: "client-temp",
        title: "Temp",
        parent: null,
        indent: 0,
        order: 2,
        metadata: {},
        contents: "<p>temp</p>",
        new: true,
        delete: true,
      },
    ]),
    res,
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const mapped = res.body.data.idMap["client-temp"];
  assert.equal(typeof mapped, "string", "the new page got a server id");
  const items = readItems(siteName);
  assert.equal(
    items.some((i) => i.id === mapped || i.title === "Temp"),
    false,
  );
  // (deleteNode only drops the outline entry; page files stay on disk for
  // the git history, the same as deleting an existing page)
  assert.deepEqual(items.map((i) => i.title).sort(), ["A", "B"]);
});

test("a structure crash whose checkpoint write also fails reports the original crash", async (t) => {
  const siteName = "edge-double-fault";
  const ctx = await buildSite(t, siteName);
  const site = await HAXCMS.loadSite(siteName);
  t.mock.method(HAXCMS, "loadSite", async () => site);
  // the second new page's folder copy fails...
  let copies = 0;
  const copy = HAXCMS.recurseCopy.bind(HAXCMS);
  t.mock.method(HAXCMS, "recurseCopy", async (...args) => {
    copies++;
    if (copies === 2) {
      throw new Error("structure crash");
    }
    return copy(...args);
  });
  // ...and so does the site.json write the error handler attempts
  t.mock.method(site.manifest, "save", async () => {
    throw new Error("checkpoint write failed");
  });
  const newPage = (id, order) => ({
    id: id,
    title: id,
    parent: null,
    indent: 0,
    order: order,
    metadata: {},
    new: true,
  });
  let thrown = null;
  try {
    await saveOutline(
      makeReq(siteName, [
        sent(ctx.item("A")),
        sent(ctx.item("B")),
        newPage("n1", 2),
        newPage("n2", 3),
      ]),
      stubRes(),
    );
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, "the failure propagates");
  assert.equal(thrown.message, "structure crash");
  assert.ok(
    site.manifest.save.mock.callCount() >= 1,
    "the checkpoint write was attempted",
  );
});
