// Canonical text formats (haxtheweb/issues#3394): one way to write JSON and
// YAML, the same byte for byte in haxcms-nodejs and haxcms-php. The PHP twin
// is lib/CanonicalFormat.php; test/fixtures/canonical-format-vectors.json is
// shared by both test suites and pins the output. Change the rules in both
// files and the vectors together.
//
//   json(value)        compact JSON: API responses
//   prettyJson(value)  JSON indented 4 spaces: md / html forms, files on disk
//   yaml(value)        block YAML (rules below)
//
// Strings are written as JSON writes them, with "/" and non-ASCII letters
// as they are (no \/ or é escapes). Numbers follow JavaScript's
// Number#toString (0.00001, 1e-7, 1e+21).
//
// YAML rules:
//   - a mapping is "key: value" lines; a list is "- value" lines, indented
//     2 spaces under the key that holds it
//   - an empty list is [] and an empty mapping is {}, on the key's line
//   - a mapping in a list starts on the "- " line; a list in a list starts
//     on the line after a lone "-"
//   - null, true, false and numbers are written as JSON writes them
//   - a key or string is written plain when it matches PLAIN_SCALAR and is
//     not one of RESERVED_WORDS; otherwise it is a double-quoted JSON
//     string. The document ends with a newline.
"use strict";

const PLAIN_SCALAR = /^[A-Za-z_][A-Za-z0-9_ ./-]*$/;
const RESERVED_WORDS = [
  "true",
  "false",
  "null",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "nan",
  "inf",
];

// JSON-safe copy: what JSON.stringify would keep (toJSON, no undefined)
function normalize(value) {
  if (value === undefined) {
    return null;
  }
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}

function json(value) {
  const text = JSON.stringify(value);
  return text === undefined ? "null" : text;
}

function prettyJson(value) {
  const text = JSON.stringify(value, null, 4);
  return text === undefined ? "null" : text;
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalarText(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  const text = String(value);
  if (
    PLAIN_SCALAR.test(text) &&
    text[text.length - 1] !== " " &&
    RESERVED_WORDS.indexOf(text.toLowerCase()) === -1
  ) {
    return text;
  }
  return JSON.stringify(text);
}

function emptyText(value) {
  return Array.isArray(value) ? "[]" : "{}";
}

function isEmptyCollection(value) {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return isMapping(value) && Object.keys(value).length === 0;
}

function mappingLines(map, indent, lines) {
  const pad = " ".repeat(indent);
  for (const key of Object.keys(map)) {
    const item = map[key];
    const keyText = scalarText(key);
    if (item !== null && typeof item === "object") {
      if (isEmptyCollection(item)) {
        lines.push(pad + keyText + ": " + emptyText(item));
      } else if (Array.isArray(item)) {
        lines.push(pad + keyText + ":");
        listLines(item, indent + 2, lines);
      } else {
        lines.push(pad + keyText + ":");
        mappingLines(item, indent + 2, lines);
      }
    } else {
      lines.push(pad + keyText + ": " + scalarText(item));
    }
  }
}

function listLines(list, indent, lines) {
  const pad = " ".repeat(indent);
  for (const item of list) {
    if (item !== null && typeof item === "object") {
      if (isEmptyCollection(item)) {
        lines.push(pad + "- " + emptyText(item));
      } else if (Array.isArray(item)) {
        lines.push(pad + "-");
        listLines(item, indent + 2, lines);
      } else {
        const inner = [];
        mappingLines(item, indent + 2, inner);
        inner[0] = pad + "- " + inner[0].slice(indent + 2);
        for (const line of inner) {
          lines.push(line);
        }
      }
    } else {
      lines.push(pad + "- " + scalarText(item));
    }
  }
}

function yaml(value) {
  const data = normalize(value);
  if (data === null || typeof data !== "object") {
    return scalarText(data) + "\n";
  }
  if (isEmptyCollection(data)) {
    return emptyText(data) + "\n";
  }
  const lines = [];
  if (Array.isArray(data)) {
    listLines(data, 0, lines);
  } else {
    mappingLines(data, 0, lines);
  }
  return lines.join("\n") + "\n";
}

module.exports = { json, prettyJson, yaml };
