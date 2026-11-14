"use strict";

// haxtheweb/issues#3351: the site folder contract.
//
// src/boilerplate/site-contract.json is this repo's copy of
// schema/haxcms-site-contract.json from
// https://github.com/haxtheweb/json-outline-schema (haxcms-php carries the
// same copy at system/boilerplate/site-contract.json). It lists every path a
// HAXcms site folder may hold: required, optional or retired, and who owns
// it. These tests fail when this backend and the contract disagree, so adding
// or dropping a site file is a deliberate edit to the contract:
//
//   - the site boilerplate ships exactly the contract's boilerplate entries
//   - getManagedTemplateFiles() and the managed-file policies match the
//     contract's managed entries
//   - a site this backend just made has every required path at every level,
//     no retired path, and no file the contract does not know
//   - files/ exists in the boilerplate and in a new site, even when empty
//   - rebuildManagedFiles() really rewrites every file the contract calls
//     managed (ghpages.html, index.php and config.php included)
//
// The full validator (schema checks on site.json, level reporting) lives in
// json-outline-schema as `jos-validate --site`; the matcher below is only
// what these comparisons need.
//
// A temp runtime with a seeded _config is created and cwd moved into it
// BEFORE src/lib/HAXCMS.js is first required, so every write stays inside
// the temp tree.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BOILERPLATE = path.join(REPO_ROOT, "src", "boilerplate");
const BOILERPLATE_SITE = path.join(BOILERPLATE, "site");
const BOILERPLATE_SYSTEMSETUP = path.join(BOILERPLATE, "systemsetup");
const CONTRACT = JSON.parse(
  fs.readFileSync(path.join(BOILERPLATE, "site-contract.json"), "utf8"),
);

// Managed paths written by a rebuild step other than the
// getManagedTemplateFiles() copy loop. Add to this list only with the code
// that writes the file.
const MANAGED_OUTSIDE_TEMPLATE_LIST = [
  // HAXCMSSite.rebuildAgentSkills() copies the skills and their index
  ".well-known/agent-skills/index.json",
  // HAXCMSSite.rebuildManagedFiles() adds the PHP entry point and its
  // settings to the template list on every full rebuild
  "index.php",
  "config.php",
];

// ---------------------------------------------------------------------------
// contract matching: `*` stays inside one path segment, `**` crosses them; a
// path without a wildcard is matched first, then the first matching entry
// ---------------------------------------------------------------------------
function hasWildcard(pattern) {
  return pattern.indexOf("*") !== -1;
}

// a folder entry is about the folder existing; it never classifies a file
function isFolderEntry(entry) {
  return entry.kind === "folder";
}

function patternToRegExp(pattern) {
  const source = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp("^" + source + "$");
}

const LITERALS = new Map();
const PATTERNS = [];
CONTRACT.entries.forEach((entry) => {
  if (isFolderEntry(entry)) {
    return;
  }
  if (hasWildcard(entry.path)) {
    PATTERNS.push({ entry: entry, test: patternToRegExp(entry.path) });
  } else if (!LITERALS.has(entry.path)) {
    LITERALS.set(entry.path, entry);
  }
});

function classify(relativePath) {
  if (LITERALS.has(relativePath)) {
    return LITERALS.get(relativePath);
  }
  for (let i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i].test.test(relativePath)) {
      return PATTERNS[i].entry;
    }
  }
  return null;
}

// every file and symbolic link under root (links listed, never followed)
function listFolder(root) {
  const ignore = CONTRACT.ignore || [];
  const found = [];
  const walk = (dir, prefix) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (prefix === "" && ignore.indexOf(entry.name) !== -1) {
        return;
      }
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), prefix + entry.name + "/");
      } else {
        found.push(prefix + entry.name);
      }
    });
  };
  walk(root, "");
  return found.sort();
}

function contractPaths(filter) {
  return CONTRACT.entries
    .filter(
      (entry) =>
        !hasWildcard(entry.path) && !isFolderEntry(entry) && filter(entry),
    )
    .map((entry) => entry.path)
    .sort();
}

// required folders (they must exist even when empty) missing under root
function missingFolders(root) {
  return CONTRACT.entries
    .filter((entry) => isFolderEntry(entry) && entry.status === "required")
    .map((entry) => entry.path)
    .filter((folder) => {
      try {
        return !fs.statSync(path.join(root, folder)).isDirectory();
      } catch {
        return true;
      }
    });
}

function isManaged(entry) {
  return entry.owner === "managed" || entry.owner === "partly-managed";
}

// ---------------------------------------------------------------------------
// temp runtime, then the first require of HAXCMS.js
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-contract-"));
const runtimeRoot = path.join(tempRoot, "runtime");
const configRoot = path.join(runtimeRoot, "_config");
const sitesRoot = path.join(runtimeRoot, "_sites");

fs.ensureDirSync(configRoot);
fs.ensureDirSync(sitesRoot);
fs.writeFileSync(path.join(configRoot, ".isHAXcmsConfig"), "");
[
  "config.json",
  "my-custom-elements.js",
  "userData.json",
  "config.php",
  ".htaccess",
  ".user-files-htaccess",
].forEach((file) => {
  fs.copySync(
    path.join(BOILERPLATE_SYSTEMSETUP, file),
    path.join(configRoot, file),
  );
});
[
  "tmp",
  "cache",
  path.join("user", "files"),
  path.join("user", "skeletons"),
  "skeletons",
  "settings",
  "node_modules",
].forEach((dir) => {
  fs.ensureDirSync(path.join(configRoot, dir));
});
fs.writeFileSync(
  path.join(configRoot, ".user"),
  JSON.stringify({ name: "contract-user", password: "contract-pass" }, null, 2),
);

process.chdir(runtimeRoot);
// HAXCMS.js mixes string concat and path.join, so the root needs a trailing
// slash (same as the other site tests)
process.env.HAXCMS_ROOT = runtimeRoot + "/";
process.env.GIT_AUTHOR_NAME = "HAXcms Contract";
process.env.GIT_AUTHOR_EMAIL = "contract@local.invalid";
process.env.GIT_COMMITTER_NAME = "HAXcms Contract";
process.env.GIT_COMMITTER_EMAIL = "contract@local.invalid";

const { HAXCMS, HAXCMSSite } = require("../../src/lib/HAXCMS.js");
const { getManagedFilePolicy } = require("../../src/lib/managedFiles.js");

test.after(() => {
  process.chdir(originalCwd);
  delete process.env.HAXCMS_ROOT;
  fs.removeSync(tempRoot);
});

// ---------------------------------------------------------------------------
// the contract copy itself
// ---------------------------------------------------------------------------
test("contract: levels and entries are well formed", () => {
  const levels = CONTRACT.levels.map((level) => level.id);
  assert.deepEqual(levels, ["content", "runnable", "managed"]);
  const seen = new Set();
  CONTRACT.entries.forEach((entry) => {
    assert.equal(seen.has(entry.path), false, "duplicate " + entry.path);
    seen.add(entry.path);
    assert.ok(
      ["required", "optional", "retired"].indexOf(entry.status) !== -1,
      entry.path + " status",
    );
    if (entry.status === "required") {
      assert.ok(levels.indexOf(entry.level) !== -1, entry.path + " level");
    } else {
      assert.equal(entry.level, undefined, entry.path + " has a level");
    }
    assert.equal(
      isManaged(entry),
      typeof entry.policy === "string",
      entry.path + " policy",
    );
  });
});

// ---------------------------------------------------------------------------
// boilerplate
// ---------------------------------------------------------------------------
test("boilerplate: ships exactly the contract's boilerplate entries", () => {
  const files = listFolder(BOILERPLATE_SITE);
  const present = new Set(files);
  const missing = contractPaths((entry) => entry.boilerplate === true).filter(
    (file) => !present.has(file),
  );
  const extra = [];
  const retired = [];
  files.forEach((file) => {
    const entry = classify(file);
    if (entry && entry.status === "retired") {
      retired.push(file);
    } else if (!entry || entry.boilerplate !== true) {
      extra.push(file);
    }
  });
  assert.deepEqual(
    missing,
    [],
    "the contract says the boilerplate ships these; add the file or change src/boilerplate/site-contract.json",
  );
  assert.deepEqual(
    extra,
    [],
    "the boilerplate ships files no boilerplate entry covers; add them to src/boilerplate/site-contract.json (and the json-outline-schema and haxcms-php copies)",
  );
  assert.deepEqual(retired, [], "the boilerplate still ships a retired path");
  // files/ must exist in every site, so the boilerplate carries it (kept in
  // git by files/.gitkeep)
  assert.deepEqual(missingFolders(BOILERPLATE_SITE), []);
  assert.ok(present.has("files/.gitkeep"));
});

// ---------------------------------------------------------------------------
// managed files
// ---------------------------------------------------------------------------
test("managed files: getManagedTemplateFiles() matches the contract's managed entries", () => {
  const templates = new HAXCMSSite().getManagedTemplateFiles();
  const listed = Object.keys(templates)
    .map((key) => templates[key])
    .sort();
  const expected = contractPaths(isManaged)
    .filter((file) => MANAGED_OUTSIDE_TEMPLATE_LIST.indexOf(file) === -1)
    .sort();
  assert.deepEqual(listed, expected);
  MANAGED_OUTSIDE_TEMPLATE_LIST.forEach((file) => {
    const entry = classify(file);
    assert.ok(
      entry && isManaged(entry),
      file + " is not managed in the contract",
    );
  });
});

test("managed files: each file's policy matches the contract", () => {
  const templates = new HAXCMSSite().getManagedTemplateFiles();
  Object.keys(templates).forEach((key) => {
    const entry = classify(templates[key]);
    assert.ok(entry, templates[key] + " has no contract entry");
    assert.equal(
      getManagedFilePolicy(key).policy,
      entry.policy,
      templates[key] + " policy",
    );
    assert.equal(
      entry.owner,
      entry.policy === "replace" ? "managed" : "partly-managed",
      templates[key] + " owner",
    );
    assert.equal(entry.status, "required", templates[key] + " status");
  });
});

// ---------------------------------------------------------------------------
// a site this backend just made
// ---------------------------------------------------------------------------
test("new site: meets every level, holds nothing retired and nothing unknown", async () => {
  const site = await HAXCMS.createSite("contract-site", null, null, {
    structure: "course",
    type: "6w",
  });
  assert.ok(site);
  const siteDir = path.join(sitesRoot, "contract-site");
  const files = listFolder(siteDir);
  const present = new Set(files);

  const missing = contractPaths((entry) => entry.status === "required").filter(
    (file) => !present.has(file),
  );
  assert.deepEqual(missing, [], "required by the contract, not in a new site");
  assert.deepEqual(
    missingFolders(siteDir),
    [],
    "a new site lacks a folder the contract requires",
  );

  const unknown = [];
  const retired = [];
  files.forEach((file) => {
    const entry = classify(file);
    if (!entry) {
      unknown.push(file);
    } else if (entry.status === "retired") {
      retired.push(file);
    }
  });
  assert.deepEqual(
    unknown,
    [],
    "a new site holds files the contract does not know; add them to src/boilerplate/site-contract.json (and the json-outline-schema and haxcms-php copies)",
  );
  assert.deepEqual(retired, [], "a new site holds a retired path");

  // content level: a file at every item's location, inside the site
  const manifest = JSON.parse(
    fs.readFileSync(path.join(siteDir, "site.json"), "utf8"),
  );
  assert.equal(manifest.items.length, 7);
  manifest.items.forEach((item) => {
    assert.equal(item.location, "pages/" + item.id + "/index.html");
    assert.ok(present.has(item.location), item.location + " is missing");
  });
});

// ---------------------------------------------------------------------------
// the contract says "managed"; the rebuild has to agree
// ---------------------------------------------------------------------------
test("rebuild: every file the contract calls managed is rewritten by rebuildManagedFiles()", async () => {
  const site = await HAXCMS.createSite("contract-rebuild");
  assert.ok(site);
  const siteDir = path.join(sitesRoot, "contract-rebuild");
  // whole-file managed entries, except the skills index (covered by
  // agent-skills-integrity.test.cjs: it is copied with its skill files)
  const managed = contractPaths(
    (entry) => entry.owner === "managed" && entry.policy === "replace",
  ).filter((file) => file !== ".well-known/agent-skills/index.json");
  assert.ok(managed.indexOf("ghpages.html") !== -1);
  assert.ok(managed.indexOf("index.php") !== -1);
  assert.ok(managed.indexOf("config.php") !== -1);
  const DAMAGE = "damaged by site-contract.test.cjs";
  const before = {};
  managed.forEach((file) => {
    before[file] = fs.readFileSync(path.join(siteDir, file), "utf8");
    fs.writeFileSync(path.join(siteDir, file), DAMAGE);
  });
  await site.rebuildManagedFiles();
  const notRewritten = managed.filter(
    (file) => fs.readFileSync(path.join(siteDir, file), "utf8") === DAMAGE,
  );
  assert.deepEqual(
    notRewritten,
    [],
    "managed in the contract but left alone by rebuildManagedFiles()",
  );
  // and the rebuild gives back what site creation wrote (security.txt
  // carries an expiry date that a rebuild may refresh)
  managed
    .filter((file) => file !== ".well-known/security.txt")
    .forEach((file) => {
      assert.equal(
        fs.readFileSync(path.join(siteDir, file), "utf8"),
        before[file],
        file + " differs after a rebuild",
      );
    });

  // partly managed files: the owner's part survives, HAXcms's part returns
  const robots = path.join(siteDir, "robots.txt");
  fs.appendFileSync(robots, "\nUser-agent: contract-test\nDisallow: /x\n");
  await site.rebuildManagedFiles();
  const robotsText = fs.readFileSync(robots, "utf8");
  assert.ok(robotsText.indexOf("User-agent: contract-test") !== -1);
  assert.ok(robotsText.indexOf("# BEGIN HAXcms managed") !== -1);
});
