"use strict";

// Linear-time replacements for regexes flagged by CodeQL as polynomial /
// exponential ReDoS (js/polynomial-redos, js/redos). Each helper documents the
// regex it replaces and returns identical output for it; test/unit/redos-
// regexes.test.cjs keeps the original regexes and diffs against these.

/** Replaces /\/+$/ : remove every trailing "/". */
function trimTrailingSlashes(value) {
  const s = String(value);
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) {
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

/** Replaces /^\/+/ : remove every leading "/". */
function trimLeadingSlashes(value) {
  const s = String(value);
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === 47) {
    start++;
  }
  return start === 0 ? s : s.slice(start);
}

/** Replaces /^\/+|\/+$/g : trim "/" from both ends. */
function trimSlashes(value) {
  return trimLeadingSlashes(trimTrailingSlashes(value));
}

/**
 * Replaces s.replace(/<([^>]+)>/g, replacement) (also the capturing form
 * /(<([^>]+)>)/gi). A "tag" is "<", one or more non-">" characters (which may
 * include "<"), then ">". Same matches as the regex but each "<" is examined
 * once instead of rescanning to the end of the string.
 */
function stripAngleTags(value, replacement = "") {
  const s = String(value);
  let out = "";
  let pos = 0;
  let i = s.indexOf("<");
  while (i !== -1) {
    const j = s.indexOf(">", i + 1);
    if (j === -1) {
      break; // no ">" left, so no later "<" can close either
    }
    if (j === i + 1) {
      // "<>" is not a tag (needs 1+ chars); try the next "<"
      i = s.indexOf("<", i + 1);
      continue;
    }
    out += s.slice(pos, i) + replacement;
    pos = j + 1;
    i = s.indexOf("<", pos);
  }
  return pos === 0 ? s : out + s.slice(pos);
}

/** Replaces /<[^>]+>/.test(s) : does the string contain a "tag"? */
function hasAngleTag(value) {
  const s = String(value);
  let i = s.indexOf("<");
  while (i !== -1) {
    const j = s.indexOf(">", i + 1);
    if (j === -1) {
      return false;
    }
    if (j > i + 1) {
      return true;
    }
    i = s.indexOf("<", i + 1);
  }
  return false;
}

/** Replaces s.replace(new RegExp('\\\\+"', 'g'), '"') : drop backslash runs before a quote. */
function removeBackslashesBeforeQuote(value) {
  const s = String(value);
  if (s.indexOf("\\") === -1) {
    return s;
  }
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 92) {
      let k = i;
      while (k < s.length && s.charCodeAt(k) === 92) {
        k++;
      }
      if (k < s.length && s.charCodeAt(k) === 34) {
        // run is followed by a quote: drop the run, keep the quote
        out += '"';
        i = k + 1;
      } else {
        out += s.slice(i, k);
        i = k;
      }
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

/**
 * Closing custom-element tag names found in HTML ("</my-el>" gives "my-el").
 * Replaces the old tag-scanning regex
 * /<(?:"[^"]*"['"]*|'[^']*'['"]*|[^'">])+>/g (exponential on quote runs) whose
 * results were only ever used as lookup keys in wc-registry.json, where only
 * the bare closing-tag form (no attributes, no whitespace) can resolve.
 * Returns unique names in first-seen order.
 */
function closingCustomElementNames(value) {
  const s = String(value);
  const re = /<\/([^<>"'\s-]*-[^<>"'\s]*)>/g;
  const seen = {};
  const names = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!seen[m[1]]) {
      seen[m[1]] = true;
      names.push(m[1]);
    }
  }
  return names;
}

const PAGE_BREAK_OPEN = "<page-break";
const PAGE_BREAK_CLOSE = "</page-break>";

/**
 * Replaces
 *   body.matchAll(/(<page-break([\s\S]*?)>([\s\S]*?)<\/page-break>)([\s\S]*?)(?=<page-break)/g)
 * Returns [{ attributes, content }] where attributes is capture group 2 (text
 * between "<page-break" and the first ">") and content is capture group 4
 * (text after "</page-break>" up to the next "<page-break"). Uses indexOf so
 * every character is scanned a bounded number of times.
 */
function findPageBreakSections(body) {
  const s = String(body);
  const sections = [];
  let pos = 0;
  while (true) {
    const start = s.indexOf(PAGE_BREAK_OPEN, pos);
    if (start === -1) {
      break;
    }
    const openEnd = s.indexOf(">", start + PAGE_BREAK_OPEN.length);
    if (openEnd === -1) {
      break;
    }
    const closeStart = s.indexOf(PAGE_BREAK_CLOSE, openEnd + 1);
    if (closeStart === -1) {
      break;
    }
    const closeEnd = closeStart + PAGE_BREAK_CLOSE.length;
    const next = s.indexOf(PAGE_BREAK_OPEN, closeEnd);
    if (next === -1) {
      break;
    }
    sections.push({
      attributes: s.slice(start + PAGE_BREAK_OPEN.length, openEnd),
      content: s.slice(closeEnd, next),
    });
    pos = next;
  }
  return sections;
}

// Replaces
//   /\s*(?:([a-z0-9-]+)\s*=\s*"([^"]*)")|(?:\s+([a-z0-9-]+)(?=\s*|>|\s+[a..z0-9]+))/gi
// (the lookahead was always true, and the leading \s* made runs of whitespace
// or of attribute-name characters quadratic). Lookbehinds restrict attempts to
// the start of a whitespace / name run, which is where the original always
// matched first, so the matches and captures are identical.
const ATTRIBUTE_PATTERN =
  /(?:(?<!\s)\s+|(?<![\sa-z0-9-]))([a-z0-9-]+)\s*=\s*"([^"]*)"|(?<!\s)\s+([a-z0-9-]+)/gi;

/** Returns regex matches (groups 1/2 = name/value, 3 = bare attribute name). */
function matchAttributes(attr) {
  return [...String(attr).matchAll(ATTRIBUTE_PATTERN)];
}

module.exports = {
  trimTrailingSlashes,
  trimLeadingSlashes,
  trimSlashes,
  stripAngleTags,
  hasAngleTag,
  removeBackslashesBeforeQuote,
  closingCustomElementNames,
  findPageBreakSections,
  matchAttributes,
};
