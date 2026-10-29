"use strict";

// haxtheweb/issues#3186: managed-file policies (replace / block / json-merge),
// write-if-changed support and security.txt expiry reuse.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const path = require("path");

const {
  MANAGED_BLOCK_MARKERS,
  getManagedFilePolicy,
  isKnownLegacyAgentsMd,
  findManagedBlock,
  mergeManagedBlock,
  mergeManagedJson,
  applyManagedPolicy,
  getSecurityTxtExpires,
} = require("../../src/lib/managedFiles.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BOILERPLATE = path.join(REPO_ROOT, "src", "boilerplate", "site");
const LEGACY_AGENTS = fs.readFileSync(
  path.join(
    REPO_ROOT,
    "test",
    "fixtures",
    "managed-files",
    "agents-md-legacy.txt",
  ),
  "utf8",
);

const HASH = MANAGED_BLOCK_MARKERS.hash;
const HTML = MANAGED_BLOCK_MARKERS.html;

function hashFile(body) {
  return HASH.start + "\n" + body + "\n" + HASH.end + "\n";
}

test("policies: AGENTS.md, .htaccess and robots.txt are blocks, package.json merges, the rest replace", () => {
  assert.equal(getManagedFilePolicy("agents").policy, "block");
  assert.equal(getManagedFilePolicy("agents").render, false);
  assert.equal(getManagedFilePolicy("htaccess").policy, "block");
  assert.equal(getManagedFilePolicy("robots").policy, "block");
  assert.equal(getManagedFilePolicy("package").policy, "json-merge");
  assert.deepEqual(getManagedFilePolicy("sw"), {
    policy: "replace",
    render: true,
  });
  // files/.htaccess is execution hardening and stays fully managed
  assert.equal(getManagedFilePolicy("fileshtaccess").policy, "replace");
});

test("markers are version-neutral and present in the boilerplate", () => {
  [HASH.start, HASH.end, HTML.start, HTML.end].forEach((marker) => {
    assert.equal(/\d+\.\d+/.test(marker), false, marker);
  });
  ["AGENTS.md", ".htaccess", "robots.txt"].forEach((file) => {
    const text = fs.readFileSync(path.join(BOILERPLATE, file), "utf8");
    const markers = file === "AGENTS.md" ? "html" : "hash";
    assert.ok(findManagedBlock(text, markers), file + " has a managed block");
  });
});

test("findManagedBlock needs both markers in order", () => {
  assert.equal(findManagedBlock("no markers", "hash"), null);
  assert.equal(findManagedBlock(HASH.start + "\nopen only", "hash"), null);
  assert.equal(findManagedBlock(HASH.end + "\n" + HASH.start, "hash"), null);
  const text = "before\n" + hashFile("x") + "after";
  const block = findManagedBlock(text, "hash");
  assert.equal(
    text.slice(block.start, block.end),
    HASH.start + "\nx\n" + HASH.end,
  );
});

test("block merge replaces only the managed span and keeps owner content", () => {
  const existing = "# owner top\n" + hashFile("old rules") + "# owner bottom\n";
  const rendered = hashFile("new rules");
  const merged = mergeManagedBlock(existing, rendered, "hash", "whole");
  assert.equal(
    merged,
    "# owner top\n" + hashFile("new rules") + "# owner bottom\n",
  );
  // idempotent
  assert.equal(mergeManagedBlock(merged, rendered, "hash", "whole"), merged);
});

test("block merge: a missing file gets the full baseline", () => {
  const rendered = hashFile("rules") + "# trailer\n";
  assert.equal(mergeManagedBlock(null, rendered, "hash", "whole"), rendered);
});

test("block merge: an unmarked always-managed file is replaced (it never held owner content)", () => {
  const rendered = hashFile("rules");
  assert.equal(
    mergeManagedBlock("old fully managed copy", rendered, "hash", "whole"),
    rendered,
  );
});

test("block merge: an unmarked released AGENTS.md is replaced, CRLF or not", () => {
  const rendered =
    HTML.start + "\nnew guide\n" + HTML.end + "\n\n## Site-specific notes\n";
  assert.equal(isKnownLegacyAgentsMd(LEGACY_AGENTS), true);
  assert.equal(
    mergeManagedBlock(LEGACY_AGENTS, rendered, "html", "hashes"),
    rendered,
  );
  assert.equal(
    mergeManagedBlock(
      LEGACY_AGENTS.replace(/\n/g, "\r\n"),
      rendered,
      "html",
      "hashes",
    ),
    rendered,
  );
});

test("block merge: an unmarked edited AGENTS.md keeps all owner content below the block", () => {
  const edited =
    LEGACY_AGENTS + "\nOur house rules: never touch pages/legal.\n";
  assert.equal(isKnownLegacyAgentsMd(edited), false);
  const rendered =
    HTML.start + "\nnew guide\n" + HTML.end + "\n\n## Site-specific notes\n";
  const merged = mergeManagedBlock(edited, rendered, "html", "hashes");
  assert.ok(merged.indexOf(HTML.start + "\nnew guide\n" + HTML.end) === 0);
  assert.ok(merged.endsWith(edited), "owner file kept verbatim");
  // second rebuild updates the block in place and never duplicates it
  const again = mergeManagedBlock(merged, rendered, "html", "hashes");
  assert.equal(again, merged);
  assert.equal(again.split(HTML.start).length - 1, 1);
});

test("block merge: a boilerplate without markers falls back to replace", () => {
  assert.equal(
    mergeManagedBlock("anything", "plain", "hash", "whole"),
    "plain",
  );
});

test("json merge: nothing extra returns the rendered text verbatim", () => {
  const rendered = '{\n  "name": "site",\n  "scripts": { "build": "x" }\n}\n';
  const existing = '{"name":"old","scripts":{"build":"old"}}';
  assert.equal(mergeManagedJson(existing, rendered), rendered);
  assert.equal(mergeManagedJson(null, rendered), rendered);
  assert.equal(mergeManagedJson("not json", rendered), rendered);
});

test("json merge: HAXcms keys win, owner keys and extra scripts are kept", () => {
  const rendered = JSON.stringify({
    name: "site",
    version: "0.0.0",
    scripts: { build: "hax build" },
    dependencies: { lit: "^3" },
  });
  const existing = JSON.stringify({
    name: "old",
    scripts: { build: "old build", lint: "eslint ." },
    dependencies: { lit: "^2", dayjs: "^1" },
    private: true,
  });
  const merged = JSON.parse(mergeManagedJson(existing, rendered));
  assert.equal(merged.name, "site");
  assert.equal(merged.version, "0.0.0");
  assert.deepEqual(merged.scripts, { build: "hax build", lint: "eslint ." });
  assert.deepEqual(merged.dependencies, { lit: "^3", dayjs: "^1" });
  assert.equal(merged.private, true);
});

test("applyManagedPolicy dispatches by key", () => {
  assert.equal(applyManagedPolicy("sw", "old", "new"), "new");
  assert.equal(
    applyManagedPolicy("robots", "x\n" + hashFile("a"), hashFile("b")),
    "x\n" + hashFile("b"),
  );
});

test("security.txt Expires is reused while far from expiry", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const far = "Contact: x\nExpires: 2027-04-01T00:00:00.000Z\n";
  assert.equal(getSecurityTxtExpires(far, now), "2027-04-01T00:00:00.000Z");
});

test("security.txt Expires refreshes near expiry at day precision", () => {
  const now = new Date("2026-10-28T12:34:56Z");
  const near = "Expires: 2026-12-01T00:00:00.000Z\n";
  assert.equal(getSecurityTxtExpires(near, now), "2027-04-26T00:00:00.000Z");
  assert.equal(getSecurityTxtExpires(null, now), "2027-04-26T00:00:00.000Z");
  assert.equal(
    getSecurityTxtExpires("Expires: garbage\n", now),
    "2027-04-26T00:00:00.000Z",
  );
});

// shared with haxcms-php (tests/Unit/fixtures/managed-files-golden.json):
// both backends must produce exactly these outputs
const GOLDEN = require("../fixtures/managed-files/golden.json");

test("golden: block merges match the cross-backend fixture", () => {
  GOLDEN.block.forEach((c) => {
    assert.equal(
      mergeManagedBlock(c.existing, c.rendered, c.markers, c.legacy),
      c.expected,
      c.name,
    );
  });
});

test("golden: package.json merges match the cross-backend fixture", () => {
  GOLDEN.json.forEach((c) => {
    assert.equal(mergeManagedJson(c.existing, c.rendered), c.expected, c.name);
  });
});

test("golden: security.txt Expires matches the cross-backend fixture", () => {
  GOLDEN.securityTxt.forEach((c) => {
    assert.equal(
      getSecurityTxtExpires(c.existing, new Date(c.now)),
      c.expected,
      c.name,
    );
  });
});
