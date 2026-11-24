// Fixed Unicode data for the slug and search rules (haxtheweb/issues#3394).
// \p{L}, \p{N}, script classes and toLowerCase follow whatever Unicode
// version the runtime ships, so Node.js and PHP (PCRE2) disagreed on newer
// letters. Both backends now read the same unicode-tables.json (haxcms-php
// keeps an identical copy as lib/unicode-tables.json), so a slug or search
// word never depends on the runtime. Regenerate with
// scripts/generate-unicode-tables.cjs.
const TABLES = require("./unicode-tables.json");

function hex(cp) {
  return cp.toString(16).toUpperCase();
}

// "[...]" body for a list of [start, end] code point ranges
function classBody(ranges) {
  return ranges
    .map(([start, end]) =>
      start === end
        ? `\\u{${hex(start)}}`
        : `\\u{${hex(start)}}-\\u{${hex(end)}}`,
    )
    .join("");
}

const LETTER_OR_NUMBER = classBody(TABLES.letterOrNumber);
const SEARCH_KEEP_SHORT = classBody(TABLES.searchKeepShort);
const LOWER = new Map(
  Object.keys(TABLES.lower).map((cp) => [Number(cp), TABLES.lower[cp]]),
);
const CAPITAL_SIGMA = 0x3a3;

function inRanges(ranges, cp) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cp < ranges[mid][0]) {
      high = mid - 1;
    } else if (cp > ranges[mid][1]) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

// Unicode Final_Sigma: a cased letter comes before (case-ignorable
// characters skipped) and none comes after
function isFinalSigma(cps, index) {
  let i = index - 1;
  while (i >= 0 && inRanges(TABLES.caseIgnorable, cps[i])) {
    i--;
  }
  if (i < 0 || !inRanges(TABLES.cased, cps[i])) {
    return false;
  }
  i = index + 1;
  while (i < cps.length && inRanges(TABLES.caseIgnorable, cps[i])) {
    i++;
  }
  return i >= cps.length || !inRanges(TABLES.cased, cps[i]);
}

/**
 * Lower case from the fixed table, the way String#toLowerCase does it
 * (no locale; a capital sigma ending a word becomes ς), so both backends
 * give the same string whatever Unicode version their runtime has.
 */
function lowerCase(value) {
  const cps = Array.from(String(value), (ch) => ch.codePointAt(0));
  let out = "";
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp === CAPITAL_SIGMA && isFinalSigma(cps, i)) {
      out += "\u03C2";
      continue;
    }
    const mapped = LOWER.get(cp);
    out += mapped === undefined ? String.fromCodePoint(cp) : mapped;
  }
  return out;
}

module.exports = {
  unicodeVersion: TABLES.unicode,
  // a run of characters that are not letters or numbers, plus the extra
  // characters given (already escaped for a character class)
  notLetterOrNumberRun(extra = "") {
    return new RegExp(`[^${LETTER_OR_NUMBER}${extra}]+`, "gu");
  },
  // one character that keeps a short search word
  searchKeepShort: new RegExp(`[${SEARCH_KEEP_SHORT}]`, "u"),
  lowerCase,
};
