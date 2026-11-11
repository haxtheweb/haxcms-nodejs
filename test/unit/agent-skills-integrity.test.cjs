"use strict";

// Every .well-known/agent-skills/ copy in this repo must be internally
// consistent: each skill its index.json lists exists, and each file's bytes
// match the sha256 digest the index declares for it. Agents that follow the
// agentskills.io discovery spec check those digests, so a copy that a
// formatter or a hand edit touched is a copy they refuse. Refresh copies only
// with praw's scripts/snapshot-agent-skills.js; drift from PRAW itself is
// reported by scripts/agent-skills-drift.js (weekly workflow), not here.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "..");
const COPIES = [
  ".well-known/agent-skills",
  "src/boilerplate/site/.well-known/agent-skills",
];
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

function sha(file) {
  return (
    "sha256:" +
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  );
}

for (const rel of COPIES) {
  const dir = path.join(ROOT, rel);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));

  test(`${rel}: index follows the discovery spec`, () => {
    assert.match(idx.$schema, /agentskills\.io\/discovery\//);
    assert.ok(Array.isArray(idx.skills) && idx.skills.length > 0);
    for (const s of idx.skills) {
      assert.match(s.name, NAME_RE, `bad skill name ${s.name}`);
      assert.equal(s.type, "skill-md");
      assert.equal(s.url, `${s.name}/SKILL.md`);
      assert.ok(s.description && s.description.length <= 1024);
    }
  });

  test(`${rel}: every SKILL.md matches its digest`, () => {
    const bad = [];
    for (const s of idx.skills) {
      const file = path.join(dir, s.url);
      if (!fs.existsSync(file)) {
        bad.push(`${s.url} (missing)`);
      } else if (sha(file) !== s.digest) {
        bad.push(s.url);
      }
      for (const f of s.files || []) {
        const p = path.join(dir, s.name, f.path);
        if (!fs.existsSync(p) || sha(p) !== f.digest) {
          bad.push(`${s.name}/${f.path}`);
        }
      }
    }
    assert.deepEqual(
      bad,
      [],
      "changed since the snapshot; refresh with praw's snapshot-agent-skills.js",
    );
  });

  test(`${rel}: no skill folder the index does not list`, () => {
    const listed = new Set(idx.skills.map((s) => s.name));
    const extra = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !listed.has(d.name))
      .map((d) => d.name);
    assert.deepEqual(extra, []);
  });
}
