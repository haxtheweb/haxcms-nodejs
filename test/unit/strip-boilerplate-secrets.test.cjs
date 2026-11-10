const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  stripBoilerplateSecrets,
  SECRET_NAMES,
} = require("../../scripts/strip-boilerplate-secrets.cjs");

// Security (SEC-INSTALL, SEC-DEPLOY): a local run's runtime secrets must never
// reach the published dist/ (and through the release mirror, haxcms-php).
test("removes every runtime secret from dist boilerplate and keeps the real boilerplate", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "strip-secrets-"));
  const dir = path.join(dist, "boilerplate", "systemsetup");
  fs.mkdirSync(dir, { recursive: true });
  const keep = [
    "config.json",
    "config.php",
    ".htaccess",
    ".published-htaccess",
  ];
  for (const name of SECRET_NAMES.concat(keep)) {
    fs.writeFileSync(path.join(dir, name), "x");
  }
  const removed = stripBoilerplateSecrets(dist);
  assert.equal(removed.length, SECRET_NAMES.length);
  for (const name of SECRET_NAMES) {
    assert.ok(!fs.existsSync(path.join(dir, name)), name + " should be gone");
  }
  for (const name of keep) {
    assert.ok(fs.existsSync(path.join(dir, name)), name + " should stay");
  }
  fs.rmSync(dist, { recursive: true, force: true });
});

test("is a no-op on a clean build", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "strip-secrets-"));
  assert.deepEqual(stripBoilerplateSecrets(dist), []);
  fs.rmSync(dist, { recursive: true, force: true });
});

test("the build script runs the strip step", () => {
  const pkg = require("../../package.json");
  assert.match(pkg.scripts.build, /strip-boilerplate-secrets\.cjs dist/);
});

test("git ignores the runtime secrets in src/boilerplate/systemsetup", () => {
  const ignore = fs.readFileSync(
    path.join(__dirname, "../../.gitignore"),
    "utf8",
  );
  for (const name of SECRET_NAMES) {
    assert.ok(
      ignore.includes("src/boilerplate/systemsetup/" + name),
      name + " must stay git-ignored",
    );
  }
});

// A local run that writes to a non-string path leaves files named "false",
// "undefined" and so on in src/boilerplate; babel --copy-files would ship them
// (26.8.1 put boilerplate/site/false into every new site).
const {
  stripBoilerplateStrays,
  STRAY_NAMES,
} = require("../../scripts/strip-boilerplate-secrets.cjs");

test("removes files named after a JS value anywhere in dist boilerplate", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "strip-strays-"));
  const site = path.join(dist, "boilerplate", "site");
  const nested = path.join(site, "assets");
  fs.mkdirSync(nested, { recursive: true });
  const keep = [
    path.join(site, "index.html"),
    path.join(site, "falsey-but-real.txt"),
    path.join(nested, "true.svg"),
  ];
  for (const file of keep) {
    fs.writeFileSync(file, "x");
  }
  // every stray name as a file, except "null", which is a directory here
  for (const name of STRAY_NAMES) {
    if (name !== "null") {
      fs.writeFileSync(path.join(site, name), "");
    }
  }
  fs.writeFileSync(path.join(nested, "undefined"), "");
  fs.mkdirSync(path.join(site, "null"));
  fs.writeFileSync(path.join(site, "null", "inside.txt"), "");

  const removed = stripBoilerplateStrays(dist);
  // every stray at the top level (null is a directory) plus the nested one
  assert.equal(removed.length, STRAY_NAMES.length + 1);
  for (const name of STRAY_NAMES) {
    assert.ok(!fs.existsSync(path.join(site, name)), name + " should be gone");
  }
  assert.ok(!fs.existsSync(path.join(nested, "undefined")));
  for (const file of keep) {
    assert.ok(fs.existsSync(file), path.basename(file) + " should stay");
  }
  fs.rmSync(dist, { recursive: true, force: true });
});

test("stray cleanup is a no-op on a clean build or with no boilerplate", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "strip-strays-"));
  assert.deepEqual(stripBoilerplateStrays(dist), []);
  fs.mkdirSync(path.join(dist, "boilerplate", "site"), { recursive: true });
  fs.writeFileSync(path.join(dist, "boilerplate", "site", "index.html"), "x");
  assert.deepEqual(stripBoilerplateStrays(dist), []);
  fs.rmSync(dist, { recursive: true, force: true });
});

test("the real boilerplate source has no stray files", () => {
  const src = path.join(__dirname, "..", "..", "src");
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (STRAY_NAMES.includes(entry.name)) {
        found.push(path.relative(src, full));
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(path.join(src, "boilerplate"));
  assert.deepEqual(found, []);
});
