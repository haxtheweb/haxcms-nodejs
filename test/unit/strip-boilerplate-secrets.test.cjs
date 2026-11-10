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
