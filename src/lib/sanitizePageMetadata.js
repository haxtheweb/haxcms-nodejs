// Security (SEC-SANITIZE): shared sanitisation for page title / metadata that
// arrive in bulk from request bodies (saveOutline items[], createNode items[]
// -> addPage). Uses the same per-field primitives saveNode applies so a value
// cannot bypass saveNode's rules by being sent through another route.
const strip_tags = require('locutus/php/strings/strip_tags').strip_tags;
const html_entity_decode = require('locutus/php/strings/html_entity_decode').html_entity_decode;
const {
  sanitizeURLValue,
  sanitizeMetadataValue,
  hasScriptCapableScheme,
} = require('./sanitizeContent.js');

const FORBIDDEN_METADATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// fields saveNode runs through sanitizeURLValue
const URL_METADATA_FIELDS = new Set(['image', 'linkUrl']);
// fields saveNode runs through sanitizeMetadataValue
const TEXT_METADATA_FIELDS = new Set(['tags', 'icon', 'accentColor', 'linkTarget', 'relatedItems']);
// nested arrays / objects deeper than this are dropped
const MAX_METADATA_DEPTH = 5;

/**
 * Plain text from user input that may contain markup or entities.
 * Decode FIRST, then strip, so `&lt;img onerror=..&gt;` cannot turn into
 * live markup after the strip has already run.
 */
function toPlainText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return strip_tags(html_entity_decode(String(value)));
}

// longest auto-generated page description, in characters (code points)
const AUTO_DESCRIPTION_MAX_CHARS = 200;

// elements whose text is never page prose (raw text / inert content)
const NON_TEXT_ELEMENTS = ['script', 'style', 'noscript', 'template'];

function isTagNameEnd(ch) {
  return (
    ch === undefined ||
    ch === '>' ||
    ch === '/' ||
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\f'
  );
}

/**
 * Drop script / style / noscript / template elements with everything inside
 * them. A single linear scan (no regex) over an ASCII-lowercased copy, so
 * offsets line up with the original. An element that is never closed is
 * dropped to the end of the input. Mirrors
 * SanitizeContent::removeNonTextElements in haxcms-php.
 */
function removeNonTextElements(html) {
  const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let out = '';
  let i = 0;
  while (i < html.length) {
    const open = lower.indexOf('<', i);
    if (open === -1) {
      out += html.substring(i);
      break;
    }
    out += html.substring(i, open);
    let name = null;
    for (const candidate of NON_TEXT_ELEMENTS) {
      if (
        lower.startsWith(candidate, open + 1) &&
        isTagNameEnd(lower[open + 1 + candidate.length])
      ) {
        name = candidate;
        break;
      }
    }
    if (name === null) {
      out += '<';
      i = open + 1;
      continue;
    }
    // find the matching end tag: "</name" followed by whitespace, "/" or ">"
    let search = open + 1 + name.length;
    let end = html.length;
    for (;;) {
      const close = lower.indexOf('</' + name, search);
      if (close === -1) {
        break;
      }
      const after = close + 2 + name.length;
      if (isTagNameEnd(lower[after])) {
        const gt = lower.indexOf('>', after);
        end = gt === -1 ? html.length : gt + 1;
        break;
      }
      search = after;
    }
    i = end;
  }
  return out;
}

/**
 * Security (SEC-SANITIZE): an auto page description is plain text derived
 * from the page body only, as saved. The caller passes the sanitized page
 * content (never the <page-break> element or its attributes). The text of
 * script / style / noscript / template elements is dropped, tags are
 * stripped, entities decoded, then tags stripped again so decoded markup
 * cannot survive; every CR / LF is removed and the result is cut at 200
 * characters (code points, not UTF-16 units or bytes). Mirrors
 * SanitizeContent::pageDescription in haxcms-php.
 */
function pageDescriptionFromBody(body) {
  if (body === null || body === undefined) {
    return '';
  }
  const text = toPlainText(strip_tags(removeNonTextElements(String(body)))).replace(
    /[\r\n]/g,
    '',
  );
  return Array.from(text).slice(0, AUTO_DESCRIPTION_MAX_CHARS).join('');
}

function sanitizeMetadataString(value) {
  return sanitizeMetadataValue(value, false);
}

// unknown keys: neutralise markup / attribute breakout only (< > ") and keep
// & and ' so URLs such as metadata.images entries round-trip unchanged; values
// with a javascript/vbscript/livescript/mocha scheme are dropped (undefined)
function sanitizeUnknownMetadataString(value) {
  if (hasScriptCapableScheme(value)) {
    return undefined;
  }
  return String(value)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// strings through escapeString, finite numbers / booleans / null kept,
// arrays and plain objects walked (forbidden keys dropped), everything else
// dropped (returns undefined)
function sanitizeMetadataNested(value, escapeString, depth = 0) {
  if (typeof value === 'string') {
    return escapeString(value);
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (depth >= MAX_METADATA_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const entry of value) {
      const clean = sanitizeMetadataNested(entry, escapeString, depth + 1);
      if (clean !== undefined) {
        out.push(clean);
      }
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_METADATA_KEYS.has(key)) {
        continue;
      }
      const clean = sanitizeMetadataNested(value[key], escapeString, depth + 1);
      if (clean !== undefined) {
        out[key] = clean;
      }
    }
    return out;
  }
  return undefined;
}

function resolveTheme(value, themes) {
  let key = '';
  if (typeof value === 'string') {
    key = value;
  } else if (isPlainObject(value) && typeof value.key === 'string') {
    key = value.key;
  }
  if (
    key === '' ||
    key === '_none_' ||
    FORBIDDEN_METADATA_KEYS.has(key) ||
    !themes ||
    typeof themes !== 'object' ||
    !Object.prototype.hasOwnProperty.call(themes, key) ||
    !themes[key] ||
    typeof themes[key] !== 'object'
  ) {
    return undefined;
  }
  // copy so the shared config.themes entry is never mutated
  return Object.assign({}, themes[key], { key: key });
}

/**
 * Sanitise an incoming metadata object.
 * @returns {{ values: Object, remove: string[] }} keys to set and keys to delete
 */
function sanitizePageMetadata(incoming, options = {}) {
  const result = { values: {}, remove: [] };
  if (!isPlainObject(incoming)) {
    return result;
  }
  const themes = options.themes;
  for (const key of Object.keys(incoming)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) {
      continue;
    }
    const value = incoming[key];
    if (URL_METADATA_FIELDS.has(key)) {
      if (value === null || value === undefined || value === '') {
        result.remove.push(key);
      } else if (typeof value === 'string') {
        const clean = sanitizeURLValue(value, '');
        if (clean === '') {
          result.remove.push(key);
        } else {
          result.values[key] = clean;
        }
      }
      // non-string URL values are ignored (existing value kept)
      continue;
    }
    if (TEXT_METADATA_FIELDS.has(key)) {
      if (value === null || value === undefined || value === '') {
        result.remove.push(key);
      } else if (typeof value === 'string' || typeof value === 'number') {
        result.values[key] = sanitizeMetadataString(String(value));
      } else {
        const clean = sanitizeMetadataNested(value, sanitizeMetadataString);
        if (clean !== undefined) {
          result.values[key] = clean;
        }
      }
      continue;
    }
    if (key === 'theme') {
      const theme = resolveTheme(value, themes);
      if (theme === undefined) {
        result.remove.push(key);
      } else {
        result.values[key] = theme;
      }
      continue;
    }
    const clean = sanitizeMetadataNested(value, sanitizeUnknownMetadataString);
    if (clean !== undefined) {
      result.values[key] = clean;
    }
  }
  return result;
}

/**
 * Apply sanitised incoming metadata onto page.metadata (merge semantics:
 * keys not sent are left untouched).
 */
function applyPageMetadata(page, incoming, options = {}) {
  if (!page) {
    return page;
  }
  if (!page.metadata || typeof page.metadata !== 'object') {
    page.metadata = {};
  }
  const { values, remove } = sanitizePageMetadata(incoming, options);
  for (const key of remove) {
    delete page.metadata[key];
  }
  for (const key of Object.keys(values)) {
    page.metadata[key] = values[key];
  }
  return page;
}

module.exports = {
  toPlainText,
  pageDescriptionFromBody,
  removeNonTextElements,
  AUTO_DESCRIPTION_MAX_CHARS,
  sanitizePageMetadata,
  applyPageMetadata,
  FORBIDDEN_METADATA_KEYS,
  URL_METADATA_FIELDS,
  TEXT_METADATA_FIELDS,
};
