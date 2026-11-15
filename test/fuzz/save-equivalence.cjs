"use strict";

// Save equivalence for the outline designer (haxtheweb/issues#3248).
//
// Invariant: for the same starting outline and the same edits, the outline
// designer sends the same saveOutline payloads. A change to how the designer
// renders (row virtualization, lighter rows) must not change a single byte
// of what it saves. run.cjs records the payloads of seeded sessions on one
// front end (--record-saves) and replays the same edits on another
// (--compare-saves); this module makes two recordings comparable and finds
// the first difference.
//
// What is normalized, because it differs between two runs of the same
// session and says nothing about the designer:
// - ids the outline did not start with (pages added or duplicated in the
//   session get random ids, and the server assigns its own on save): each is
//   renamed new-1, new-2, ... in order of first appearance, everywhere it
//   occurs (id, parent, location, slug)
// - metadata.created / metadata.updated timestamps
//
// Constraints honored: CommonJS (.cjs), NO optional chaining.

const FIXTURE_ID = /^item-perf-\d+-\d+$/;
const TIMESTAMP_KEYS = ["created", "updated"];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function zeroTimestamps(value) {
  if (Array.isArray(value)) {
    value.forEach(zeroTimestamps);
    return value;
  }
  if (value && typeof value === "object") {
    Object.keys(value).forEach(function (key) {
      if (
        TIMESTAMP_KEYS.indexOf(key) !== -1 &&
        typeof value[key] === "number"
      ) {
        value[key] = 0;
      } else {
        zeroTimestamps(value[key]);
      }
    });
  }
  return value;
}

/**
 * @param {Array<Array<object>>} saves the items sent by each save, in order
 * @returns {Array<Array<object>>} comparable copy
 */
function normalizeSaves(saves) {
  const renames = [];
  const seen = {};
  saves.forEach(function (items) {
    items.forEach(function (item) {
      const id = String(item.id);
      if (!FIXTURE_ID.test(id) && !seen[id]) {
        seen[id] = true;
        renames.push(id);
      }
    });
  });
  let text = JSON.stringify(saves);
  // longest first, so an id that contains another is replaced whole
  renames
    .map(function (id, n) {
      return { id: id, to: "new-" + (n + 1) };
    })
    .sort(function (a, b) {
      return b.id.length - a.id.length;
    })
    .forEach(function (r) {
      text = text.replace(new RegExp(escapeRegExp(r.id), "g"), r.to);
    });
  return zeroTimestamps(JSON.parse(text));
}

function describe(value) {
  const text = JSON.stringify(value);
  return text === undefined
    ? "(missing)"
    : text.length > 160
      ? text.slice(0, 160) + "..."
      : text;
}

/**
 * First difference between two normalized recordings of one session, or
 * null when they are identical.
 */
function firstDifference(expected, actual) {
  if (expected.length !== actual.length) {
    return "saves: expected " + expected.length + ", got " + actual.length;
  }
  for (let s = 0; s < expected.length; s++) {
    const a = expected[s];
    const b = actual[s];
    if (a.length !== b.length) {
      return (
        "save " + (s + 1) + ": expected " + a.length + " items, got " + b.length
      );
    }
    for (let i = 0; i < a.length; i++) {
      if (JSON.stringify(a[i]) === JSON.stringify(b[i])) {
        continue;
      }
      const keys = Object.keys(a[i]).concat(Object.keys(b[i]));
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (JSON.stringify(a[i][key]) !== JSON.stringify(b[i][key])) {
          return (
            "save " +
            (s + 1) +
            ", item " +
            i +
            " (" +
            (a[i].id || "?") +
            ") " +
            key +
            ": expected " +
            describe(a[i][key]) +
            ", got " +
            describe(b[i][key])
          );
        }
      }
    }
  }
  return null;
}

module.exports = { firstDifference, normalizeSaves };
