"use strict";

// In-process integration tests that boot the real server from src/app.js in
// MULTI-SITE local mode (HAXCMS_DISABLE_JWT_CHECKS=true) and drive raw HTTP
// requests (no client-side path normalization) to confirm:
// - HAX-SEC-STATIC-DOTFILES: a site's .git cannot be reached through
//   /.well-known/.. (raw or percent-encoded) while .well-known still serves.
// - HAX-SEC-LOCAL-ORIGIN: cross-site writes are refused in local mode while
//   same-origin and header-less (CLI) requests still work.
//
// Server-boot discipline honored: ephemeral port only (PORT=0), temp runtime
// dirs via fs.mkdtempSync, and the server is closed in test.after.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

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

const SITE_NAME = "dotfilesite";
const GIT_SECRET =
  "url = https://user:not-a-real-token@example.invalid/repo.git";

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
  "HAXCMS_DISABLE_JWT_CHECKS",
  "HAXCMS_HOST",
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
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "haxcms-static-dotfiles-"),
);
const runtimeRoot = path.join(tempRoot, "runtime");
const configRoot = path.join(runtimeRoot, "_config");
const sitesRoot = path.join(runtimeRoot, "_sites");

fs.ensureDirSync(sitesRoot);
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
const configDirs = [
  "tmp",
  "cache",
  "user",
  "user/files",
  "user/skeletons",
  "skeletons",
  "settings",
  "node_modules",
];
for (let i = 0; i < configDirs.length; i++) {
  fs.ensureDirSync(path.join(configRoot, configDirs[i]));
}

process.chdir(runtimeRoot);
process.env.HAXCMS_ROOT = runtimeRoot + "/";
process.env.PORT = "0";
process.env.NODE_ENV = "test";
process.env.HAXCMS_DISABLE_JWT_CHECKS = "true";
delete process.env.HAXCMS_HOST;
delete process.env.HAXCMS_ENABLE_SSL;
process.env.GIT_AUTHOR_NAME = "HAXcms Static Dotfiles Unit";
process.env.GIT_AUTHOR_EMAIL = "static-dotfiles-unit@local.invalid";
process.env.GIT_COMMITTER_NAME = process.env.GIT_AUTHOR_NAME;
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_AUTHOR_EMAIL;

const appModule = require(APP_ENTRY_PATH);
const { HAXCMS } = require(path.join(REPO_ROOT, "src", "lib", "HAXCMS.js"));

const runtime = { port: 0 };

// raw request: the path is sent exactly as given (no URL normalization)
function rawRequest(method, rawPath, headers, body) {
  return new Promise(function (resolve, reject) {
    const allHeaders = Object.assign(
      { host: "localhost:" + runtime.port },
      headers || {},
    );
    const reqOut = http.request(
      {
        host: "127.0.0.1",
        port: runtime.port,
        method: method,
        path: rawPath,
        headers: allHeaders,
      },
      function (res) {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          data += chunk;
        });
        res.on("end", function () {
          resolve({ status: res.statusCode, body: data });
        });
      },
    );
    reqOut.on("error", reject);
    if (body) {
      reqOut.write(body);
    }
    reqOut.end();
  });
}

test.before(async () => {
  runtime.port = await appModule.serverReady;
  await HAXCMS.createSite(SITE_NAME);
  const siteDir = path.join(sitesRoot, SITE_NAME);
  fs.ensureDirSync(path.join(siteDir, ".git"));
  fs.writeFileSync(
    path.join(siteDir, ".git", "config"),
    '[remote "origin"]\n\t' + GIT_SECRET + "\n",
  );
  fs.ensureDirSync(path.join(siteDir, ".well-known"));
  fs.writeFileSync(
    path.join(siteDir, ".well-known", "security.txt"),
    "Contact: mailto:security@example.invalid\n",
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
  for (let i = 0; i < ENV_KEYS.length; i++) {
    restoreEnv(ENV_KEYS[i], envSnapshots[ENV_KEYS[i]]);
  }
  fs.removeSync(tempRoot);
});

test("site .well-known file still serves", async () => {
  const res = await rawRequest(
    "GET",
    "/_sites/" + SITE_NAME + "/.well-known/security.txt",
  );
  assert.equal(res.status, 200);
  assert.match(res.body, /Contact:/);
});

test("site .git is not reachable directly or through .well-known traversal", async () => {
  const attempts = [
    "/_sites/" + SITE_NAME + "/.git/config",
    "/_sites/" + SITE_NAME + "/.well-known/../.git/config",
    "/_sites/" + SITE_NAME + "/.well-known/%2e%2e/.git/config",
    "/_sites/" + SITE_NAME + "/.well-known/%2E%2E%2F.git/config",
    "/_sites/" + SITE_NAME + "/.well-known/.git/../../.git/config",
    "/_sites/" + SITE_NAME + "/.well-known/%252e%252e/.git/config",
    "/_sites/" + SITE_NAME + "/.well-known/%252e%252e%252f.git/config",
  ];
  for (let i = 0; i < attempts.length; i++) {
    const res = await rawRequest("GET", attempts[i]);
    assert.notEqual(res.status, 200, attempts[i]);
    assert.equal(res.body.indexOf("not-a-real-token"), -1, attempts[i]);
  }
});

test("local mode refuses cross-site writes", async () => {
  const res = await rawRequest(
    "POST",
    "/system/api/v1/session/logout",
    {
      origin: "https://evil.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    "a=b",
  );
  assert.equal(res.status, 403);
  const fetchSite = await rawRequest(
    "POST",
    "/system/api/v1/session/logout",
    {
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded",
    },
    "a=b",
  );
  assert.equal(fetchSite.status, 403);
});

test("local mode still allows same-origin and header-less writes", async () => {
  const sameOrigin = await rawRequest(
    "POST",
    "/system/api/v1/session/logout",
    {
      origin: "http://localhost:" + runtime.port,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    "{}",
  );
  assert.notEqual(sameOrigin.status, 403, sameOrigin.body);
  const cli = await rawRequest(
    "POST",
    "/system/api/v1/session/logout",
    { "content-type": "application/json" },
    "{}",
  );
  assert.notEqual(cli.status, 403, cli.body);
});
