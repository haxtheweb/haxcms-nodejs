"use strict";

// security: version not exposed unauthenticated
//
// Rule: the running HAXcms version is never handed to an unauthenticated
// caller (it tells an attacker which advisories apply). Only the admin routes
// `system/version` and `status` report it, and only after login. This boots
// the REAL server from src/app.js in multisite mode against a temp runtime
// and walks every open system route plus the anonymous site surface, checking
// that neither the body nor any response header carries the version string.
// A positive control (the authenticated `system/version` call) proves the
// string being searched for is the one the server actually reports.
//
// Parity: haxcms-php carries a test under the same name for the same rule.
//
// Server-boot discipline: ephemeral port (PORT=0), temp runtime via mkdtemp,
// credentials minted at runtime with crypto.randomBytes, server closed after.
// Constraints honored: CommonJS (.cjs), require(), globalThis, NO optional
// chaining, node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const axios = require("axios");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_ENTRY_PATH = path.join(REPO_ROOT, "src", "app.js");
const BOILERPLATE_SYSTEMSETUP = path.join(
  REPO_ROOT,
  "src",
  "boilerplate",
  "systemsetup",
);

const SITE_NAME = "versionleak";
const TEST_USER_NAME = "version-leak-user";
// minted per run so no credential literal lives in the repo
const TEST_USER_SECRET = crypto.randomBytes(18).toString("hex");

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
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];
const envSnapshots = {};
ENV_KEYS.forEach(function (key) {
  envSnapshots[key] = captureEnv(key);
});

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-version-leak-"));
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
  JSON.stringify({ name: TEST_USER_NAME, password: TEST_USER_SECRET }, null, 2),
);

process.chdir(runtimeRoot);
// trailing slash required: HAXCMS.js string-concats HAXCMS_ROOT + sitesDirectory
process.env.HAXCMS_ROOT = runtimeRoot + "/";
process.env.PORT = "0";
process.env.GIT_AUTHOR_NAME = "HAXcms Version Leak Unit";
process.env.GIT_AUTHOR_EMAIL = "version-leak-unit@local.invalid";
process.env.GIT_COMMITTER_NAME = process.env.GIT_AUTHOR_NAME;
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_AUTHOR_EMAIL;
delete process.env.HAXCMS_ENABLE_SSL;

globalThis.HAXCMS_RUNTIME_CREDENTIALS = {
  username: TEST_USER_NAME,
  password: TEST_USER_SECRET,
};

const appModule = require(APP_ENTRY_PATH);
const { HAXCMS } = require(path.join(REPO_ROOT, "src", "lib", "HAXCMS.js"));
const { SystemV1OpenRoutes, SystemV1AdminRoutes } = require(
  path.join(REPO_ROOT, "src", "lib", "SystemRoutesMap.js"),
);

const runtime = {
  baseUrl: "",
  jwt: "",
  userToken: "",
  version: "",
};

async function request(method, url, options) {
  const config = {
    method: method,
    url: url,
    maxRedirects: 0,
    responseType: "text",
    transformResponse: [
      function (data) {
        return data;
      },
    ],
    validateStatus: function () {
      return true;
    },
  };
  if (options && options.headers) {
    config.headers = options.headers;
  }
  if (options && Object.prototype.hasOwnProperty.call(options, "data")) {
    config.data = options.data;
  }
  const response = await axios(config);
  return {
    status: response.status,
    headers: response.headers || {},
    bodyText:
      typeof response.data === "string"
        ? response.data
        : String(response.data || ""),
  };
}

// a response leaks the version when the reported version string appears in
// its body or in any header value
function findVersionLeak(result) {
  const needle = runtime.version;
  if (result.bodyText.indexOf(needle) !== -1) {
    const at = result.bodyText.indexOf(needle);
    return (
      "body: ..." +
      result.bodyText.substring(Math.max(0, at - 60), at + needle.length + 20) +
      "..."
    );
  }
  const headerNames = Object.keys(result.headers);
  for (let i = 0; i < headerNames.length; i++) {
    const value = String(result.headers[headerNames[i]]);
    if (value.indexOf(needle) !== -1) {
      return "header " + headerNames[i] + ": " + value;
    }
  }
  return "";
}

function systemUrl(route) {
  return runtime.baseUrl + "/system/api/v1" + (route === "" ? "" : "/" + route);
}

test.before(async () => {
  const port = await appModule.serverReady;
  runtime.baseUrl = "http://127.0.0.1:" + port;
  await HAXCMS.createSite(SITE_NAME);
  const login = await request("POST", systemUrl("session/login"), {
    headers: { accept: "application/json", "content-type": "application/json" },
    data: JSON.stringify({
      username: TEST_USER_NAME,
      password: TEST_USER_SECRET,
    }),
  });
  assert.equal(login.status, 200, login.bodyText);
  const loginBody = JSON.parse(login.bodyText);
  runtime.jwt = loginBody.jwt;
  runtime.userToken = loginBody.userToken;
  assert.ok(runtime.jwt, "login hands back a JWT");
  assert.ok(runtime.userToken, "login hands back a user token");
  // the needle every leak check searches for: what this install reports
  runtime.version = String((await HAXCMS.getHAXCMSVersion()) || "");
  assert.ok(
    runtime.version.length > 0,
    "this checkout has a version to protect",
  );
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
  ENV_KEYS.forEach(function (key) {
    restoreEnv(key, envSnapshots[key]);
  });
  delete globalThis.HAXCMS_RUNTIME_CREDENTIALS;
  fs.removeSync(tempRoot);
});

test("positive control: an authenticated system/version call reports the version", async () => {
  const result = await request("GET", systemUrl("system/version"), {
    headers: {
      accept: "application/json",
      authorization: "Bearer " + runtime.jwt,
      "x-haxcms-user-token": runtime.userToken,
    },
  });
  assert.equal(result.status, 200, result.bodyText);
  const body = JSON.parse(result.bodyText);
  assert.equal(body.data.version, runtime.version);
  assert.notEqual(
    findVersionLeak(result),
    "",
    "the leak detector finds the version where it is allowed",
  );
});

test("the version-reporting routes are admin routes, never open routes", () => {
  const reporters = ["system/version", "status"];
  for (let i = 0; i < reporters.length; i++) {
    assert.equal(
      SystemV1OpenRoutes.indexOf(reporters[i]),
      -1,
      reporters[i] + " must not be open",
    );
    assert.notEqual(
      SystemV1AdminRoutes.indexOf(reporters[i]),
      -1,
      reporters[i] + " must be admin-only",
    );
  }
});

test("anonymous system/version and status are refused without the version", async () => {
  const routes = ["system/version", "status"];
  const methods = ["GET", "POST"];
  for (let i = 0; i < routes.length; i++) {
    for (let j = 0; j < methods.length; j++) {
      const label = methods[j] + " " + routes[i];
      const result = await request(methods[j], systemUrl(routes[i]), {
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        data: "{}",
      });
      assert.equal(result.status, 401, label + " -> " + result.bodyText);
      assert.equal(findVersionLeak(result), "", label);
    }
  }
});

test("a forged bearer on system/version and status is refused without the version", async () => {
  // a syntactically valid JWT signed with a throwaway key the server never saw
  const jwt = require("jsonwebtoken");
  const forged = jwt.sign(
    { user: TEST_USER_NAME },
    crypto.randomBytes(32).toString("hex"),
    {
      expiresIn: 60,
    },
  );
  const routes = ["system/version", "status"];
  for (let i = 0; i < routes.length; i++) {
    const result = await request("GET", systemUrl(routes[i]), {
      headers: {
        accept: "application/json",
        authorization: "Bearer " + forged,
      },
    });
    assert.equal(result.status, 403, routes[i] + " -> " + result.bodyText);
    assert.equal(findVersionLeak(result), "", routes[i]);
  }
});

test("no open system route leaks the version to an anonymous caller", async () => {
  const methods = ["GET", "POST"];
  for (let i = 0; i < SystemV1OpenRoutes.length; i++) {
    for (let j = 0; j < methods.length; j++) {
      const label = methods[j] + " " + systemUrl(SystemV1OpenRoutes[i]);
      const result = await request(
        methods[j],
        systemUrl(SystemV1OpenRoutes[i]),
        {
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          data: "{}",
        },
      );
      assert.ok(result.status < 500, label + " answered " + result.status);
      assert.equal(findVersionLeak(result), "", label);
    }
  }
});

test("the anonymous dashboard and site surface do not leak the version", async () => {
  const site = "/_sites/" + SITE_NAME;
  const paths = [
    "/",
    "/home",
    site + "/",
    site + "/site.json",
    site + "/manifest.json",
    site + "/x/api",
    site + "/x/api/v1",
    site + "/x/api/openapi",
    site + "/x/api/openapi.json",
    site + "/x/api/openapi.yaml",
    site + "/x/api/v1/site",
    site + "/x/api/v1/items",
  ];
  for (let i = 0; i < paths.length; i++) {
    const result = await request("GET", runtime.baseUrl + paths[i], {
      headers: { accept: "application/json, text/html;q=0.9" },
    });
    assert.ok(result.status < 500, paths[i] + " answered " + result.status);
    assert.equal(findVersionLeak(result), "", paths[i]);
  }
});
