"use strict";

// haxtheweb/issues#3201: a HAXsite kept inside a larger git repo (its own .git removed so the
// parent repo tracks it) must leave versioning to that repo. Previously
// gitCommit() ran `git add/commit` in the site folder, which git resolves to
// the enclosing repo, so every page save committed the parent's whole work
// tree, and gitRevert() ran `git reset --hard` there.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "site-git-scope-"));
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMSSite, siteGitScope } = require("../../src/lib/HAXCMS.js");

test.after(() => {
  fs.removeSync(testRoot);
});

function hasGit() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.test",
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd: cwd, env: GIT_ENV })
    .toString()
    .trim();
}

// a parent repo with one commit and a site folder inside it (no .git of its own)
function parentRepoWithSite(name) {
  const parent = fs.mkdtempSync(path.join(testRoot, name + "-"));
  git(parent, ["init", "-q"]);
  fs.writeFileSync(path.join(parent, "README.md"), "parent\n");
  git(parent, ["add", "."]);
  git(parent, ["commit", "-q", "-m", "parent start"]);
  const siteDir = path.join(parent, "mysite");
  fs.mkdirSync(siteDir);
  fs.writeFileSync(path.join(siteDir, "site.json"), "{}\n");
  const site = new HAXCMSSite();
  site.siteDirectory = siteDir;
  site.manifest = { metadata: { site: { git: {} } } };
  return { parent: parent, siteDir: siteDir, site: site };
}

describe("siteGitScope", () => {
  test("own: the folder has its own .git (folder or file)", () => {
    const dir = fs.mkdtempSync(path.join(testRoot, "own-"));
    fs.mkdirSync(path.join(dir, ".git"));
    assert.equal(siteGitScope(dir), "own");
    const wt = fs.mkdtempSync(path.join(testRoot, "own-file-"));
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: /somewhere/else\n");
    assert.equal(siteGitScope(wt), "own");
  });

  test("parent: an enclosing folder has the .git", () => {
    const dir = fs.mkdtempSync(path.join(testRoot, "parent-"));
    fs.mkdirSync(path.join(dir, ".git"));
    fs.mkdirpSync(path.join(dir, "a", "b", "site"));
    assert.equal(siteGitScope(path.join(dir, "a", "b", "site")), "parent");
  });

  test("none: no repo anywhere above (or no folder given)", () => {
    assert.equal(siteGitScope(""), "none");
    assert.equal(siteGitScope(null), "none");
  });
});

describe(
  "HAXCMSSite git operations inside a parent repo",
  { skip: !hasGit() },
  () => {
    test("gitCommit leaves the parent repo alone and makes no nested repo", async () => {
      const fx = parentRepoWithSite("commit");
      fs.writeFileSync(path.join(fx.siteDir, "page.html"), "<p>new</p>\n");
      const head = git(fx.parent, ["rev-parse", "HEAD"]);
      assert.equal(await fx.site.gitCommit("Page saved"), true);
      assert.equal(
        git(fx.parent, ["rev-parse", "HEAD"]),
        head,
        "no commit in the parent repo",
      );
      assert.equal(
        fs.existsSync(path.join(fx.siteDir, ".git")),
        false,
        "no nested repo",
      );
      // the change is still there for the parent repo's owner to commit
      assert.match(git(fx.parent, ["status", "--porcelain"]), /mysite\//);
    });

    test("gitRevert never resets the parent repo", async () => {
      const fx = parentRepoWithSite("revert");
      fs.writeFileSync(path.join(fx.parent, "README.md"), "parent, second\n");
      git(fx.parent, ["commit", "-q", "-am", "parent second"]);
      const head = git(fx.parent, ["rev-parse", "HEAD"]);
      assert.equal(await fx.site.gitRevert(1), true);
      assert.equal(git(fx.parent, ["rev-parse", "HEAD"]), head);
      assert.equal(
        fs.readFileSync(path.join(fx.parent, "README.md"), "utf8"),
        "parent, second\n",
      );
    });

    test("gitPush and gitSetRemote do not touch the parent repo", async () => {
      const fx = parentRepoWithSite("push");
      fs.writeFileSync(path.join(fx.siteDir, "page.html"), "<p>new</p>\n");
      const head = git(fx.parent, ["rev-parse", "HEAD"]);
      assert.equal(await fx.site.gitPush(), true);
      assert.equal(git(fx.parent, ["rev-parse", "HEAD"]), head);
      assert.equal(
        await fx.site.gitSetRemote({ url: "https://git.example.test/x/y.git" }),
        false,
      );
      assert.equal(git(fx.parent, ["remote"]), "");
    });
  },
);

describe(
  "HAXCMSSite git operations in the site's own repo",
  { skip: !hasGit() },
  () => {
    test("gitCommit still commits a site that has its own repo", async () => {
      const fx = parentRepoWithSite("own-commit");
      git(fx.siteDir, ["init", "-q"]);
      fs.writeFileSync(path.join(fx.siteDir, "page.html"), "<p>new</p>\n");
      const prev = process.env;
      process.env = GIT_ENV;
      try {
        assert.equal(await fx.site.gitCommit("Page saved"), true);
      } finally {
        process.env = prev;
      }
      // git-interface keeps the quotes it wraps messages in, so match loosely
      assert.match(git(fx.siteDir, ["log", "-1", "--format=%s"]), /Page saved/);
      assert.equal(git(fx.siteDir, ["status", "--porcelain"]), "");
    });

    test("gitCommit makes a site outside any repo its own repo first", async (t) => {
      // os.tmpdir() itself may sit inside a repo on some machines; only assert
      // when the fresh folder really is outside every repo
      const dir = fs.mkdtempSync(path.join(testRoot, "none-"));
      if (siteGitScope(dir) !== "none") {
        t.skip("temp folder is inside a git repo on this machine");
        return;
      }
      fs.writeFileSync(path.join(dir, "site.json"), "{}\n");
      const site = new HAXCMSSite();
      site.siteDirectory = dir;
      site.manifest = { metadata: { site: { git: {} } } };
      const prev = process.env;
      process.env = GIT_ENV;
      try {
        assert.equal(await site.gitCommit("Managed files updated"), true);
      } finally {
        process.env = prev;
      }
      assert.equal(siteGitScope(dir), "own");
      assert.match(
        git(dir, ["log", "-1", "--format=%s"]),
        /Managed files updated/,
      );
    });
  },
);
