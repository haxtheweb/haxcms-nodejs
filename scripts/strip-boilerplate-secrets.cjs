#!/usr/bin/env node
/* global process, console, __dirname */
/**
 * Security (SEC-INSTALL, SEC-DEPLOY): runs after `babel --copy-files
 * --include-dotfiles` copies src/ into dist/. When haxcms-nodejs falls back to
 * src/boilerplate/systemsetup for its config (no writable ~/.haxcmsconfig), it
 * writes its runtime secrets there: JWT keys, salt, the hashed admin record and
 * the seeded password. Git ignores them, but the copy would put them in dist/
 * and `npm publish` ships dist/. Delete them from the build so a release can
 * never include them. Every install generates its own on first run.
 *
 * Usage: node scripts/strip-boilerplate-secrets.cjs [distDir]
 */
const fs = require("fs");
const path = require("path");

const SECRET_NAMES = [
  ".pk",
  ".rpk",
  "SALT.txt",
  ".user",
  ".initial-admin-password",
];

function stripBoilerplateSecrets(distDir) {
  const dir = path.join(distDir, "boilerplate", "systemsetup");
  const removed = [];
  for (const name of SECRET_NAMES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed.push(path.relative(process.cwd(), file));
    }
  }
  return removed;
}

module.exports = { stripBoilerplateSecrets, SECRET_NAMES };

if (require.main === module) {
  const distDir = path.resolve(
    process.argv[2] || path.join(__dirname, "..", "dist"),
  );
  const removed = stripBoilerplateSecrets(distDir);
  if (removed.length > 0) {
    console.log(
      "strip-boilerplate-secrets: removed local runtime secrets from the build: " +
        removed.join(", "),
    );
  }
}
