"use strict";

// HEAD on a system API route answers like GET (haxtheweb/issues#3236).
//
// Express routes HEAD to the matching GET route. The system API handlers
// looked their handler up with req.method ("head") in a registry keyed by
// "get" and found nothing. Before the route handler guard
// (src/lib/routeHandlerError.js) that throw stopped the server; with the
// guard it is a 500. registryMethod (src/lib/routeMethod.js) maps HEAD to
// the GET handler and the GET access policy.
//
// These tests boot the real server from src/app.js (temp runtime, PORT=0).
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict, ephemeral port, temp runtime dirs.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_ENTRY_PATH = path.join(REPO_ROOT, "src", "app.js");
const BOILERPLATE_SYSTEMSETUP = path.join(
  REPO_ROOT,
  "src",
  "boilerplate",
  "systemsetup",
);
const { registryMethod } = require(
  path.join(REPO_ROOT, "src", "lib", "routeMethod.js"),
);

const SITE_NAME = "headsite";
const TEST_USER_NAME = "head-method-user";
const TEST_USER_PASSWORD = "head-method-pass";

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

const envSnapshots = {
  PORT: captureEnv("PORT"),
  HAXCMS_ROOT: captureEnv("HAXCMS_ROOT"),
  HAXCMS_ENABLE_SSL: captureEnv("HAXCMS_ENABLE_SSL"),
  GIT_AUTHOR_NAME: captureEnv("GIT_AUTHOR_NAME"),
  GIT_AUTHOR_EMAIL: captureEnv("GIT_AUTHOR_EMAIL"),
  GIT_COMMITTER_NAME: captureEnv("GIT_COMMITTER_NAME"),
  GIT_COMMITTER_EMAIL: captureEnv("GIT_COMMITTER_EMAIL"),
};

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-head-method-"));
const runtimeRoot = path.join(tempRoot, "runtime");
const configRoot = path.join(runtimeRoot, "_config");
const sitesRoot = path.join(runtimeRoot, "_sites");

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
process.env.HAXCMS_ROOT = runtimeRoot + "/";
process.env.PORT = "0";
process.env.GIT_AUTHOR_NAME = "HAXcms Head Unit";
process.env.GIT_AUTHOR_EMAIL = "head-unit@local.invalid";
process.env.GIT_COMMITTER_NAME = "HAXcms Head Unit";
process.env.GIT_COMMITTER_EMAIL = "head-unit@local.invalid";
delete process.env.HAXCMS_ENABLE_SSL;

globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
  username: TEST_USER_NAME,
  password: TEST_USER_PASSWORD,
};

const appModule = require(APP_ENTRY_PATH);
const { HAXCMS } = require(path.join(REPO_ROOT, "src", "lib", "HAXCMS.js"));

// raw http so HEAD responses (no body) are handled exactly as a client sees them
function rawRequest(method, url, headers) {
  return new Promise(function (resolve, reject) {
    const req = http.request(
      url,
      { method: method, headers: headers || {} },
      function (res) {
        const chunks = [];
        res.on("data", function (c) {
          chunks.push(c);
        });
        res.on("end", function () {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, function () {
      req.destroy(new Error("request timed out: " + method + " " + url));
    });
    req.end();
  });
}

const runtime = { baseUrl: "" };

test.before(async () => {
  const port = await appModule.serverReady;
  runtime.baseUrl = "http://127.0.0.1:" + port;
  await HAXCMS.createSite(SITE_NAME);
});

test.after(async () => {
  if (appModule.server && typeof appModule.server.close === "function") {
    await new Promise(function (resolve) {
      appModule.server.close(function () {
        resolve();
      });
    });
  }
  process.chdir(originalCwd);
  delete globalThis.HAXCMS_RUNTIME_CREDENTIALS;
  const keys = Object.keys(envSnapshots);
  for (let i = 0; i < keys.length; i++) {
    restoreEnv(keys[i], envSnapshots[keys[i]]);
  }
  fs.removeSync(tempRoot);
});

// open (anonymous) system routes: these crashed the process before the fix
const OPEN_SYSTEM_PATHS = [
  "/system/api/v1",
  "/system/api/v1/openapi",
  "/system/api/v1/openapi.json",
  "/system/api/v1/openapi.yaml",
  "/system/api/v1/session/connection-settings",
  "/_sites/" + SITE_NAME + "/system/api/v1/session/connection-settings",
];

for (let i = 0; i < OPEN_SYSTEM_PATHS.length; i++) {
  const routePath = OPEN_SYSTEM_PATHS[i];
  test(
    "HEAD " + routePath + " answers like GET and the server stays up",
    async () => {
      const get = await rawRequest("GET", runtime.baseUrl + routePath);
      const head = await rawRequest("HEAD", runtime.baseUrl + routePath);
      assert.equal(
        head.status,
        get.status,
        "HEAD status should match GET status",
      );
      assert.ok(
        head.status < 500,
        "HEAD must not be a server error, got " + head.status,
      );
      assert.equal(head.body, "", "HEAD responses carry no body");
      // the process is still serving after the HEAD request
      const after = await rawRequest("GET", runtime.baseUrl + "/system/api/v1");
      assert.equal(after.status, 200);
    },
  );
}

test("HEAD on an authenticated system route without credentials is refused, not a crash", async () => {
  const head = await rawRequest(
    "HEAD",
    runtime.baseUrl + "/system/api/v1/sites",
  );
  assert.ok(
    head.status === 401 || head.status === 403,
    "expected 401/403, got " + head.status,
  );
  const after = await rawRequest("GET", runtime.baseUrl + "/system/api/v1");
  assert.equal(after.status, 200);
});

test("a burst of HEAD requests does not stop the server", async () => {
  const burst = [];
  for (let i = 0; i < 20; i++) {
    burst.push(
      rawRequest(
        "HEAD",
        runtime.baseUrl + OPEN_SYSTEM_PATHS[i % OPEN_SYSTEM_PATHS.length],
      ),
    );
  }
  const results = await Promise.all(burst);
  for (let i = 0; i < results.length; i++) {
    assert.ok(
      results[i].status < 500,
      "HEAD #" + i + " returned " + results[i].status,
    );
  }
  const after = await rawRequest(
    "GET",
    runtime.baseUrl + "/system/api/v1/openapi.json",
  );
  assert.equal(after.status, 200);
});

test("registryMethod maps HEAD to get and leaves other methods alone", () => {
  assert.equal(registryMethod("HEAD"), "get");
  assert.equal(registryMethod("head"), "get");
  assert.equal(registryMethod("GET"), "get");
  assert.equal(registryMethod("POST"), "post");
  assert.equal(registryMethod("DELETE"), "delete");
  assert.equal(registryMethod("PATCH"), "patch");
  assert.equal(registryMethod(undefined), "");
});
