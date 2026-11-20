// The text the overview report scores for readability, from page HTML.
// haxcms-php does the same steps in ReadabilityScore::textFromHTML, and both
// backends are tested against test/fixtures/readability-parity.json, so a
// site gets the same readability numbers on either backend.
const he = require("he");

// JavaScript's \s, spelled out so PHP can use the same set of spaces
const WHITESPACE =
  /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;

/**
 * Decode character references the same way in both backends: named ones
 * from the HTML5 table (he and PHP's ENT_HTML5 table agree), numeric ones
 * to their code point unless it is NUL, a surrogate half or past the
 * Unicode range, which stay as written. One pass, so `&amp;lt;` decodes to
 * the text `&lt;` and no further.
 */
function decodeEntities(text) {
  return text.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (match, entity) => {
      if (entity.charAt(0) !== "#") {
        return he.decode(match);
      }
      const hex = entity.charAt(1) === "x" || entity.charAt(1) === "X";
      const codePoint = hex
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      if (
        !(codePoint > 0 && codePoint <= 0x10ffff) ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

// elements whose content is never prose
const RAW_TEXT_ELEMENTS = ["script", "style", "template"];

// ASCII-only lower case: keeps every index where it was, so positions found
// in the lowered copy are positions in the original (PHP strtolower agrees)
function lowerAscii(text) {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Markup to text, scanning forward only (indexOf), so the time it takes
 * grows with the page size whatever the page holds. Every tag, comment and
 * script / style / template block becomes one space. A comment, block or tag
 * that is never closed runs to the end of the page, as a browser reads it.
 */
function stripMarkup(html) {
  const lower = lowerAscii(html);
  const length = html.length;
  let out = "";
  let i = 0;
  while (i < length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt) + " ";
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? length : close + 3;
      continue;
    }
    let rawText = "";
    for (let r = 0; r < RAW_TEXT_ELEMENTS.length; r++) {
      const name = RAW_TEXT_ELEMENTS[r];
      const after = lower.charAt(lt + 1 + name.length);
      if (lower.startsWith(name, lt + 1) && !/^[a-z0-9_]$/.test(after)) {
        rawText = name;
        break;
      }
    }
    if (rawText !== "") {
      const close = lower.indexOf("</" + rawText, lt + 1 + rawText.length);
      const gt = close === -1 ? -1 : html.indexOf(">", close);
      i = gt === -1 ? length : gt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    i = gt === -1 ? length : gt + 1;
  }
  return out;
}

/**
 * Page HTML (one string per page, in outline order) to the text that is
 * scored: markup is dropped (stripMarkup), entities are decoded, pages are
 * joined with a space and runs of white space become one space.
 */
function readabilityTextFromHTML(pages) {
  const parts = [];
  const list = Array.isArray(pages) ? pages : [];
  for (let i = 0; i < list.length; i++) {
    const html = list[i] === null || list[i] === undefined ? "" : list[i];
    parts.push(decodeEntities(stripMarkup(String(html))));
  }
  let text = parts.join(" ").replace(WHITESPACE, " ");
  // white space is collapsed, so at most one space at each end
  if (text.charAt(0) === " ") {
    text = text.slice(1);
  }
  if (text.charAt(text.length - 1) === " ") {
    text = text.slice(0, -1);
  }
  return text;
}

module.exports = {
  decodeEntities,
  readabilityTextFromHTML,
};
