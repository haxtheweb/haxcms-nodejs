"use strict";

// Unit tests for commit op codes (haxtheweb/issues#3191):
//   src/lib/commitContext.js  format / parse / actor + client allowlists /
//                             per-request context / operationId lookup
//   src/lib/GitPlus.js        commit() stores the subject exactly as given
//   HAXCMSSite.gitCommit()    prefixes real commits from the request context
//   revisions getCommitOpFields  parses prefixed and legacy subjects
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const os = require("os");
const path = require("path");
const fs = require("fs-extra");

const commitContext = require("../../src/lib/commitContext.js");
const GitPlus = require("../../src/lib/GitPlus.js");
const {
  HAXCMSSite,
  sanitizeGitCommitMessage,
} = require("../../src/lib/HAXCMS.js");
const { getCommitOpFields } = require("../../src/siteRoutes/v1/revisions.js");
const { SiteRoutesMap } = require("../../src/lib/SiteRoutesMap.js");

const {
  COMMIT_MESSAGE_MAX_LENGTH,
  normalizeActor,
  normalizeOp,
  createTxn,
  createRequestCommitContext,
  runWithCommitContext,
  getCommitContext,
  getFallbackCommitContext,
  formatCommitPrefix,
  formatCommitMessage,
  parseCommitMessage,
  getOperationId,
  buildOperationIdIndex,
} = commitContext;

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-ctx-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function lastSubject(dir) {
  return execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir })
    .toString()
    .replace(/\n$/, "");
}

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

describe("actor and op allowlists", () => {
  test("actor accepts human/agent words or letters, case-insensitive", () => {
    assert.equal(normalizeActor("agent"), "A");
    assert.equal(normalizeActor(" Agent "), "A");
    assert.equal(normalizeActor("a"), "A");
    assert.equal(normalizeActor("human"), "H");
    assert.equal(normalizeActor("H"), "H");
  });

  test("actor rejects everything else, including S and X", () => {
    for (const value of [
      "S",
      "X",
      "system",
      "robot",
      "",
      "mcp",
      null,
      undefined,
      7,
    ]) {
      assert.equal(normalizeActor(value), "", String(value));
    }
  });

  test("op keeps letters and digits only, starts with a letter, max 48", () => {
    assert.equal(normalizeOp("updateSiteOutline"), "updateSiteOutline");
    assert.equal(normalizeOp(" update Item "), "updateItem");
    assert.equal(normalizeOp("plugin:ga:save"), "plugingasave");
    assert.equal(normalizeOp("up]date:[x"), "updatex");
    assert.equal(normalizeOp("9lives"), "");
    assert.equal(normalizeOp("a".repeat(80)).length, 48);
  });

  test("txn is 4 lowercase alphanumerics", () => {
    for (let i = 0; i < 50; i++) {
      assert.match(createTxn(), /^[a-z0-9]{4}$/);
    }
  });
});

describe("request context", () => {
  test("no header means a human", () => {
    const ctx = createRequestCommitContext({ headers: {} }, "updateItem");
    assert.equal(ctx.actor, "H");
    assert.equal(ctx.op, "updateItem");
    assert.match(ctx.txn, /^[a-z0-9]{4}$/);
  });

  test("X-HAX-Actor is read (node lowercases header names)", () => {
    const ctx = createRequestCommitContext(
      { headers: { "x-hax-actor": "agent" } },
      "updateItem",
    );
    assert.equal(ctx.actor, "A");
  });

  test("anything but human/agent falls back to human", () => {
    for (const value of ["S", "X", "robot", "agent] [H", ""]) {
      const ctx = createRequestCommitContext(
        { headers: { "x-hax-actor": value } },
        "updateItem",
      );
      assert.equal(ctx.actor, "H", value);
    }
  });

  test("context survives awaits and parallel requests stay isolated", async () => {
    const seen = [];
    const run = (actor, op) =>
      runWithCommitContext({ actor, op, txn: "abcd" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(getCommitContext().actor + ":" + getCommitContext().op);
      });
    await Promise.all([run("H", "updateItem"), run("A", "deleteItem")]);
    assert.deepEqual(seen.sort(), ["A:deleteItem", "H:updateItem"]);
    assert.equal(getCommitContext(), null);
  });

  test("outside a request: HAX_ACTOR, else system", () => {
    withEnv({ HAX_ACTOR: undefined }, () => {
      assert.equal(getFallbackCommitContext().actor, "S");
    });
    withEnv({ HAX_ACTOR: "agent" }, () => {
      assert.equal(getFallbackCommitContext().actor, "A");
    });
  });
});

describe("format and parse", () => {
  const ctx = { actor: "A", op: "updateItem", txn: "x9r1" };

  test("prefix shape", () => {
    assert.equal(formatCommitPrefix(ctx), "[A:updateItem:x9r1]");
    assert.equal(
      formatCommitPrefix({ actor: "H", op: "updateSiteOutline", txn: "kp39" }),
      "[H:updateSiteOutline:kp39]",
    );
    assert.equal(
      formatCommitPrefix({ actor: "S", op: "upgradeManagedFiles", txn: "" }),
      "[S:upgradeManagedFiles]",
    );
    assert.equal(formatCommitPrefix({}), "[S:system]");
    // X is never written, nor anything outside the alphabet
    assert.equal(
      formatCommitPrefix({ actor: "X", op: "up date]", txn: "a b c d" }),
      "[S:update:abcd]",
    );
  });

  test("examples from the issue round-trip", () => {
    const examples = [
      "[H:updateItem:p7qa] Page details updated: Photosynthesis basics (item-3f2a)",
      "[H:updateSiteOutline:kp39] Page deleted: Old intro (item-8c1e)",
      "[H:updateSiteOutline:kp39] Outline updated in bulk",
      "[H:replaceContent:m2d8] Bulk replace chloroplast -> chloroplasts across 6 pages",
      "[A:updateItem:x9r1] Page details updated: Photosynthesis basics (item-3f2a)",
      "[S:upgradeManagedFiles] Managed files upgraded: legacy bootstrap",
      "[A:direct] Fixed alt text on 3 images",
    ];
    for (const line of examples) {
      const parsed = parseCommitMessage(line);
      assert.notEqual(parsed.actor, "X", line);
      assert.equal(formatCommitPrefix(parsed) + " " + parsed.summary, line);
    }
    assert.deepEqual(parseCommitMessage("[A:updateItem:x9r1] Rewrote intro"), {
      actor: "A",
      op: "updateItem",
      txn: "x9r1",
      summary: "Rewrote intro",
    });
  });

  test("anything else is external (X), shown as-is", () => {
    const cases = {
      "Outline updated in bulk": "Outline updated in bulk",
      "'Outline updated in bulk'": "Outline updated in bulk",
      "Fix typo   on   about page  ": "Fix typo on about page",
      "[X:external] hand edit": "[X:external] hand edit",
      "[H/outline updateSiteOutline k3f9] old draft format":
        "[H/outline updateSiteOutline k3f9] old draft format",
      "[H:update-item:abcd] dashes not allowed":
        "[H:update-item:abcd] dashes not allowed",
      "": "",
    };
    for (const line of Object.keys(cases)) {
      assert.deepEqual(
        parseCommitMessage(line),
        { actor: "X", op: "", txn: "", summary: cases[line] },
        line,
      );
    }
  });

  test("whitespace in the message is collapsed and trimmed", () => {
    assert.equal(
      formatCommitMessage("  Page   added:\tIntro  ", "", ctx),
      "[A:updateItem:x9r1] Page added: Intro",
    );
    // through the sanitizer first, as gitCommit does: tabs and newlines
    // become spaces so words are never glued together
    assert.equal(
      formatCommitMessage(
        sanitizeGitCommitMessage('Page added:\tBob\'s "page"\nline2'),
        "",
        ctx,
      ),
      "[A:updateItem:x9r1] Page added: Bobs page line2",
    );
  });

  test("the prefix is never cut and the whole line stays within the cap", () => {
    const long = sanitizeGitCommitMessage(
      "Page details updated: " + "x".repeat(400),
    );
    const out = formatCommitMessage(long, "", ctx);
    assert.ok(out.length <= COMMIT_MESSAGE_MAX_LENGTH, String(out.length));
    assert.ok(out.indexOf("[A:updateItem:x9r1] Page details updated: ") === 0);
  });

  test("opOverride replaces the op for one commit, keeping actor and txn", () => {
    assert.equal(
      formatCommitMessage("Site created", "siteCreate", ctx),
      "[A:siteCreate:x9r1] Site created",
    );
  });

  test("an already-prefixed message is not prefixed twice", () => {
    assert.equal(
      formatCommitMessage("[A:direct] Fixed alt text", "", ctx),
      "[A:direct] Fixed alt text",
    );
  });

  test("uses the active request context when none is passed", () => {
    const out = runWithCommitContext(ctx, () =>
      formatCommitMessage("Page deleted: Old intro (item-1)"),
    );
    assert.equal(out, "[A:updateItem:x9r1] Page deleted: Old intro (item-1)");
  });

  test("the prefix never contains characters the sanitizer strips", () => {
    const prefix = formatCommitPrefix(ctx);
    assert.equal(sanitizeGitCommitMessage(prefix), prefix);
  });
});

describe("operationId lookup from the OpenAPI specs", () => {
  test("known routes map to their spec operationId", () => {
    assert.equal(
      getOperationId("site", "patch", "v1/site/outline"),
      "updateSiteOutline",
    );
    assert.equal(getOperationId("site", "post", "v1/items"), "createItem");
    assert.equal(
      getOperationId("site", "patch", "v1/items/:idOrSlug"),
      "updateItem",
    );
    assert.equal(
      getOperationId("site", "delete", "v1/items/:idOrSlug"),
      "deleteItem",
    );
    assert.equal(
      getOperationId("site", "patch", "v1/content"),
      "replaceContent",
    );
    assert.equal(
      getOperationId(
        "site",
        "post",
        "v1/items/:idOrSlug/revisions/:revisionId/restore",
      ),
      "restoreItemRevision",
    );
    assert.equal(getOperationId("system", "post", "sites"), "createSite");
  });

  test("every mutating site route is in the spec (no fallback op codes)", () => {
    const index = buildOperationIdIndex();
    const missing = [];
    for (const method of Object.keys(SiteRoutesMap)) {
      if (method === "get") {
        continue;
      }
      for (const route of Object.keys(SiteRoutesMap[method])) {
        if (
          !Object.prototype.hasOwnProperty.call(
            index.site,
            method + " " + route,
          )
        ) {
          missing.push(method + " " + route);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  test("a route missing from the spec still gets a stable op code", () => {
    assert.equal(
      getOperationId("site", "post", "v1/widgets/:id/frobnicate"),
      "postV1WidgetsFrobnicate",
    );
  });
});

describe("GitPlus.commit stores the subject exactly", () => {
  test("no literal quotes, spaces and brackets kept, one argument", async () => {
    const dir = tmpRepo();
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "a");
      const git = new GitPlus({ dir: dir, cliVersion: "git version test" });
      await git.add();
      await git.commit(
        "[A:updateItem:x9r1] Page details updated: Photo (item-1)",
      );
      assert.equal(
        lastSubject(dir),
        "[A:updateItem:x9r1] Page details updated: Photo (item-1)",
      );
    } finally {
      fs.removeSync(dir);
    }
  });

  test("a message that looks like git options is just a message", async () => {
    const dir = tmpRepo();
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "a");
      const git = new GitPlus({ dir: dir, cliVersion: "git version test" });
      await git.add();
      await git.commit("--amend --no-verify");
      assert.equal(lastSubject(dir), "--amend --no-verify");
    } finally {
      fs.removeSync(dir);
    }
  });

  test("a failed commit rejects (nothing to commit)", async () => {
    const dir = tmpRepo();
    try {
      const git = new GitPlus({ dir: dir, cliVersion: "git version test" });
      await assert.rejects(() =>
        git.commit("[H:updateItem:abcd] nothing here"),
      );
    } finally {
      fs.removeSync(dir);
    }
  });
});

describe("HAXCMSSite.gitCommit()", () => {
  function fakeSite(dir) {
    return {
      siteDirectory: dir,
      manifest: { metadata: { site: { git: {} } } },
      gitTest: async () => "git version test",
    };
  }

  test("prefixes from the request context", async () => {
    const dir = tmpRepo();
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "a");
      await runWithCommitContext(
        { actor: "H", op: "updateSiteOutline", txn: "kp39" },
        () =>
          HAXCMSSite.prototype.gitCommit.call(
            fakeSite(dir),
            "Outline updated in bulk",
          ),
      );
      assert.equal(
        lastSubject(dir),
        "[H:updateSiteOutline:kp39] Outline updated in bulk",
      );
    } finally {
      fs.removeSync(dir);
    }
  });

  test("outside a request it is a system commit, op overridable", async () => {
    const dir = tmpRepo();
    try {
      await withEnv({ HAX_ACTOR: undefined }, async () => {
        fs.writeFileSync(path.join(dir, "a.txt"), "a");
        await HAXCMSSite.prototype.gitCommit.call(
          fakeSite(dir),
          "Managed files upgraded: legacy bootstrap",
          "upgradeManagedFiles",
        );
      });
      assert.equal(
        lastSubject(dir),
        "[S:upgradeManagedFiles] Managed files upgraded: legacy bootstrap",
      );
    } finally {
      fs.removeSync(dir);
    }
  });

  test("quotes in titles are still stripped, prefix intact", async () => {
    const dir = tmpRepo();
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "a");
      await runWithCommitContext(
        { actor: "A", op: "updateItem", txn: "x9r1" },
        () =>
          HAXCMSSite.prototype.gitCommit.call(
            fakeSite(dir),
            'Page details updated: Bob\'s "page" (item-1)',
          ),
      );
      assert.equal(
        lastSubject(dir),
        "[A:updateItem:x9r1] Page details updated: Bobs page (item-1)",
      );
    } finally {
      fs.removeSync(dir);
    }
  });
});

describe("revision records", () => {
  test("prefixed subjects are split into op fields", () => {
    assert.deepEqual(
      getCommitOpFields("[H:updateSiteOutline:kp39] Outline updated in bulk"),
      {
        actor: "H",
        op: "updateSiteOutline",
        txn: "kp39",
        summary: "Outline updated in bulk",
      },
    );
  });

  test("legacy subjects are X and lose the stored quotes", () => {
    assert.deepEqual(getCommitOpFields("'Outline updated in bulk'"), {
      actor: "X",
      op: "",
      txn: "",
      summary: "Outline updated in bulk",
    });
  });
});
