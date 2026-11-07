"use strict";

// Security regression guards for the supply-chain / deployment posture:
// - image-size stays at >= 2.0.4 everywhere in yarn.lock (<= 2.0.2 had a
//   DoS advisory) and the resolutions/overrides pin it
// - axios is test tooling only (no runtime dependency, no src/ import)
// - the Dockerfile runtime stage installs production deps only, from the
//   frozen lockfile, without lifecycle scripts, keeps the digest pin and
//   runs as the node user
// - the CI dependency audit is a blocking step
//
// Constraints honored: CommonJS (.cjs), require(), no optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

function walkJs(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "public" || entry.name === "vendor") {
        continue;
      }
      walkJs(full, out);
    } else if (/\.(c|m)?js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("image-size resolves to >= 2.0.4 only and is pinned", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.resolutions["image-size"], "^2.0.4");
  assert.equal(pkg.overrides["image-size"], "^2.0.4");
  const lock = read("yarn.lock");
  const versions = [];
  const pattern = /^"?image-size@[^\n]*:\n  version "([^"]+)"/gm;
  let match = pattern.exec(lock);
  while (match) {
    versions.push(match[1]);
    match = pattern.exec(lock);
  }
  assert.ok(versions.length > 0, "image-size is in yarn.lock");
  for (let i = 0; i < versions.length; i++) {
    const parts = versions[i].split(".").map((n) => parseInt(n, 10));
    const ok =
      parts[0] > 2 ||
      (parts[0] === 2 && (parts[1] > 0 || (parts[1] === 0 && parts[2] >= 4)));
    assert.ok(ok, "image-size " + versions[i] + " is below 2.0.4");
  }
});

test("axios is a devDependency only and nothing in src/ imports it", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(pkg.dependencies, "axios"),
    false,
  );
  assert.ok(pkg.devDependencies.axios, "tests still depend on axios");
  const files = walkJs(path.join(REPO_ROOT, "src"), []);
  for (let i = 0; i < files.length; i++) {
    const source = fs.readFileSync(files[i], "utf8");
    assert.equal(
      /require\(\s*['"]axios['"]\s*\)|from\s+['"]axios['"]/.test(source),
      false,
      path.relative(REPO_ROOT, files[i]) + " imports axios",
    );
  }
});

test("Dockerfile runtime stage is production-only, frozen, script-free, digest-pinned, non-root", () => {
  const dockerfile = read("Dockerfile");
  const fromLines = dockerfile
    .split("\n")
    .filter((line) => /^FROM\s/.test(line));
  assert.equal(fromLines.length, 2, "multi-stage build (build + runtime)");
  for (let i = 0; i < fromLines.length; i++) {
    assert.match(fromLines[i], /@sha256:[0-9a-f]{64}/, fromLines[i]);
  }
  const runtime = dockerfile.substring(dockerfile.lastIndexOf("\nFROM "));
  assert.match(
    runtime,
    /yarn install --production --frozen-lockfile --ignore-scripts/,
  );
  assert.ok(runtime.indexOf("USER node") !== -1);
  assert.ok(runtime.indexOf("COPY --from=build") !== -1);
  assert.equal(
    runtime.indexOf("yarn run build"),
    -1,
    "the runtime stage must not carry the build toolchain",
  );
  // CMD/USER order: the process runs as node
  assert.ok(runtime.lastIndexOf("USER node") < runtime.lastIndexOf("CMD ["));
});

test("CI dependency audit is blocking on high/critical runtime advisories", () => {
  const workflow = read(".github/workflows/build.yml");
  assert.ok(
    workflow.indexOf("yarn audit --groups dependencies --level high") !== -1,
  );
  assert.ok(workflow.indexOf("status=$(( raw & 24 ))") !== -1);
  assert.ok(
    /if \[ "\$status" -ne 0 \]; then[\s\S]*?exit 1/.test(workflow),
    "a high/critical finding exits 1",
  );
  assert.equal(workflow.indexOf("Dependency audit (reporting only)"), -1);
});
