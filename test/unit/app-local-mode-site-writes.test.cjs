"use strict";

// Local mode (HAXCMS_DISABLE_JWT_CHECKS: `hax serve`, npx haxcms-nodejs)
// treats every request as the active user, so outline saves through the site
// API must work there. They were refused with 403 "Authentication required":
// the site API auth context had no user name in local mode, and saveOutline
// binds the site token to that name. Failure behavior is unchanged: a parent
// cycle is still rejected without writing site.json, and a missing site
// token header is still refused.
//
// Runs in a child process (test/_helpers/local-mode-writes-child.cjs) so
// app.js boots fresh in local mode in a temp root and HOME.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CHILD = path.join(
  __dirname,
  "..",
  "_helpers",
  "local-mode-writes-child.cjs",
);

test("local mode: outline saves work, failed saves still don't write", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-local-writes-"));
  try {
    const env = Object.assign({}, process.env, {
      HOME: root,
      USERPROFILE: root,
      VERCEL_ENV: "",
      NODE_ENV: "",
    });
    delete env.HAXCMS_ENABLE_SSL;
    const res = spawnSync(process.execPath, [CHILD], {
      cwd: root,
      env: env,
      encoding: "utf8",
      timeout: 90000,
    });
    const line = String(res.stdout || "")
      .split("\n")
      .find(function (l) {
        return l.indexOf("RESULT ") === 0;
      });
    assert.ok(line, "no result from child:\n" + res.stdout + res.stderr);
    const result = JSON.parse(line.slice("RESULT ".length));
    assert.equal(result.createStatus, 200);
    assert.equal(
      result.seedStatus,
      200,
      "outline save is accepted in local mode",
    );
    // the new site's starter page stays; the saved pages are added
    assert.ok(
      result.titles.indexOf("A") !== -1 && result.titles.indexOf("B") !== -1,
      result.titles.join(", "),
    );
    assert.equal(result.cycleStatus, 400, "a parent cycle is still rejected");
    assert.equal(
      result.cycleLeftSiteJsonUnchanged,
      true,
      "a rejected save does not write",
    );
    assert.equal(
      result.noTokenStatus,
      403,
      "the site token header is still required",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
