"use strict";

// Fault injection for saveOutline, the outline designer's bulk save, run
// against the REAL route handler and a REAL site on disk (the same harness
// as save-outline-failure-parity.test.cjs). Faults are injected at the
// filesystem boundary with node:test mocks of fs-extra; no production seam
// is added. The HTTP-level half (status, error envelope, server still
// serving) is fault-injection-critical-writes-http.test.cjs.
//
// What saveOutline guarantees today (both backends):
//   - it is NOT atomic. It is checkpointed: the new structure is written to
//     site.json once after the structure pass; a failure in the content or
//     delete phase leaves that structure saved, a failure during the
//     structure pass leaves the pages before it saved
//   - every site.json write is atomic (temp file + rename,
//     JSONOutlineSchema.writeFileAtomic): a failed write leaves the
//     previous site.json as it was
//
// Scenario ids (FI-*) are shared with haxcms-php, which mirrors these
// tests; see "Fault injection testing" in README.md. A scenario whose invariant does
// not hold today is a test.todo with the bug described, not a product fix.
//
// CommonJS, no optional chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saveoutline-fault-"));
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const saveOutline = require("../../src/siteRoutes/v1/routes/saveOutline.js");

const CHILD_HELPER = path.join(
  __dirname,
  "..",
  "_helpers",
  "save-outline-child.cjs",
);
// how long a child gets to finish saveOutline once it has started it; a
// healthy save of two pages takes well under 100ms
const CHILD_SAVE_BUDGET_MS = 1500;

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

function page(id, title, parent, order, extra) {
  return Object.assign(
    {
      id: id,
      title: title,
      parent: parent,
      indent: parent ? 1 : 0,
      order: order,
      metadata: {},
    },
    extra || {},
  );
}

// a site with pages A, B at the top level and A1 under A
async function buildSite(t, siteName) {
  const configDir = fs.mkdtempSync(path.join(testRoot, "config-"));
  const originalConfigDirectory = HAXCMS.configDirectory;
  HAXCMS.configDirectory = configDir;
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory;
  });
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  assert.ok(await HAXCMS.createSite(siteName), "site is created");
  const res = stubRes();
  await saveOutline(
    makeReq(siteName, [
      page("a", "A", null, 0, { contents: "<p>A</p>" }),
      page("a1", "A1", "a", 0, { contents: "<p>A1</p>" }),
      page("b", "B", null, 1, { contents: "<p>B</p>" }),
    ]),
    res,
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return HAXCMS.loadSite(siteName);
}

function siteJsonPath(siteName) {
  return path.join(testRoot, "_sites", siteName, "site.json");
}

function readSiteJson(siteName) {
  return fs.readFileSync(siteJsonPath(siteName), "utf8");
}

function savedItems(siteName) {
  return JSON.parse(readSiteJson(siteName)).items;
}

// page folders on disk that site.json does not list
function orphanPageFolders(siteName) {
  const listed = savedItems(siteName).map(
    (item) => String(item.location).split("/")[1],
  );
  return fs
    .readdirSync(path.join(testRoot, "_sites", siteName, "pages"))
    .filter((dir) => dir.charAt(0) !== "." && listed.indexOf(dir) === -1);
}

const byTitle = (site, title) =>
  site.manifest.items.find((i) => i.title === title);

async function run(t, site, items) {
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const res = stubRes();
  let thrown = null;
  try {
    await saveOutline(makeReq(site.manifest.metadata.site.name, items), res);
  } catch (e) {
    thrown = e;
  }
  return { res, thrown };
}

function errnoError(code) {
  const error = new Error(code + ": injected fault");
  error.code = code;
  return error;
}

// true for `file` and for the temp file next to it that
// JSONOutlineSchema.writeFileAtomic writes first (.<name>.<hex>.tmp)
function isWriteOf(file, target) {
  const resolved = path.resolve(String(target));
  if (resolved === file) {
    return true;
  }
  const prefix = path.join(path.dirname(file), "." + path.basename(file) + ".");
  return resolved.indexOf(prefix) === 0 && /\.[0-9a-f]+\.tmp$/.test(resolved);
}

// fs-extra writeFileSync of `file` (or of its atomic-write temp file) runs
// `fault(target, data)` instead
function onWrite(t, file, fault) {
  const original = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", function (target, data, ...rest) {
    if (isWriteOf(file, target)) {
      return fault.call(this, target, data, rest, original);
    }
    return original.call(this, target, data, ...rest);
  });
}

// an edit that renames B and adds a new page N
function editWithNewPage(site) {
  return [
    page(byTitle(site, "A").id, "A", null, 0),
    page(byTitle(site, "B").id, "B renamed", null, 1),
    page("client-n", "N", null, 2, { contents: "<p>N</p>" }),
  ];
}

// ---------------------------------------------------------------------------
// filesystem faults
// ---------------------------------------------------------------------------

test("FI-OUT-01 ENOSPC writing site.json: the failure is raised and site.json is unchanged", async (t) => {
  const site = await buildSite(t, "fi-out-01");
  const before = readSiteJson("fi-out-01");
  let attempts = 0;
  onWrite(t, siteJsonPath("fi-out-01"), () => {
    attempts++;
    throw errnoError("ENOSPC");
  });
  const { res, thrown } = await run(t, site, editWithNewPage(site));
  t.mock.restoreAll();
  assert.ok(thrown, "the failure is raised");
  assert.equal(thrown.code, "ENOSPC");
  assert.equal(res.body, null, "no success is reported");
  assert.equal(attempts, 1, "the failed write is not retried");
  assert.equal(readSiteJson("fi-out-01"), before);
});

test("FI-OUT-01 ENOSPC writing site.json leaves no page folder on disk that site.json does not list", async (t) => {
  const site = await buildSite(t, "fi-out-01-orphans");
  onWrite(t, siteJsonPath("fi-out-01-orphans"), () => {
    throw errnoError("ENOSPC");
  });
  const { thrown } = await run(t, site, editWithNewPage(site));
  t.mock.restoreAll();
  assert.ok(thrown, "the failure is raised");
  assert.deepEqual(orphanPageFolders("fi-out-01-orphans"), []);
});

test("FI-OUT-07 a site.json that cannot be encoded: the failure is raised, site.json unchanged, no orphan folder", async (t) => {
  const site = await buildSite(t, "fi-out-07");
  const before = readSiteJson("fi-out-07");
  // something in the loaded outline JSON cannot represent (haxcms-php uses
  // invalid UTF-8, which json_encode refuses)
  const circular = {};
  circular.self = circular;
  site.manifest.metadata.site.bad = circular;
  const { res, thrown } = await run(t, site, editWithNewPage(site));
  assert.ok(
    thrown,
    "the failure is raised (the route answers 500 Server error)",
  );
  assert.match(String(thrown.message), /unable to encode site\.json/);
  assert.equal(res.body, null, "no success is reported");
  assert.equal(readSiteJson("fi-out-07"), before);
  assert.deepEqual(orphanPageFolders("fi-out-07"), []);
});

test("FI-OUT-02 EACCES writing one page file: 500 failed to write, that file unchanged, structure saved", async (t) => {
  const site = await buildSite(t, "fi-out-02");
  const b = byTitle(site, "B");
  const bFile = path.join(site.siteDirectory, b.location);
  const bBefore = fs.readFileSync(bFile, "utf8");
  onWrite(t, bFile, () => {
    throw errnoError("EACCES");
  });
  const items = editWithNewPage(site);
  items[1].contents = "<p>B new</p>";
  const { res, thrown } = await run(t, site, items);
  t.mock.restoreAll();
  assert.equal(thrown, null);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    status: 500,
    data: { message: "failed to write" },
  });
  assert.equal(fs.readFileSync(bFile, "utf8"), bBefore);
  const titles = savedItems("fi-out-02").map((i) => i.title);
  assert.ok(titles.indexOf("B renamed") !== -1, JSON.stringify(titles));
  assert.ok(titles.indexOf("N") !== -1, JSON.stringify(titles));
  assert.deepEqual(orphanPageFolders("fi-out-02"), []);
});

test("FI-OUT-03 a site.json write that fails part-way leaves the previous site.json intact and no temp file behind", async (t) => {
  const site = await buildSite(t, "fi-out-03");
  const before = readSiteJson("fi-out-03");
  onWrite(t, siteJsonPath("fi-out-03"), (target, data, rest, original) => {
    const text = String(data);
    // the first half lands, then the disk is full
    original.call(fs, target, text.substring(0, Math.floor(text.length / 2)));
    throw errnoError("ENOSPC");
  });
  const { thrown } = await run(t, site, editWithNewPage(site));
  t.mock.restoreAll();
  assert.ok(thrown, "the failure is raised");
  const after = readSiteJson("fi-out-03");
  assert.doesNotThrow(() => JSON.parse(after), "site.json still parses");
  assert.equal(after, before);
  assert.deepEqual(
    fs
      .readdirSync(path.dirname(siteJsonPath("fi-out-03")))
      .filter((name) => /\.tmp$/.test(name)),
    [],
    "the temp file is removed",
  );
});

// ---------------------------------------------------------------------------
// malformed payloads
// ---------------------------------------------------------------------------

test("FI-PAY-03 an item that is null or not an object is a 400 and site.json is unchanged", async (t) => {
  const site = await buildSite(t, "fi-pay-03");
  const before = readSiteJson("fi-pay-03");
  // what run() does, with HAXCMS.loadSite mocked once for every round
  t.mock.method(HAXCMS, "loadSite", async () => site);
  for (const bad of [null, 42, "page", [1]]) {
    const res = stubRes();
    let thrown = null;
    try {
      await saveOutline(makeReq("fi-pay-03", [bad]), res);
    } catch (e) {
      thrown = e;
    }
    assert.equal(thrown, null, "nothing escapes for " + String(bad));
    assert.equal(res.statusCode, 400, "400 for " + String(bad));
    assert.equal(res.body.data.message, "Each outline item must be an object");
    assert.equal(readSiteJson("fi-pay-03"), before);
  }
});

test("FI-PAY-04 the same existing id sent twice: one page, the last entry wins", async (t) => {
  const site = await buildSite(t, "fi-pay-04");
  const a = byTitle(site, "A");
  const count = site.manifest.items.length;
  const { res, thrown } = await run(t, site, [
    page(a.id, "A first", null, 0),
    page(a.id, "A second", null, 3),
  ]);
  assert.equal(thrown, null);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const items = savedItems("fi-pay-04");
  assert.equal(items.length, count, "no page is added");
  const saved = items.filter((i) => i.id === a.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].title, "A second");
  assert.equal(saved[0].order, 3);
  assert.deepEqual(orphanPageFolders("fi-pay-04"), []);
});

test("FI-PAY-05 the same new client id sent twice is a 400 and nothing is written", async (t) => {
  const site = await buildSite(t, "fi-pay-05");
  const count = site.manifest.items.length;
  const { res, thrown } = await run(t, site, [
    page("client-x", "X", null, 5, { contents: "<p>X</p>" }),
    page("client-x", "X again", null, 6, { contents: "<p>X</p>" }),
  ]);
  assert.equal(thrown, null);
  // both backends answer 400 (haxcms-php FaultInjectionSaveOutlineTest)
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(
    res.body.data.message,
    "Each new outline item requires its own id",
  );
  assert.equal(savedItems("fi-pay-05").length, count, "nothing is added");
  assert.deepEqual(orphanPageFolders("fi-pay-05"), []);
});

test("FI-PAY-09 an item without an id is a 400 and nothing is written", async (t) => {
  const site = await buildSite(t, "fi-pay-09");
  const before = readSiteJson("fi-pay-09");
  const b = byTitle(site, "B");
  // what run() does, with HAXCMS.loadSite mocked once for every round
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const missing = [
    { title: "No id", parent: null, indent: 0, order: 5 },
    { id: null, title: "Null id", parent: null, indent: 0, order: 5 },
    { id: "", title: "Empty id", parent: null, indent: 0, order: 5 },
    { id: "   ", title: "Blank id", parent: null, indent: 0, order: 5 },
    { id: true, title: "Boolean id", parent: null, indent: 0, order: 5 },
    { id: {}, title: "Object id", parent: null, indent: 0, order: 5 },
  ];
  for (const bad of missing) {
    const res = stubRes();
    let thrown = null;
    try {
      // an existing page renamed alongside it: the whole payload is refused
      await saveOutline(
        makeReq("fi-pay-09", [page(b.id, "B renamed", null, 1), bad]),
        res,
      );
    } catch (e) {
      thrown = e;
    }
    assert.equal(thrown, null, "nothing escapes for " + bad.title);
    // both backends answer 400 (haxcms-php FaultInjectionSaveOutlineTest)
    assert.equal(
      res.statusCode,
      400,
      bad.title + ": " + JSON.stringify(res.body),
    );
    assert.equal(res.body.data.message, "Each outline item requires an id");
    assert.equal(readSiteJson("fi-pay-09"), before, bad.title);
    assert.deepEqual(orphanPageFolders("fi-pay-09"), [], bad.title);
  }
  // the per-item checks cover the whole payload before the duplicate check,
  // so the first problem reported is the same one haxcms-php reports
  const res = stubRes();
  await saveOutline(
    makeReq("fi-pay-09", [
      page("client-x", "X one", null, 3),
      page("client-x", "X two", null, 4),
      { title: "No id", parent: null, indent: 0, order: 5 },
    ]),
    res,
  );
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(res.body.data.message, "Each outline item requires an id");
  assert.equal(readSiteJson("fi-pay-09"), before);
});

test("FI-PAY-06 a parent that does not exist: the page is rescued to the top level", async (t) => {
  const site = await buildSite(t, "fi-pay-06");
  const b = byTitle(site, "B");
  const { res, thrown } = await run(t, site, [
    page(b.id, "B", "no-such-page", 0),
  ]);
  assert.equal(thrown, null);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const items = savedItems("fi-pay-06");
  const ids = items.map((i) => i.id);
  assert.equal(items.find((i) => i.id === b.id).parent, null);
  items.forEach((item) => {
    assert.ok(
      item.parent === null || ids.indexOf(item.parent) !== -1,
      "no dangling parent on " + item.title,
    );
  });
});

// a request that never returns would hang this runner too, so these run
// saveOutline in a child process and give it CHILD_SAVE_BUDGET_MS
function runInChild(scenario) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(
      process.execPath,
      [
        CHILD_HELPER,
        scenario,
        // removed with testRoot even when the child is killed
        fs.mkdtempSync(path.join(testRoot, "child-")),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let timer = null;
    const finish = (outcome) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(outcome);
    };
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (timer === null && out.indexOf("STARTED\n") !== -1) {
        timer = setTimeout(
          () => finish({ hung: true, out: out }),
          CHILD_SAVE_BUDGET_MS,
        );
      }
      const done = out.match(/DONE (.*)\n/);
      if (done) {
        finish({ hung: false, result: JSON.parse(done[1]) });
      }
    });
    child.on("exit", () => {
      if (out.indexOf("DONE ") === -1) {
        finish({ hung: false, result: null, out: out });
      }
    });
  });
}

function assertCycleRejected(outcome) {
  assert.equal(outcome.hung, false, "the save returns: " + outcome.out);
  assert.ok(outcome.result, "the child reported: " + outcome.out);
  assert.equal(outcome.result.thrown, null);
  assert.equal(outcome.result.status, 400);
  assert.equal(
    outcome.result.body.data.message,
    "Outline item parents cannot form a cycle",
  );
  assert.equal(outcome.result.siteJsonUnchanged, true);
}

test("FI-PAY-07 a parent cycle (A under B, B under A) is a 400 and site.json is unchanged", async () => {
  assertCycleRejected(await runInChild("cycle"));
});

test("FI-PAY-08 a page that is its own parent is a 400 and site.json is unchanged", async () => {
  assertCycleRejected(await runInChild("self-parent"));
});
