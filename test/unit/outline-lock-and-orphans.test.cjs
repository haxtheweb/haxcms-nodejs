"use strict";

// haxtheweb/issues#3360: what a lock protects and where a deleted page's
// children go, on both write paths.
//
//  - A page that was locked and stays locked keeps its title and content
//    through a bulk outline save; it can still move, and its slug follows.
//    A save that locks or unlocks a page applies its other changes to it
//    (outline-designer sends a rename and a lock made before one save
//    together). A bulk save may delete a locked page.
//  - A deleted page's children move up one level, into its place, with
//    slugs and depths to match: through DELETE (deleteNode) and through a
//    bulk save that deletes the parent but keeps the children. A deleted
//    page inside another deleted page hands its children on. A save that
//    deletes a whole branch (what outline-designer sends) moves nothing.
//
// Parity: haxcms-php carries the same scenarios, under the same names, in
// OutlineLockAndOrphansTest.php. CommonJS, NO optional chaining.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lock-orphans-"));
// HAXCMS reads HAXCMS_ROOT at require time; trailing slash is required
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const saveOutline = require("../../src/siteRoutes/v1/routes/saveOutline.js");
const deleteNode = require("../../src/siteRoutes/v1/routes/deleteNode.js");
const { adoptChildren } = require("../../src/lib/outlineUpkeep.js");

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

function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-orphans-cfg-"));
  const originalConfigDirectory = HAXCMS.configDirectory;
  HAXCMS.configDirectory = tmpDir;
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory;
    fs.removeSync(tmpDir);
  });
}

function makeReq(siteName, body) {
  return {
    headers: { "x-haxcms-site-token": "site-token-under-test" },
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: siteName,
    },
    body: Object.assign({ site: { name: siteName } }, body),
  };
}

function siteDir(siteName) {
  return path.join(testRoot, "_sites", siteName);
}

function readItems(siteName) {
  return JSON.parse(
    fs.readFileSync(path.join(siteDir(siteName), "site.json"), "utf8"),
  ).items;
}

function byTitle(siteName, title) {
  return readItems(siteName).find((i) => i.title === title);
}

function pageContent(siteName, item) {
  return fs.readFileSync(path.join(siteDir(siteName), item.location), "utf8");
}

async function save(siteName, items) {
  const res = stubRes();
  await saveOutline(makeReq(siteName, { items: items }), res);
  return res;
}

async function del(siteName, id) {
  const res = stubRes();
  await deleteNode(makeReq(siteName, { node: { id: id } }), res);
  return res;
}

function newPage(id, title, extra) {
  return Object.assign(
    {
      id: id,
      title: title,
      parent: null,
      indent: 0,
      order: 0,
      metadata: {},
      new: true,
    },
    extra || {},
  );
}

// what outline-designer sends for a page: everything site.json has for it
function sent(item, extra) {
  return Object.assign(
    {
      id: item.id,
      title: item.title,
      parent: item.parent,
      indent: item.indent,
      order: item.order,
      slug: item.slug,
      metadata: Object.assign({}, item.metadata || {}),
    },
    extra || {},
  );
}

async function buildSite(t, siteName) {
  useTempConfigDirectory(t);
  assert.ok(await HAXCMS.createSite(siteName), "site is created");
  const site = await HAXCMS.loadSite(siteName);
  site.manifest.items = [];
  await site.manifest.save();
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
}

// Unit (0) > Lesson (0) > Activity (0); Unit > Quiz (1); Next unit (1)
async function buildCourse(t, siteName) {
  await buildSite(t, siteName);
  const res = await save(siteName, [
    newPage("u", "Unit", { contents: "<p>u</p>" }),
    newPage("l", "Lesson", {
      parent: "u",
      indent: 1,
      contents: "<p>l</p>",
    }),
    newPage("a", "Activity", {
      parent: "l",
      indent: 2,
      contents: "<p>a</p>",
    }),
    newPage("q", "Quiz", {
      parent: "u",
      indent: 1,
      order: 1,
      contents: "<p>q</p>",
    }),
    newPage("n", "Next unit", { order: 1, contents: "<p>n</p>" }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
}

function shape(siteName) {
  const items = readItems(siteName);
  const title = (id) => {
    const it = items.find((i) => i.id === id);
    return it ? it.title : id;
  };
  return items
    .map((i) => [
      i.title,
      i.parent ? title(i.parent) : null,
      i.order,
      i.indent,
      i.slug,
    ])
    .sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

// ---------------------------------------------------------------------------
// adoptChildren
// ---------------------------------------------------------------------------

test("adoptChildren: children take the deleted page's place under its parent", () => {
  const items = [
    { id: "u", parent: null, order: 0 },
    { id: "a", parent: "l", order: 1 },
    { id: "b", parent: "l", order: 0 },
    { id: "q", parent: "u", order: 1 },
    { id: "r", parent: "u", order: 2 },
  ];
  // l was u's child at order 0 and is gone
  const moved = adoptChildren(items, { id: "l", parent: "u", order: 0 });
  assert.deepEqual(
    moved.map((i) => i.id),
    ["b", "a"],
  );
  const order = (id) => items.find((i) => i.id === id);
  assert.equal(order("b").parent, "u");
  assert.equal(order("b").order, 0);
  assert.equal(order("a").order, 1);
  // the siblings after the slot moved down by one (two children, one slot)
  assert.equal(order("q").order, 2);
  assert.equal(order("r").order, 3);
  assert.equal(order("u").order, 0);
});

test("adoptChildren: a page without children moves nothing", () => {
  const items = [{ id: "u", parent: null, order: 0 }];
  assert.deepEqual(
    adoptChildren(items, { id: "x", parent: null, order: 0 }),
    [],
  );
  assert.deepEqual(adoptChildren(items, null), []);
  assert.equal(items[0].order, 0);
});

// ---------------------------------------------------------------------------
// single delete
// ---------------------------------------------------------------------------

test("delete: a deleted page's children move up one level into its place", async (t) => {
  const siteName = "orphans-single";
  await buildCourse(t, siteName);
  const lesson = byTitle(siteName, "Lesson");
  const res = await del(siteName, lesson.id);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(shape(siteName), [
    ["Activity", "Unit", 0, 1, "unit/activity"],
    ["Next unit", null, 1, 0, "next-unit"],
    ["Quiz", "Unit", 1, 1, "unit/quiz"],
    ["Unit", null, 0, 0, "unit"],
  ]);
});

test("delete: a top-level page's children move to the top level in its place", async (t) => {
  const siteName = "orphans-single-top";
  await buildCourse(t, siteName);
  const unit = byTitle(siteName, "Unit");
  const res = await del(siteName, unit.id);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(shape(siteName), [
    ["Activity", "Lesson", 0, 1, "lesson/activity"],
    ["Lesson", null, 0, 0, "lesson"],
    ["Next unit", null, 2, 0, "next-unit"],
    ["Quiz", null, 1, 0, "quiz"],
  ]);
});

// ---------------------------------------------------------------------------
// bulk save: deletes
// ---------------------------------------------------------------------------

test("bulk delete: children the save keeps move up one level into the parent's place", async (t) => {
  const siteName = "orphans-bulk";
  await buildCourse(t, siteName);
  const items = readItems(siteName);
  const lesson = byTitle(siteName, "Lesson");
  const res = await save(
    siteName,
    items.map((i) =>
      i.id === lesson.id ? sent(i, { delete: true }) : sent(i),
    ),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(shape(siteName), [
    ["Activity", "Unit", 0, 1, "unit/activity"],
    ["Next unit", null, 1, 0, "next-unit"],
    ["Quiz", "Unit", 1, 1, "unit/quiz"],
    ["Unit", null, 0, 0, "unit"],
  ]);
});

test("bulk delete: a deleted page inside a deleted page hands its children on", async (t) => {
  const siteName = "orphans-bulk-nested";
  await buildCourse(t, siteName);
  const items = readItems(siteName);
  const gone = new Set([
    byTitle(siteName, "Unit").id,
    byTitle(siteName, "Lesson").id,
  ]);
  const res = await save(
    siteName,
    items.map((i) => (gone.has(i.id) ? sent(i, { delete: true }) : sent(i))),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(shape(siteName), [
    ["Activity", null, 0, 0, "activity"],
    ["Next unit", null, 2, 0, "next-unit"],
    ["Quiz", null, 1, 0, "quiz"],
  ]);
});

test("bulk delete: deleting a whole branch, as outline-designer does, moves nothing", async (t) => {
  const siteName = "orphans-bulk-branch";
  await buildCourse(t, siteName);
  const items = readItems(siteName);
  const gone = new Set(
    ["Lesson", "Activity"].map((title) => byTitle(siteName, title).id),
  );
  const res = await save(
    siteName,
    items.map((i) => (gone.has(i.id) ? sent(i, { delete: true }) : sent(i))),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(shape(siteName), [
    ["Next unit", null, 1, 0, "next-unit"],
    ["Quiz", "Unit", 1, 1, "unit/quiz"],
    ["Unit", null, 0, 0, "unit"],
  ]);
});

test("bulk delete: a locked page can be deleted", async (t) => {
  const siteName = "lock-bulk-delete";
  await buildCourse(t, siteName);
  const items = readItems(siteName);
  const next = byTitle(siteName, "Next unit");
  const res = await save(
    siteName,
    items.map((i) =>
      i.id === next.id
        ? sent(i, { delete: true, metadata: { locked: true } })
        : sent(i),
    ),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(byTitle(siteName, "Next unit"), undefined);
});

// ---------------------------------------------------------------------------
// bulk save: locked pages
// ---------------------------------------------------------------------------

async function lockPage(siteName, title) {
  const items = readItems(siteName);
  const target = byTitle(siteName, title);
  const res = await save(
    siteName,
    items.map((i) =>
      i.id === target.id
        ? sent(i, { metadata: Object.assign({}, i.metadata, { locked: true }) })
        : sent(i),
    ),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return byTitle(siteName, title);
}

test("lock: a bulk save keeps a locked page's title and content and applies the rest", async (t) => {
  const siteName = "lock-bulk-title";
  await buildCourse(t, siteName);
  const quiz = await lockPage(siteName, "Quiz");
  const before = pageContent(siteName, quiz);
  const items = readItems(siteName);
  const next = byTitle(siteName, "Next unit");
  const res = await save(
    siteName,
    items.map((i) => {
      if (i.id === quiz.id) {
        return sent(i, {
          title: "Renamed quiz",
          contents: "<p>replaced</p>",
        });
      }
      if (i.id === next.id) {
        return sent(i, { title: "Unit two", contents: "<p>new</p>" });
      }
      return sent(i);
    }),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const after = readItems(siteName).find((i) => i.id === quiz.id);
  assert.equal(after.title, "Quiz");
  assert.equal(after.metadata.locked, true);
  assert.equal(pageContent(siteName, after), before);
  const two = readItems(siteName).find((i) => i.id === next.id);
  assert.equal(two.title, "Unit two", "the unlocked page still changes");
  assert.match(pageContent(siteName, two), /new/);
});

test("lock: a bulk save can move a locked page and its slug follows", async (t) => {
  const siteName = "lock-bulk-move";
  await buildCourse(t, siteName);
  const quiz = await lockPage(siteName, "Quiz");
  const next = byTitle(siteName, "Next unit");
  const items = readItems(siteName);
  const res = await save(
    siteName,
    items.map((i) =>
      i.id === quiz.id ? sent(i, { parent: next.id, order: 0 }) : sent(i),
    ),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const after = readItems(siteName).find((i) => i.id === quiz.id);
  assert.equal(after.parent, next.id);
  assert.equal(after.slug, "next-unit/quiz");
  assert.equal(after.title, "Quiz");
});

test("lock: unlocking and renaming in one bulk save renames the page", async (t) => {
  const siteName = "lock-bulk-unlock";
  await buildCourse(t, siteName);
  const quiz = await lockPage(siteName, "Quiz");
  const items = readItems(siteName);
  const res = await save(
    siteName,
    items.map((i) =>
      i.id === quiz.id
        ? sent(i, {
            title: "Final quiz",
            contents: "<p>edited</p>",
            metadata: Object.assign({}, i.metadata, { locked: false }),
          })
        : sent(i),
    ),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const after = readItems(siteName).find((i) => i.id === quiz.id);
  assert.equal(after.title, "Final quiz");
  assert.match(pageContent(siteName, after), /edited/);
});

test("lock: renaming and locking in one bulk save renames the page", async (t) => {
  const siteName = "lock-bulk-lock-and-rename";
  await buildCourse(t, siteName);
  const quiz = byTitle(siteName, "Quiz");
  const items = readItems(siteName);
  const res = await save(
    siteName,
    items.map((i) =>
      i.id === quiz.id
        ? sent(i, {
            title: "Final quiz",
            metadata: Object.assign({}, i.metadata, { locked: true }),
          })
        : sent(i),
    ),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const after = readItems(siteName).find((i) => i.id === quiz.id);
  assert.equal(after.title, "Final quiz");
  assert.equal(after.metadata.locked, true);
});

test("lock: a save that sends no lock flag keeps what site.json says", async (t) => {
  const siteName = "lock-bulk-no-flag";
  await buildCourse(t, siteName);
  const quiz = await lockPage(siteName, "Quiz");
  const items = readItems(siteName);
  // an API client that sends no metadata at all
  const res = await save(
    siteName,
    items.map((i) => {
      const out = sent(i, i.id === quiz.id ? { title: "Sneaky" } : {});
      delete out.metadata;
      return out;
    }),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(readItems(siteName).find((i) => i.id === quiz.id).title, "Quiz");
});

test("lock: a new page sent as locked gets its title and content", async (t) => {
  const siteName = "lock-bulk-new";
  await buildSite(t, siteName);
  const res = await save(siteName, [
    newPage("x", "Locked from the start", {
      contents: "<p>x</p>",
      metadata: { locked: true },
    }),
  ]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const made = byTitle(siteName, "Locked from the start");
  assert.ok(made);
  assert.match(pageContent(siteName, made), /<p>x<\/p>/);
});
