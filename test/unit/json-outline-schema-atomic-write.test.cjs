"use strict";

// JSONOutlineSchema.save() replaces site.json atomically
// (JSONOutlineSchema.writeFileAtomic, haxtheweb/issues#3287): readers see
// the previous file or the complete new one, and a failed write leaves the
// previous file and no temp file. The saveOutline / route-level scenarios
// are fault-injection-*.test.cjs (FI-OUT-03 and the site.json ENOSPC ones).
//
// CommonJS, no optional chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const JSONOutlineSchema = require("../../src/lib/JSONOutlineSchema.js");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jos-atomic-"));
  t.after(() => fs.removeSync(dir));
  return dir;
}

function schemaFor(file, title) {
  const schema = new JSONOutlineSchema();
  schema.file = file;
  schema.title = title;
  schema.metadata = { site: { name: "atomic" } };
  return schema;
}

function tempFiles(dir) {
  return fs.readdirSync(dir).filter((name) => /\.tmp$/.test(name));
}

test("save writes the whole file and leaves no temp file", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "site.json");
  await schemaFor(file, "First").save();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).title, "First");
  await schemaFor(file, "Second").save();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).title, "Second");
  assert.deepEqual(tempFiles(dir), []);
});

test("save keeps the permissions site.json had", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions");
    return;
  }
  const dir = tempDir(t);
  const file = path.join(dir, "site.json");
  fs.writeFileSync(file, "{}");
  fs.chmodSync(file, 0o640);
  await schemaFor(file, "Kept").save();
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test("a symlinked site.json is written through to the file it points at", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlinks need privileges on Windows");
    return;
  }
  const dir = tempDir(t);
  const real = path.join(dir, "real.json");
  const link = path.join(dir, "site.json");
  fs.writeFileSync(real, "{}");
  fs.symlinkSync(real, link);
  await schemaFor(link, "Through").save();
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "the link stays a link");
  assert.equal(JSON.parse(fs.readFileSync(real, "utf8")).title, "Through");
  assert.deepEqual(tempFiles(dir), []);
});

test("a failed rename throws, keeps the previous file and removes the temp file", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "site.json");
  await schemaFor(file, "Before").save();
  const before = fs.readFileSync(file, "utf8");
  t.mock.method(fs, "renameSync", () => {
    const error = new Error("EXDEV: injected");
    error.code = "EXDEV";
    throw error;
  });
  await assert.rejects(schemaFor(file, "After").save(), { code: "EXDEV" });
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(tempFiles(dir), []);
});

test("an fsync failure throws and keeps the previous file; an fsync the filesystem cannot do is skipped", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "site.json");
  await schemaFor(file, "Before").save();
  const before = fs.readFileSync(file, "utf8");
  let code = "EIO";
  t.mock.method(fs, "fsyncSync", () => {
    const error = new Error(code + ": injected");
    error.code = code;
    throw error;
  });
  await assert.rejects(schemaFor(file, "After").save(), { code: "EIO" });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(tempFiles(dir), []);
  code = "ENOTSUP";
  await schemaFor(file, "Unsupported fsync").save();
  t.mock.restoreAll();
  assert.equal(
    JSON.parse(fs.readFileSync(file, "utf8")).title,
    "Unsupported fsync",
  );
});

test("a site.json that does not parse is not loaded as an empty outline", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "site.json");
  for (const bytes of ['{"title": "cut sh', "", "null", "[1, 2]"]) {
    fs.writeFileSync(file, bytes);
    await assert.rejects(new JSONOutlineSchema().load(file));
    assert.equal(fs.readFileSync(file, "utf8"), bytes, "left as it was");
  }
});
