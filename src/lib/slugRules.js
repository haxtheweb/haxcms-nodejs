// Slug / clean-title character rules shared by HAXCMS.cleanTitle and
// HAXCMS.generateSlugName. Mirrors HAXCMS::cleanTitle / generateSlugName in
// haxcms-php so both backends write the same slug for the same input.

// anything that is not a Unicode letter, Unicode digit, underscore, hyphen
// or forward slash. Spelled out instead of \w: in JS \w is ASCII-only even
// with the u flag, and PCRE's \w under /u differs between PCRE2 versions.
const SLUG_DISALLOWED_RUN = /[^\p{L}\p{N}_/-]+/gu;
// whitespace PHP's trim() removes by default
const PHP_TRIM_CHARS = " \t\n\r\0\x0B";
// characters trimmed from both ends of a finished slug / clean title
const SLUG_EDGE_CHARS = "-./";

/**
 * PHP trim($value, $chars) for a set of single characters. A plain loop so
 * there is no regex backtracking on long runs of edge characters.
 */
function trimChars(value, chars) {
  let start = 0;
  let end = value.length;
  while (start < end && chars.indexOf(value[start]) !== -1) {
    start++;
  }
  while (end > start && chars.indexOf(value[end - 1]) !== -1) {
    end--;
  }
  return value.substring(start, end);
}

function isHexDigit(ch) {
  return /^[0-9a-fA-F]$/.test(ch);
}

/**
 * PHP urldecode(): "+" becomes a space and every valid %XX becomes that byte;
 * malformed escapes are kept as written (decodeURIComponent would throw).
 * The bytes are read back as UTF-8, invalid sequences become U+FFFD (PHP
 * runs mb_scrub, giving "?"); either way they are outside the allowed slug
 * characters and collapse into one "-".
 */
function phpUrlDecode(value) {
  const chunks = [];
  let literal = "";
  const flushLiteral = () => {
    if (literal !== "") {
      chunks.push(Buffer.from(literal, "utf8"));
      literal = "";
    }
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "+") {
      literal += " ";
    } else if (
      ch === "%" &&
      i + 2 < value.length &&
      isHexDigit(value[i + 1]) &&
      isHexDigit(value[i + 2])
    ) {
      flushLiteral();
      chunks.push(Buffer.from([parseInt(value.substring(i + 1, i + 3), 16)]));
      i += 2;
    } else {
      literal += ch;
    }
  }
  flushLiteral();
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Shared tail of both rules: disallowed runs become "-", repeated hyphens
 * collapse, Unicode-aware lowercase, "-./" trimmed from both ends, and an
 * empty result becomes "blank".
 */
function finishSlug(value, collapseSlashes) {
  let slug = value.replace(SLUG_DISALLOWED_RUN, "-");
  slug = slug.replace(/-{2,}/g, "-");
  if (collapseSlashes) {
    slug = slug.replace(/\/{2,}/g, "/");
  }
  slug = trimChars(slug.toLowerCase(), SLUG_EDGE_CHARS);
  if (slug === "") {
    slug = "blank";
  }
  return slug;
}

/**
 * Clean up a title for file system / slug usage (HAXCMS::cleanTitle).
 */
function cleanTitleRule(value, stripPage = true) {
  let cleanTitle = trimChars(
    value === undefined || value === null ? "" : String(value),
    PHP_TRIM_CHARS,
  );
  // strips off the identifiers for a page on the file system
  if (stripPage) {
    cleanTitle = cleanTitle.split("/index.html").join("");
    cleanTitle = cleanTitle.split("pages/").join("");
  }
  // Security (path traversal): "./" and "../" are removed and "." is outside
  // the allowed characters, so a clean title never holds a dot segment
  cleanTitle = cleanTitle.split("./").join("");
  cleanTitle = cleanTitle.split("../").join("");
  cleanTitle = cleanTitle.split(" ").join("-");
  return finishSlug(cleanTitle, false);
}

/**
 * URL slug for a page; forward slashes are kept for nested paths
 * (HAXCMS::generateSlugName).
 */
function generateSlugRule(name) {
  let n = name === undefined || name === null ? "" : String(name);
  // Security (null bytes): never part of a slug
  n = n.split("\0").join("");
  // decode so encoded traversal is caught by the rules below
  n = phpUrlDecode(n);
  // Security (path traversal): ".." runs (and the slashes after them),
  // "./" and backslashes are removed; "." is outside the allowed
  // characters, so no dot segment can survive
  n = n.replace(/\.{2,}\/*/g, "");
  n = n.split("\\").join("");
  n = n.split("./").join("");
  return finishSlug(n, true);
}

/**
 * Reserved front-end route: a page slug segment can never be "x" (the
 * /x/... API and system routes), so every "x" segment becomes "x-x".
 * Applied wherever a page slug is generated or set (getUniqueSlugName,
 * the pathauto cascade, setSlug, the page-break slug attribute,
 * saveOutline). Idempotent. Mirrors HAXCMSSite::reserveSlugRoutes in
 * haxcms-php.
 */
function reserveSlugRoutes(slug) {
  return String(slug)
    .split("/")
    .map((segment) => (segment === "x" ? "x-x" : segment))
    .join("/");
}

/**
 * A page slug is its non-empty "/" segments joined by "/": it never starts
 * or ends with "/" and never holds "//". Used by getUniqueSlugName, where an
 * ancestor with an empty slug would otherwise leave an empty segment.
 * Mirrors HAXCMSSite::joinSlugSegments in haxcms-php.
 */
function joinSlugSegments(slug) {
  return String(slug)
    .split("/")
    .filter((segment) => segment !== "")
    .join("/");
}

/**
 * Lookup tolerance for slugs saved with a leading "/" (getUniqueSlugName
 * could produce one, e.g. "/child-1"): such a stored slug answers to the
 * same path without the leading "/". Callers try the exact slug first.
 * Mirrors HAXCMSSite::legacySlugMatches in haxcms-php.
 */
function legacySlugMatches(storedSlug, value) {
  if (typeof storedSlug !== "string" || storedSlug.charAt(0) !== "/") {
    return false;
  }
  const trimmed = trimChars(storedSlug, "/");
  return trimmed !== "" && trimmed === trimChars(String(value), "/");
}

module.exports = {
  reserveSlugRoutes,
  joinSlugSegments,
  legacySlugMatches,
  cleanTitleRule,
  generateSlugRule,
  phpUrlDecode,
  trimChars,
};
