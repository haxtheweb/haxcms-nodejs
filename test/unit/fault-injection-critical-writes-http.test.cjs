"use strict";

// Fault injection for the critical site write routes, over HTTP against the
// real server (src/app.js booted in-process, multi-site mode, real login,
// same harness as app-server-upload-lifecycle.test.cjs).
//
// Faults are injected at the filesystem boundary: fs-extra methods are
// mocked with node:test mocks so a write, copy or move throws the errno a
// full disk / read-only mount / cross-device move would. No production seam
// is added. For every fault the invariants are:
//   - the client gets a non-2xx response with the OpenAPI ApiError envelope
//     ({ status: <same as HTTP status>, data: { message: <string> } }) the
//     UI can display
//   - what was on disk before (site.json, the page file) is unchanged, and
//     no file or page folder is left behind that site.json does not list
//   - the server keeps answering requests
//
// Scenario ids (FI-*) are shared with haxcms-php, which mirrors these
// tests; see "Fault injection testing" in README.md. A scenario whose invariant does
// not hold today is a test.todo with the bug described, not a product fix.
//
// CommonJS, no optional chaining, node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_ENTRY_PATH = path.join(REPO_ROOT, "src", "app.js");
const BOILERPLATE_SYSTEMSETUP = path.join(
  REPO_ROOT,
  "src",
  "boilerplate",
  "systemsetup",
);

const TEST_USER_NAME = "fault-injection-user";
const TEST_USER_PASSWORD = "fault-injection-pass";
const GIT_AUTHOR_NAME = "HAXcms Fault Injection Unit";
const GIT_AUTHOR_EMAIL = "fault-injection-unit@local.invalid";
// a response that has not arrived by then never will: every route under
// test answers in well under a second on a healthy server
const REQUEST_TIMEOUT_MS = 4000;
// scenarios whose request used to hang (an error escaping the route) give
// up sooner: the error is raised well before this
const HANG_TIMEOUT_MS = 1500;
// 1x1 transparent PNG
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function captureEnv(key) {
  return {
    exists: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  };
}

function restoreEnv(key, snapshot) {
  if (!snapshot || snapshot.exists !== true) {
    delete process.env[key];
    return;
  }
  process.env[key] = snapshot.value;
}

const ENV_KEYS = [
  "PORT",
  "HAXCMS_ROOT",
  "HAXCMS_ENABLE_SSL",
  "NODE_ENV",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];
const envSnapshots = {};
for (let i = 0; i < ENV_KEYS.length; i++) {
  envSnapshots[ENV_KEYS[i]] = captureEnv(ENV_KEYS[i]);
}

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-fault-http-"));
const runtimeRoot = path.join(tempRoot, "runtime");
const configRoot = path.join(runtimeRoot, "_config");
const sitesRoot = path.join(runtimeRoot, "_sites");
const uploadTmpRoot = path.join(configRoot, "tmp");

function seedRuntimeConfig() {
  fs.ensureDirSync(configRoot);
  fs.writeFileSync(path.join(configRoot, ".isHAXcmsConfig"), "");
  const seedFiles = [
    "config.json",
    "my-custom-elements.js",
    "userData.json",
    "config.php",
    ".htaccess",
    ".user-files-htaccess",
  ];
  for (let i = 0; i < seedFiles.length; i++) {
    fs.copySync(
      path.join(BOILERPLATE_SYSTEMSETUP, seedFiles[i]),
      path.join(configRoot, seedFiles[i]),
    );
  }
  const dirs = [
    "tmp",
    "cache",
    "user",
    "user/files",
    "user/skeletons",
    "skeletons",
    "settings",
    "node_modules",
  ];
  for (let i = 0; i < dirs.length; i++) {
    fs.ensureDirSync(path.join(configRoot, dirs[i]));
  }
}

fs.ensureDirSync(sitesRoot);
seedRuntimeConfig();
fs.writeFileSync(
  path.join(configRoot, ".user"),
  JSON.stringify(
    { name: TEST_USER_NAME, password: TEST_USER_PASSWORD },
    null,
    2,
  ),
);

process.chdir(runtimeRoot);
// trailing slash required: HAXCMS.js string-concats HAXCMS_ROOT + sitesDirectory
process.env.HAXCMS_ROOT = runtimeRoot + "/";
process.env.PORT = "0";
process.env.GIT_AUTHOR_NAME = GIT_AUTHOR_NAME;
process.env.GIT_AUTHOR_EMAIL = GIT_AUTHOR_EMAIL;
process.env.GIT_COMMITTER_NAME = GIT_AUTHOR_NAME;
process.env.GIT_COMMITTER_EMAIL = GIT_AUTHOR_EMAIL;
delete process.env.HAXCMS_ENABLE_SSL;

globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
  username: TEST_USER_NAME,
  password: TEST_USER_PASSWORD,
};

const appModule = require(APP_ENTRY_PATH);
const { HAXCMS } = require(path.join(REPO_ROOT, "src", "lib", "HAXCMS.js"));

const runtime = { baseUrl: "", jwt: "" };

test.before(async () => {
  const port = await appModule.serverReady;
  runtime.baseUrl = "http://127.0.0.1:" + port;
  const login = await fetch(runtime.baseUrl + "/system/api/v1/session/login", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      username: TEST_USER_NAME,
      password: TEST_USER_PASSWORD,
    }),
  });
  const loginText = await login.text();
  assert.equal(login.status, 200, loginText);
  runtime.jwt = JSON.parse(loginText).jwt;
});

test.after(async () => {
  if (appModule.server && typeof appModule.server.close === "function") {
    if (typeof appModule.server.closeAllConnections === "function") {
      appModule.server.closeAllConnections();
    }
    await new Promise((resolve) => {
      appModule.server.close(() => resolve());
    });
  }
  process.chdir(originalCwd);
  for (let i = 0; i < ENV_KEYS.length; i++) {
    restoreEnv(ENV_KEYS[i], envSnapshots[ENV_KEYS[i]]);
  }
  delete globalThis.HAXCMS_RUNTIME_CREDENTIALS;
  fs.removeSync(tempRoot);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// each scenario gets its own site so a fault in one cannot leak into another
async function freshSite(name) {
  assert.ok(await HAXCMS.createSite(name), "site " + name + " is created");
  return name;
}

function siteDir(siteName) {
  return path.join(sitesRoot, siteName);
}

function siteJsonPath(siteName) {
  return path.join(siteDir(siteName), "site.json");
}

function readSiteJson(siteName) {
  return fs.readFileSync(siteJsonPath(siteName), "utf8");
}

function siteItems(siteName) {
  return JSON.parse(readSiteJson(siteName)).items;
}

function pageFolders(siteName) {
  return fs
    .readdirSync(path.join(siteDir(siteName), "pages"))
    .filter((dir) => dir.charAt(0) !== ".")
    .sort();
}

// page folders on disk that site.json does not list
function orphanPageFolders(siteName) {
  const listed = siteItems(siteName).map(
    (item) => String(item.location).split("/")[1],
  );
  return pageFolders(siteName).filter((dir) => listed.indexOf(dir) === -1);
}

function siteHeaders(siteName, extra) {
  return Object.assign(
    {
      accept: "application/json",
      authorization: "Bearer " + runtime.jwt,
      "x-haxcms-site-token": HAXCMS.getRequestToken(
        TEST_USER_NAME + ":" + siteName,
      ),
    },
    extra || {},
  );
}

async function siteRequest(siteName, method, route, body, timeoutMs) {
  const init = {
    method: method,
    headers: siteHeaders(
      siteName,
      body instanceof FormData ? {} : { "content-type": "application/json" },
    ),
    signal: AbortSignal.timeout(timeoutMs || REQUEST_TIMEOUT_MS),
  };
  if (body instanceof FormData) {
    init.body = body;
  } else if (typeof body !== "undefined") {
    init.body = JSON.stringify(
      Object.assign({ site: { name: siteName } }, body),
    );
  }
  const response = await fetch(
    runtime.baseUrl + "/_sites/" + siteName + "/x/api/v1/" + route,
    init,
  );
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text: text, json: json };
}

// the OpenAPI ApiError envelope, which the UI reads data.message from
function assertErrorEnvelope(result, expectedStatus) {
  assert.ok(
    result.status >= 400,
    "expected an error status, got " + result.status + ": " + result.text,
  );
  if (typeof expectedStatus === "number") {
    assert.equal(result.status, expectedStatus, result.text);
  }
  assert.ok(result.json, "error body is JSON: " + result.text);
  assert.equal(result.json.status, result.status, result.text);
  assert.ok(
    result.json.data && typeof result.json.data.message === "string",
    "error body has data.message: " + result.text,
  );
  assert.notEqual(result.json.data.message.trim(), "");
}

async function assertStillServing(siteName) {
  const result = await siteRequest(siteName, "GET", "site");
  assert.equal(result.status, 200, result.text);
}

function errnoError(code, message) {
  const error = new Error(code + ": " + message);
  error.code = code;
  return error;
}

// fs-extra method `method` throws `code` when its first argument matches
// `matches`; every other call goes through untouched
function failFs(t, method, matches, code) {
  const original = fs[method];
  const calls = [];
  t.mock.method(fs, method, function (target, ...rest) {
    if (matches(String(target))) {
      calls.push(String(target));
      throw errnoError(code, method + " '" + String(target) + "'");
    }
    return original.call(this, target, ...rest);
  });
  return calls;
}

// site.json itself, or the temp file next to it that
// JSONOutlineSchema.writeFileAtomic writes first (.site.json.<hex>.tmp):
// a full disk fails that write
function isSiteJsonOf(siteName) {
  const file = siteJsonPath(siteName);
  const prefix = path.join(siteDir(siteName), ".site.json.");
  return (target) => {
    const resolved = path.resolve(target);
    return (
      resolved === file ||
      (resolved.indexOf(prefix) === 0 && /\.[0-9a-f]+\.tmp$/.test(resolved))
    );
  };
}

// A rejection that escapes a route handler is an unhandledRejection: the
// request never gets a response and, under Node's default
// --unhandled-rejections=throw, the server process exits. node:test would
// turn it into a file-level failure, so while a scenario that could hit
// that runs, escaped rejections are collected here instead and the test
// asserts there were none (src/app.js answers a thrown handler error with
// the ApiError envelope).
async function collectEscapedRejections(fn) {
  const saved = process.listeners("unhandledRejection");
  const escaped = [];
  const collect = (reason) => {
    escaped.push(reason);
  };
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", collect);
  try {
    let result = null;
    try {
      result = await fn();
    } catch (e) {
      result = { status: 0, text: String(e && e.name), json: null };
    }
    // let a rejection queued by the handler surface before restoring
    await new Promise((resolve) => setImmediate(resolve));
    return { result: result, escaped: escaped };
  } finally {
    process.removeListener("unhandledRejection", collect);
    for (let i = 0; i < saved.length; i++) {
      process.on("unhandledRejection", saved[i]);
    }
  }
}

function outlineFromDisk(siteName, change) {
  return siteItems(siteName).map((item) =>
    Object.assign(
      {
        id: item.id,
        title: item.title,
        parent: item.parent,
        indent: item.indent,
        order: item.order,
        metadata: {},
      },
      change ? change(item) : {},
    ),
  );
}

// ---------------------------------------------------------------------------
// saveOutline (PATCH /x/api/v1/site/outline)
// ---------------------------------------------------------------------------

test("FI-OUT-02 EACCES writing a page file: 500 envelope, that page file unchanged, structure saved, still serving", async (t) => {
  const siteName = await freshSite("fi-out-02");
  const first = siteItems(siteName)[0];
  const pageFile = path.join(siteDir(siteName), first.location);
  const pageBefore = fs.readFileSync(pageFile, "utf8");
  failFs(t, "writeFileSync", (target) => target === pageFile, "EACCES");
  const result = await siteRequest(siteName, "PATCH", "site/outline", {
    items: outlineFromDisk(siteName, () => ({
      title: "Renamed",
      contents: "<p>new contents</p>",
    })),
  });
  t.mock.restoreAll();
  assertErrorEnvelope(result, 500);
  assert.equal(result.json.data.message, "failed to write");
  assert.equal(fs.readFileSync(pageFile, "utf8"), pageBefore);
  // checkpoint semantics: the structure pass was saved before the content
  // phase failed (see save-outline-failure-parity.test.cjs)
  assert.equal(siteItems(siteName)[0].title, "Renamed");
  assert.deepEqual(orphanPageFolders(siteName), []);
  await assertStillServing(siteName);
});

test("FI-OUT-05 a corrupt site.json on the next save answers an error envelope and is left as is", async () => {
  const siteName = await freshSite("fi-out-05");
  const otherSite = await freshSite("fi-out-05-other");
  const outline = outlineFromDisk(siteName, () => ({ title: "Never saved" }));
  const whole = readSiteJson(siteName);
  // a half-written site.json, as a crash mid-write leaves it
  const corrupt = whole.substring(0, Math.floor(whole.length / 2));
  fs.writeFileSync(siteJsonPath(siteName), corrupt);
  const { result, escaped } = await collectEscapedRejections(() =>
    siteRequest(
      siteName,
      "PATCH",
      "site/outline",
      { items: outline },
      HANG_TIMEOUT_MS,
    ),
  );
  assert.equal(readSiteJson(siteName), corrupt, "corrupt file left as is");
  await assertStillServing(otherSite);
  assert.equal(escaped.length, 0, "no rejection escapes the route");
  assertErrorEnvelope(result);
});

test("FI-OUT-06 slow IO: other requests are answered while a save is in flight, then the save finishes", async (t) => {
  const siteName = await freshSite("fi-out-06");
  const copy = HAXCMS.recurseCopy.bind(HAXCMS);
  let copying = null;
  t.mock.method(HAXCMS, "recurseCopy", async (...args) => {
    copying = new Promise((resolve) => setTimeout(resolve, 250));
    await copying;
    return copy(...args);
  });
  const items = outlineFromDisk(siteName);
  items.push({
    id: "client-slow",
    title: "Slow page",
    parent: null,
    indent: 0,
    order: items.length,
    metadata: {},
    contents: "<p>slow</p>",
  });
  const saving = siteRequest(siteName, "PATCH", "site/outline", {
    items: items,
  });
  // wait until the save is parked on the slow copy, then read
  for (let i = 0; i < 200 && copying === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(copying, "the save reached the slow copy");
  const readStarted = Date.now();
  await assertStillServing(siteName);
  const readMs = Date.now() - readStarted;
  const saved = await saving;
  assert.equal(saved.status, 200, saved.text);
  assert.equal(siteItems(siteName).length, items.length);
  assert.ok(readMs < REQUEST_TIMEOUT_MS, "read answered during the save");
});

test("FI-PAY-01 items that are not an array: 400 envelope and site.json unchanged", async () => {
  const siteName = await freshSite("fi-pay-01");
  const before = readSiteJson(siteName);
  const asString = await siteRequest(siteName, "PATCH", "site/outline", {
    items: "not-an-array",
  });
  assertErrorEnvelope(asString, 400);
  assert.equal(
    asString.json.data.message,
    "Outline payload requires an items array",
  );
  const missing = await siteRequest(siteName, "PATCH", "site/outline", {});
  assertErrorEnvelope(missing, 400);
  assert.equal(readSiteJson(siteName), before);
  await assertStillServing(siteName);
});

test("FI-PAY-02 partial outline: pages that were not sent are left as they were", async () => {
  const siteName = await freshSite("fi-pay-02");
  const seed = await siteRequest(siteName, "PATCH", "site/outline", {
    items: outlineFromDisk(siteName).concat([
      {
        id: "client-two",
        title: "Two",
        parent: null,
        indent: 0,
        order: 1,
        metadata: {},
        contents: "<p>two</p>",
      },
    ]),
  });
  assert.equal(seed.status, 200, seed.text);
  const before = siteItems(siteName);
  assert.equal(before.length, 2);
  const result = await siteRequest(siteName, "PATCH", "site/outline", {
    items: [
      {
        id: before[1].id,
        title: "Two renamed",
        parent: null,
        indent: 0,
        order: 1,
        metadata: {},
      },
    ],
  });
  assert.equal(result.status, 200, result.text);
  const after = siteItems(siteName);
  const untouched = after.find((item) => item.id === before[0].id);
  assert.ok(untouched, "the page that was not sent is still there");
  assert.equal(untouched.title, before[0].title);
  assert.equal(untouched.parent, before[0].parent);
  assert.equal(untouched.order, before[0].order);
  assert.equal(untouched.location, before[0].location);
  assert.equal(
    after.find((item) => item.id === before[1].id).title,
    "Two renamed",
  );
});

test("FI-HTTP-01 / FI-OUT-01 ENOSPC writing site.json during saveOutline answers a 5xx envelope instead of hanging", async (t) => {
  const siteName = await freshSite("fi-http-01");
  failFs(t, "writeFileSync", isSiteJsonOf(siteName), "ENOSPC");
  const { result, escaped } = await collectEscapedRejections(() =>
    siteRequest(
      siteName,
      "PATCH",
      "site/outline",
      {
        items: outlineFromDisk(siteName, () => ({ title: "Renamed" })),
      },
      HANG_TIMEOUT_MS,
    ),
  );
  t.mock.restoreAll();
  await assertStillServing(siteName);
  assert.deepEqual(
    escaped.map((e) => String(e && e.code)),
    [],
    "no rejection escapes the route",
  );
  assertErrorEnvelope(result);
});

// ---------------------------------------------------------------------------
// other critical writes
// ---------------------------------------------------------------------------

test("FI-NODE-01 EACCES saving page content: 500 envelope, page file unchanged, still serving", async (t) => {
  const siteName = await freshSite("fi-node-01");
  const page = siteItems(siteName)[0];
  const pageFile = path.join(siteDir(siteName), page.location);
  const before = fs.readFileSync(pageFile, "utf8");
  const siteJsonBefore = readSiteJson(siteName);
  failFs(t, "writeFileSync", (target) => target === pageFile, "EACCES");
  const result = await siteRequest(siteName, "PATCH", "content/" + page.id, {
    body: '<page-break title="Edited"></page-break><p>edited</p>',
  });
  t.mock.restoreAll();
  assertErrorEnvelope(result, 500);
  assert.equal(fs.readFileSync(pageFile, "utf8"), before);
  assert.equal(readSiteJson(siteName), siteJsonBefore);
  await assertStillServing(siteName);
});

test("FI-NODE-02 ENOSPC writing site.json while creating a page answers a 5xx envelope and leaves no orphan page folder", async (t) => {
  const siteName = await freshSite("fi-node-02");
  const before = readSiteJson(siteName);
  failFs(t, "writeFileSync", isSiteJsonOf(siteName), "ENOSPC");
  const { result, escaped } = await collectEscapedRejections(() =>
    siteRequest(
      siteName,
      "POST",
      "items",
      { node: { title: "New page" } },
      HANG_TIMEOUT_MS,
    ),
  );
  t.mock.restoreAll();
  await assertStillServing(siteName);
  assert.equal(readSiteJson(siteName), before);
  assert.equal(escaped.length, 0, "no rejection escapes the route");
  assertErrorEnvelope(result);
  assert.deepEqual(orphanPageFolders(siteName), []);
});

test("FI-NODE-02b ENOSPC writing site.json during a bulk create answers a 5xx envelope and leaves no orphan page folders", async (t) => {
  const siteName = await freshSite("fi-node-02b");
  const before = readSiteJson(siteName);
  const calls = failFs(t, "writeFileSync", isSiteJsonOf(siteName), "ENOSPC");
  const { result, escaped } = await collectEscapedRejections(() =>
    siteRequest(
      siteName,
      "POST",
      "items",
      {
        items: [
          { id: "bulk-a", title: "Bulk A", parent: null, indent: 0, order: 0 },
          {
            id: "bulk-b",
            title: "Bulk B",
            parent: "bulk-a",
            indent: 1,
            order: 0,
          },
          { id: "bulk-c", title: "Bulk C", parent: null, indent: 0, order: 1 },
        ],
      },
      HANG_TIMEOUT_MS,
    ),
  );
  t.mock.restoreAll();
  await assertStillServing(siteName);
  // one site.json write for the whole request (haxtheweb/issues#3248)
  assert.equal(calls.length, 1);
  assert.equal(readSiteJson(siteName), before);
  assert.equal(escaped.length, 0, "no rejection escapes the route");
  assertErrorEnvelope(result);
  assert.deepEqual(orphanPageFolders(siteName), []);
});

test("bulk create stores every page with one site.json write and rebuilds the generated files once", async (t) => {
  const siteName = await freshSite("bulk-create-once");
  const before = siteItems(siteName).length;
  const original = fs.writeFileSync;
  const matches = isSiteJsonOf(siteName);
  let writes = 0;
  t.mock.method(fs, "writeFileSync", function (target, ...rest) {
    if (matches(String(target))) {
      writes++;
    }
    return original.call(this, target, ...rest);
  });
  const items = [];
  for (let i = 0; i < 12; i++) {
    items.push({
      id: "many-" + i,
      title: "Many " + i,
      parent: i % 3 === 0 ? null : "many-" + (i - (i % 3)),
      indent: i % 3 === 0 ? 0 : 1,
      order: i,
      contents: "<p>Body " + i + "</p>",
    });
  }
  const result = await siteRequest(siteName, "POST", "items", { items });
  t.mock.restoreAll();
  assert.equal(result.status, 200);
  assert.equal(writes, 1, "site.json written once for the request");
  const stored = siteItems(siteName);
  assert.equal(stored.length, before + 12);
  for (let i = 0; i < 12; i++) {
    const item = stored.find((it) => it.id === "many-" + i);
    assert.ok(item, "many-" + i + " stored");
    assert.equal(
      fs
        .readFileSync(path.join(siteDir(siteName), item.location), "utf8")
        .indexOf("Body " + i) !== -1,
      true,
      "many-" + i + " content written",
    );
  }
  assert.deepEqual(orphanPageFolders(siteName), []);
  // the generated files list the new pages
  const sitemap = fs.readFileSync(
    path.join(siteDir(siteName), "sitemap.xml"),
    "utf8",
  );
  assert.ok(
    sitemap.indexOf(stored.find((it) => it.id === "many-11").slug) !== -1,
  );
});

test("FI-NODE-03 ENOSPC writing site.json while deleting a page answers a 5xx envelope and keeps the page", async (t) => {
  const siteName = await freshSite("fi-node-03");
  const page = siteItems(siteName)[0];
  const before = readSiteJson(siteName);
  failFs(t, "writeFileSync", isSiteJsonOf(siteName), "ENOSPC");
  const { result, escaped } = await collectEscapedRejections(() =>
    siteRequest(siteName, "DELETE", "items/" + page.id, {}, HANG_TIMEOUT_MS),
  );
  t.mock.restoreAll();
  await assertStillServing(siteName);
  assert.equal(readSiteJson(siteName), before);
  assert.ok(fs.existsSync(path.join(siteDir(siteName), page.location)));
  assert.equal(escaped.length, 0, "no rejection escapes the route");
  assertErrorEnvelope(result);
});

test("FI-SITE-01 ENOSPC writing site.json while saving site settings answers a 5xx envelope", async (t) => {
  const siteName = await freshSite("fi-site-01");
  const before = readSiteJson(siteName);
  failFs(t, "writeFileSync", isSiteJsonOf(siteName), "ENOSPC");
  const { result, escaped } = await collectEscapedRejections(() =>
    siteRequest(
      siteName,
      "PATCH",
      "site",
      {
        manifest: { site: { "manifest-title": "Renamed site" } },
      },
      HANG_TIMEOUT_MS,
    ),
  );
  t.mock.restoreAll();
  await assertStillServing(siteName);
  assert.equal(readSiteJson(siteName), before);
  assert.equal(escaped.length, 0, "no rejection escapes the route");
  assertErrorEnvelope(result);
});

test("FI-UP-01 the move into files/ fails (EXDEV): 500 envelope, no file left in files/ or tmp, still serving", async (t) => {
  const siteName = await freshSite("fi-up-01");
  // HAXCMSFile.save logs the failed move; keep the test output clean
  t.mock.method(console, "warn", () => {});
  const filesDir = path.join(siteDir(siteName), "files");
  const filesBefore = fs.readdirSync(filesDir).sort();
  const tmpBefore = fs.readdirSync(uploadTmpRoot).sort();
  const moves = failFs(
    t,
    "moveSync",
    (target) => path.resolve(target).indexOf(uploadTmpRoot) === 0,
    "EXDEV",
  );
  const form = new FormData();
  form.append(
    "file-upload",
    new Blob([PNG_1X1], { type: "image/png" }),
    "pixel.png",
  );
  const result = await siteRequest(siteName, "POST", "files", form);
  t.mock.restoreAll();
  assert.equal(moves.length, 1, "the upload reached the move: " + result.text);
  assertErrorEnvelope(result, 500);
  assert.equal(
    result.json.data.message,
    "Unable to save file to target location",
  );
  assert.deepEqual(fs.readdirSync(filesDir).sort(), filesBefore);
  // multer's temp file is removed when the response finishes
  let tmpAfter = fs.readdirSync(uploadTmpRoot).sort();
  for (let i = 0; i < 50 && tmpAfter.length !== tmpBefore.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    tmpAfter = fs.readdirSync(uploadTmpRoot).sort();
  }
  assert.deepEqual(tmpAfter, tmpBefore);
  await assertStillServing(siteName);
});
