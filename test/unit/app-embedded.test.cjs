"use strict";

// HAXCMS_EMBEDDED=1 (haxtheweb/issues#3331): app.js builds the Express app and
// all routes as usual but creates no HTTP server, never listens and starts no
// background timers, so another runtime (haxcms-browser's Worker) can host it.
// The host waits for `appReady` and dispatches requests to `app` itself.
//
// Runs in a child process (test/_helpers/embedded-app-child.cjs) so app.js
// loads fresh with the flag, in a temp root and HOME, and so "exits on its
// own" can be checked: a leftover server or timer would keep it alive.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CHILD = path.join(__dirname, "..", "_helpers", "embedded-app-child.cjs");

test("HAXCMS_EMBEDDED: routes are ready, no server is created and the process exits on its own", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-embedded-"));
  try {
    const env = Object.assign({}, process.env, {
      HOME: root,
      USERPROFILE: root,
      VERCEL_ENV: "",
      NODE_ENV: "",
    });
    delete env.PORT;
    delete env.HAXCMS_ENABLE_SSL;
    const res = spawnSync(process.execPath, [CHILD], {
      cwd: root,
      env: env,
      encoding: "utf8",
      // a server or interval left running would hit this instead of exiting
      timeout: 60000,
    });
    assert.equal(
      res.signal,
      null,
      "child did not exit on its own:\n" + res.stdout + res.stderr,
    );
    const line = String(res.stdout || "")
      .split("\n")
      .find(function (l) {
        return l.indexOf("RESULT ") === 0;
      });
    assert.ok(line, "no result from child:\n" + res.stdout + res.stderr);
    const result = JSON.parse(line.slice("RESULT ".length));
    assert.equal(res.status, 0, res.stderr);
    assert.equal(result.embeddedRuntime, true);
    assert.equal(result.serverIsNull, true, "no HTTP server is created");
    assert.equal(result.serverReadyResolved, false, "nothing listened");
    assert.equal(
      result.openapiStatus,
      200,
      "a host-owned server can serve the app",
    );
    assert.equal(result.openapiIsJson, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
