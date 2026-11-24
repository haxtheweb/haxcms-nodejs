"use strict";

// src/lib/unicode-tables.json fixes the Unicode data the slug and search
// rules use, so haxcms-nodejs and haxcms-php agree whatever Unicode version
// their runtime ships (haxtheweb/issues#3394). haxcms-php ships an identical
// copy as lib/unicode-tables.json and pins the same checksum.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const unicodeTables = require("../../src/lib/unicodeTables.js");
const { generateSlugRule } = require("../../src/lib/slugRules.js");

const TABLES_PATH = path.join(__dirname, "../../src/lib/unicode-tables.json");
// update together with haxcms-php tests/Unit/UnicodeTablesTest.php
const TABLES_SHA256 =
  "6a772bd8bcd9658b987585a2934ccc4c92edccfa12280ba1147a78b13a4f5719";

function everyCodePoint() {
  let all = "";
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp < 0xd800 || cp > 0xdfff) {
      all += String.fromCodePoint(cp) + " ";
    }
  }
  return all;
}

test("the tables are the copy haxcms-php ships", () => {
  const sha = crypto
    .createHash("sha256")
    .update(fs.readFileSync(TABLES_PATH))
    .digest("hex");
  assert.equal(sha, TABLES_SHA256);
});

test("a letter newer than PCRE2 10.42 knows is still a letter", () => {
  // U+1DF25 (Unicode 14) was a letter in Node.js and a separator in PHP
  assert.equal(
    generateSlugRule("New \u{1DF25} letter"),
    "new-\u{1DF25}-letter",
  );
  assert.equal(unicodeTables.lowerCase("\u{10D50}"), "\u{10D70}");
});

test("lowerCase keeps toLowerCase's final sigma rule", () => {
  assert.equal(unicodeTables.lowerCase("ΟΔΟΣ"), "οδος");
  assert.equal(unicodeTables.lowerCase("ΣΑ"), "σα");
  assert.equal(unicodeTables.lowerCase("Σ"), "σ");
  assert.equal(unicodeTables.lowerCase("ΑΣ́ b"), "ας́ b");
});

test(
  "the tables match this runtime when it has the same Unicode version",
  { skip: process.versions.unicode !== unicodeTables.unicodeVersion },
  () => {
    const all = everyCodePoint();
    assert.equal(unicodeTables.lowerCase(all), all.toLowerCase());
    assert.equal(
      all.replace(unicodeTables.notLetterOrNumberRun(), "|"),
      all.replace(/[^\p{L}\p{N}]+/gu, "|"),
    );
    assert.equal(
      all.replace(new RegExp(unicodeTables.searchKeepShort.source, "gu"), ""),
      all.replace(
        /[\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/gu,
        "",
      ),
    );
  },
);
