/**
 * Managed-file policies (haxtheweb/issues#3186).
 *
 * rebuildManagedFiles() used to copy every boilerplate file over the site's
 * copy on every save. These helpers let each file declare how it is kept in
 * sync instead:
 *
 * - replace    the rendered boilerplate is the whole file (default)
 * - block      only the span between version-neutral markers belongs to
 *              HAXcms; everything outside it belongs to the site owner
 * - json-merge HAXcms owns the keys it renders; other keys are kept
 *
 * Every policy is applied in memory and the caller only writes when the
 * result differs from what is on disk, so an unchanged rebuild writes
 * nothing and makes no git commit.
 *
 * Mirrors PHP ManagedFiles.php. Keep both in step.
 */
const crypto = require("crypto");

// Version-neutral markers: never put a HAXcms version in a marker.
const MANAGED_BLOCK_MARKERS = {
  html: {
    start: "<!-- haxcms:managed:start -->",
    end: "<!-- haxcms:managed:end -->",
  },
  hash: {
    start: "# BEGIN HAXcms managed",
    end: "# END HAXcms managed",
  },
};

// legacy (what to do with an existing file that has no markers yet):
// - "whole"  the file was always fully managed (overwritten on every save),
//            so nothing in it can be owner content: replace it with the
//            marked baseline
// - "hashes" the file was copied once at site creation and may have been
//            edited: replace it only if it is byte-identical to a released
//            boilerplate version, otherwise keep it below the managed block
const MANAGED_FILE_POLICIES = {
  agents: { policy: "block", markers: "html", render: false, legacy: "hashes" },
  htaccess: { policy: "block", markers: "hash", render: true, legacy: "whole" },
  robots: { policy: "block", markers: "hash", render: true, legacy: "whole" },
  package: { policy: "json-merge", render: true },
};

// sha256 (LF-normalized) of every boilerplate site/AGENTS.md released by
// haxcms-nodejs or haxcms-php before it gained managed-block markers.
// Regenerate by hashing each historical version of the file in both repos.
const LEGACY_AGENTS_MD_HASHES = [
  "0be8e2ff53abdfe547117e3822ea0f7631f8ac21171abb1e0a810aee24e45330",
  "65639decc4c8a018b8417bf4144284384ce60b6d6edbdbc9ddefdfc7466db9f0",
  "6a4b7ae0dc63aa5f266a197c72ce69f4a066df4abcf504519009be1756a0e592",
  "6b2be8a4ce58820a1a7ceca2d0953d40ed54015209d3e17c5411a873941636f5",
  "77bb916f500024cb75c5ce1643e40e7fc5163f5619341c3d4ff96d66a30a9bf9",
  "79551daf52a538f444b49f677e3ddccebc47cede9faf6e2c4019f8da8e38c9d6",
  "9c03d861a53cdae000a39c1c00e6f5d3fbfca94fdcd12104576d14d81ed1457b",
  "9cad2830f306844a31508be59adc6d84c7f641880eacc273f5ae3c6ac4059b6e",
  "cdd42032dcff0ac1d28ac9fe776c2fca6bf5582388e11eeaec86490f215862cf",
  "ce7c7f108a824274a81d09104188480b4d0f393b8a4b1dee1967d2b6e0e0d61c",
  "d1c36de097e46e4e7da1bb573755be673716c825a9e3130fdf295af5161e1ad2",
  "e30f17b98e59688eb1cf8ee84ad1f12ef36c7e0bf992cb621323fce9f85f9395",
];

// package.json objects merged one level deep (HAXcms entries win, owner
// entries the boilerplate does not define are kept)
const JSON_MERGE_NESTED_KEYS = ["scripts", "dependencies", "devDependencies"];

// security.txt Expires: keep the existing value while more than this many
// days remain, so the file does not change on every save
const SECURITY_TXT_REFRESH_DAYS = 90;
const SECURITY_TXT_LIFETIME_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

function getManagedFilePolicy(key) {
  if (Object.prototype.hasOwnProperty.call(MANAGED_FILE_POLICIES, key)) {
    return MANAGED_FILE_POLICIES[key];
  }
  return { policy: "replace", render: true };
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function isKnownLegacyAgentsMd(text) {
  const hash = crypto
    .createHash("sha256")
    .update(normalizeNewlines(text), "utf8")
    .digest("hex");
  return LEGACY_AGENTS_MD_HASHES.indexOf(hash) !== -1;
}

/**
 * Locate the first complete managed block. Returns { start, end } where end
 * is the index just past the end marker, or null when there is no block.
 */
function findManagedBlock(text, markersKey) {
  const markers = MANAGED_BLOCK_MARKERS[markersKey];
  if (!markers || typeof text !== "string") {
    return null;
  }
  const start = text.indexOf(markers.start);
  if (start === -1) {
    return null;
  }
  const endMarker = text.indexOf(markers.end, start + markers.start.length);
  if (endMarker === -1) {
    return null;
  }
  return { start: start, end: endMarker + markers.end.length };
}

/**
 * Merge a rendered boilerplate (which contains the markers) into the
 * existing site file. existing is null when the file does not exist.
 */
function mergeManagedBlock(existing, rendered, markersKey, legacy) {
  const renderedBlock = findManagedBlock(rendered, markersKey);
  // a boilerplate without markers cannot be merged safely: treat as replace
  if (!renderedBlock) {
    return rendered;
  }
  if (existing === null || existing === undefined) {
    return rendered;
  }
  const block = rendered.slice(renderedBlock.start, renderedBlock.end);
  const existingBlock = findManagedBlock(existing, markersKey);
  if (existingBlock) {
    return (
      existing.slice(0, existingBlock.start) +
      block +
      existing.slice(existingBlock.end)
    );
  }
  if (legacy === "whole") {
    return rendered;
  }
  if (legacy === "hashes" && isKnownLegacyAgentsMd(existing)) {
    return rendered;
  }
  // unknown owner content with no markers: keep all of it below the block
  return block + "\n\n" + existing;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * HAXcms owns the keys it renders; any other keys in the existing file are
 * kept. When the existing file adds nothing, the rendered text is returned
 * verbatim so formatting stays exactly as the boilerplate defines it.
 */
function mergeManagedJson(existing, rendered) {
  if (existing === null || existing === undefined) {
    return rendered;
  }
  let current;
  let next;
  try {
    current = JSON.parse(existing);
    next = JSON.parse(rendered);
  } catch {
    return rendered;
  }
  if (!isPlainObject(current) || !isPlainObject(next)) {
    return rendered;
  }
  let hasOwnerKeys = false;
  const merged = {};
  Object.keys(next).forEach((key) => {
    if (
      JSON_MERGE_NESTED_KEYS.indexOf(key) !== -1 &&
      isPlainObject(next[key]) &&
      isPlainObject(current[key])
    ) {
      const nested = Object.assign({}, next[key]);
      Object.keys(current[key]).forEach((nestedKey) => {
        if (!Object.prototype.hasOwnProperty.call(next[key], nestedKey)) {
          nested[nestedKey] = current[key][nestedKey];
          hasOwnerKeys = true;
        }
      });
      merged[key] = nested;
    } else {
      merged[key] = next[key];
    }
  });
  Object.keys(current).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      merged[key] = current[key];
      hasOwnerKeys = true;
    }
  });
  if (!hasOwnerKeys) {
    return rendered;
  }
  return JSON.stringify(merged, null, 2) + "\n";
}

/**
 * Apply a file's policy. existing is the current site file (null if absent),
 * rendered is the boilerplate after Twig. Returns the content to keep.
 */
function applyManagedPolicy(key, existing, rendered) {
  const config = getManagedFilePolicy(key);
  if (config.policy === "block") {
    return mergeManagedBlock(existing, rendered, config.markers, config.legacy);
  }
  if (config.policy === "json-merge") {
    return mergeManagedJson(existing, rendered);
  }
  return rendered;
}

/**
 * Expires value for security.txt. Reuses the existing value while more than
 * SECURITY_TXT_REFRESH_DAYS remain; otherwise a new value at day precision.
 */
function getSecurityTxtExpires(existingText, now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  if (typeof existingText === "string") {
    const match = existingText.match(/^Expires:\s*(\S+)\s*$/m);
    if (match) {
      const existingMs = Date.parse(match[1]);
      if (
        !isNaN(existingMs) &&
        existingMs - nowMs > SECURITY_TXT_REFRESH_DAYS * DAY_MS
      ) {
        return match[1];
      }
    }
  }
  const expires = new Date(nowMs + SECURITY_TXT_LIFETIME_DAYS * DAY_MS);
  return new Date(
    Date.UTC(
      expires.getUTCFullYear(),
      expires.getUTCMonth(),
      expires.getUTCDate(),
    ),
  ).toISOString();
}

module.exports = {
  MANAGED_BLOCK_MARKERS,
  MANAGED_FILE_POLICIES,
  LEGACY_AGENTS_MD_HASHES,
  getManagedFilePolicy,
  isKnownLegacyAgentsMd,
  findManagedBlock,
  mergeManagedBlock,
  mergeManagedJson,
  applyManagedPolicy,
  getSecurityTxtExpires,
};
