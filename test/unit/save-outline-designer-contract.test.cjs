"use strict";

// The outline designer and saveOutline have to agree on the data they pass:
// what the designer shows after an edit is what saveOutline must store.
//
// fixtures/outline-designer-sessions.json holds real outline-designer
// getData() output for a set of editing sessions (keyboard moves, indent and
// outdent, deleting a parent with its sub-pages, delete then undo, adding a
// page part-way down a list, adding at the top, duplicating, locking,
// deleting a selection, a mouse drag, and a combined edit), captured from
// haxtheweb/webcomponents (see its capturedFrom). Each session records:
//   - sent:  the items the designer hands to saveOutline
//   - shown: the outline the designer showed, as "title<parent title" in the
//            order the rows appeared (deleted pages left out)
// The same fixture and test live in haxcms-php
// (tests/Unit/OperationsSaveOutlineDesignerContractTest.php); when the
// designer changes what it sends, regenerate the fixture and update both.
//
// Runs the REAL saveOutline route against a REAL site. CommonJS, globalThis,
// no optional chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "saveoutline-contract-"),
);
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const JSONOutlineSchemaItem = require("../../src/lib/JSONOutlineSchemaItem.js");
const saveOutline = require("../../src/siteRoutes/v1/routes/saveOutline.js");

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "outline-designer-sessions.json"),
    "utf8",
  ),
);

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
    path.join(os.tmpdir(), "saveoutline-contract-config-"),
  );
  const originalConfigDirectory = HAXCMS.configDirectory;
  HAXCMS.configDirectory = tmpDir;
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory;
    fs.removeSync(tmpDir);
  });
}

function mockAuth(t) {
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
}

function makeReq(siteName, items) {
  return {
    headers: { "x-haxcms-site-token": "token" },
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: siteName,
    },
    body: { site: { name: siteName }, items: items },
  };
}

// a site holding exactly the outline the designer was opened on, with the
// same page ids, and a contents file per page
async function buildSite(t, siteName) {
  useTempConfigDirectory(t);
  mockAuth(t);
  assert.ok(await HAXCMS.createSite(siteName), "site is created");
  const site = await HAXCMS.loadSite(siteName);
  site.manifest.items = FIXTURE.initial.map((source) => {
    const item = new JSONOutlineSchemaItem();
    item.id = source.id;
    item.title = source.title;
    item.slug = source.slug;
    item.location = source.location;
    item.parent = source.parent;
    item.indent = source.indent;
    item.order = source.order;
    item.metadata = { created: 1700000000, updated: 1700000000 };
    const file = path.join(site.siteDirectory, source.location);
    fs.ensureDirSync(path.dirname(file));
    fs.writeFileSync(file, "<p>" + source.title + " contents</p>");
    return item;
  });
  await site.manifest.save();
  return HAXCMS.loadSite(siteName);
}

// the stored outline, read the way it is displayed: siblings by order, then
// by their position in site.json
function storedTree(site) {
  const items = site.manifest.items;
  const titleOf = (id) => {
    const found = items.find((i) => i.id === id);
    return found ? found.title : "root";
  };
  const out = [];
  const walk = (parent) =>
    items
      .map((item, position) => ({ item, position }))
      .filter((x) => (x.item.parent || null) === parent)
      .sort(
        (a, b) =>
          parseInt(a.item.order) - parseInt(b.item.order) ||
          a.position - b.position,
      )
      .forEach((x) => {
        out.push(x.item.title + "<" + titleOf(x.item.parent));
        walk(x.item.id);
      });
  walk(null);
  return out;
}

test("the fixture is real designer output", () => {
  assert.ok(FIXTURE.capturedFrom.indexOf("outline-designer") !== -1);
  assert.ok(FIXTURE.scenarios.length >= 10);
  FIXTURE.scenarios.forEach((session) => {
    assert.ok(Array.isArray(session.sent) && session.sent.length > 0);
    assert.ok(Array.isArray(session.shown) && session.shown.length > 0);
  });
});

FIXTURE.scenarios.forEach((session, index) => {
  test("designer -> saveOutline: " + session.description, async (t) => {
    const siteName = "contract-" + index;
    const site = await buildSite(t, siteName);
    t.mock.method(HAXCMS, "loadSite", async () => site);
    const res = stubRes();
    await saveOutline(
      makeReq(siteName, JSON.parse(JSON.stringify(session.sent))),
      res,
    );
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    // what the designer showed is what was stored
    assert.deepEqual(storedTree(site), session.shown);
    // and the same is on disk
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(site.siteDirectory, "site.json"), "utf8"),
    );
    assert.deepEqual(storedTree({ manifest: onDisk }), session.shown);
    // deleted pages are gone; every page sent and not deleted is there
    session.sent.forEach((sent) => {
      const kept = onDisk.items.find(
        (i) => i.id === sent.id || i.title === sent.title,
      );
      if (sent.delete === true) {
        assert.equal(kept, undefined, sent.title + " is deleted");
      } else {
        assert.ok(kept, sent.title + " is kept");
      }
    });
    // per-page settings the designer changed are kept
    session.sent.forEach((sent) => {
      if (sent.delete === true || !sent.metadata) {
        return;
      }
      const kept = onDisk.items.find((i) => i.id === sent.id);
      if (kept && typeof sent.metadata.locked === "boolean") {
        assert.equal(
          Boolean(kept.metadata.locked),
          sent.metadata.locked,
          sent.title + " keeps its lock state",
        );
      }
    });
    // a duplicate gets the contents of the page it copies
    session.sent.forEach((sent) => {
      if (typeof sent.duplicate === "undefined" || sent.delete === true) {
        return;
      }
      const source = onDisk.items.find((i) => i.id === sent.duplicate);
      const copy = onDisk.items.find((i) => i.title === sent.title);
      assert.ok(source && copy, "the duplicate and its source exist");
      assert.equal(
        fs.readFileSync(path.join(site.siteDirectory, copy.location), "utf8"),
        fs.readFileSync(path.join(site.siteDirectory, source.location), "utf8"),
      );
    });
  });
});
