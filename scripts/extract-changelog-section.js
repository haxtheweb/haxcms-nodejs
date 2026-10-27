"use strict";
/**
 * Print the CHANGELOG.md section for a release tag (heading line excluded).
 * Usage: node scripts/extract-changelog-section.js <tag> [changelog-path]
 * The tag may carry a leading "v" (v26.8.1 and 26.8.1 are equivalent).
 * Exit code 0 with the section on stdout, or 1 with nothing on stdout when the
 * section is missing or has no entries (headings like "### Bug Fixes" with no
 * bullets are not entries).
 */
const fs = require("fs");
const path = require("path");

function extractSection(changelog, tag) {
  const version = String(tag).replace(/^v/, "");
  const lines = changelog.split(/\r?\n/);
  const isHeading = (line) => /^## /.test(line);
  const start = lines.findIndex(
    (line) =>
      isHeading(line) &&
      line.replace(/^## \[?/, "").startsWith(version) &&
      /^[\]\s(]|^$/.test(line.replace(/^## \[?/, "").slice(version.length)),
  );
  if (start === -1) return "";
  let end = lines.findIndex((line, i) => i > start && isHeading(line));
  if (end === -1) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return /^\s*[*-] /m.test(body) ? body : "";
}

module.exports = { extractSection };

if (require.main === module) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("usage: extract-changelog-section.js <tag> [changelog-path]");
    process.exit(2);
  }
  const file = process.argv[3] || path.join(__dirname, "..", "CHANGELOG.md");
  const section = extractSection(fs.readFileSync(file, "utf8"), tag);
  if (!section) process.exit(1);
  process.stdout.write(section + "\n");
}
