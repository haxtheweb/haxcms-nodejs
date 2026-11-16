"use strict";
/**
 * Outline upkeep shared by the single-page operations (create, move, indent,
 * outdent, set parent, delete). saveOutline writes the whole outline as the
 * outline designer sent it and does not use any of this.
 *
 * The rules kept here, the same in haxcms-php (lib/OutlineUpkeep.php):
 *  - siblings never share an `order` value after a single-page operation
 *  - `indent` is the page's depth: 0 at the top level, parent's indent + 1 below
 *  - a locked page is changed by nothing but unlocking it
 */

function parentOf(item) {
  if (
    !item ||
    item.parent === undefined ||
    item.parent === null ||
    item.parent === ""
  ) {
    return null;
  }
  return item.parent;
}

function orderOf(item) {
  const value = parseInt(item && item.order, 10);
  return Number.isFinite(value) ? value : 0;
}

/**
 * The pages under one parent, in the sequence a reader sees them: by order,
 * and where two share an order, by their position in the items array.
 */
function sortedSiblings(items = [], parentId = null) {
  const siblings = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i] && parentOf(items[i]) === parentId) {
      siblings.push({ item: items[i], index: i });
    }
  }
  siblings.sort(
    (a, b) => orderOf(a.item) - orderOf(b.item) || a.index - b.index,
  );
  return siblings.map((entry) => entry.item);
}

/**
 * When pages under one parent share an order value (or hold one that is not
 * a whole number), renumber that group 0..n-1 in the sequence they are
 * already shown in. A group whose orders are distinct is left as it is.
 * @returns {boolean} whether anything was renumbered
 */
function healSiblingOrder(items = [], parentId = null) {
  const siblings = sortedSiblings(items, parentId);
  const seen = new Set();
  let broken = false;
  for (let i = 0; i < siblings.length; i++) {
    const raw = siblings[i].order;
    const value = parseInt(raw, 10);
    if (
      !Number.isFinite(value) ||
      String(value) !== String(raw) ||
      seen.has(value)
    ) {
      broken = true;
      break;
    }
    seen.add(value);
  }
  if (!broken) {
    return false;
  }
  for (let i = 0; i < siblings.length; i++) {
    siblings[i].order = i;
  }
  return true;
}

/**
 * A page was just placed at page.order under its parent. When a sibling
 * already holds that order, move it and every sibling after it down one so
 * the page takes the spot it asked for.
 */
function makeRoomFor(items = [], page = null) {
  if (!page) {
    return;
  }
  const parentId = parentOf(page);
  const wanted = orderOf(page);
  let taken = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (
      item &&
      item !== page &&
      parentOf(item) === parentId &&
      orderOf(item) === wanted
    ) {
      taken = true;
      break;
    }
  }
  if (!taken) {
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (
      item &&
      item !== page &&
      parentOf(item) === parentId &&
      orderOf(item) >= wanted
    ) {
      item.order = orderOf(item) + 1;
    }
  }
}

/** Highest order among the pages under a parent, -1 when it has none. */
function lastSiblingOrder(items = [], parentId = null, except = null) {
  let max = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (
      item &&
      item !== except &&
      parentOf(item) === parentId &&
      orderOf(item) > max
    ) {
      max = orderOf(item);
    }
  }
  return max;
}

/**
 * Set every page's indent to its depth. A parent that is not in the outline
 * counts as one level; a parent chain that loops counts as the top level,
 * so this always ends.
 */
function syncIndentToDepth(items = []) {
  const byId = new Map();
  for (let i = 0; i < items.length; i++) {
    if (items[i] && items[i].id !== undefined && items[i].id !== null) {
      byId.set(String(items[i].id), items[i]);
    }
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      continue;
    }
    let depth = 0;
    let cursor = item;
    const visited = new Set();
    while (cursor) {
      const parentId = parentOf(cursor);
      if (parentId === null) {
        break;
      }
      const key = String(parentId);
      if (visited.has(key)) {
        depth = 0;
        break;
      }
      if (!byId.has(key)) {
        // a parent that is not in the outline still counts as one level
        depth++;
        break;
      }
      visited.add(key);
      depth++;
      cursor = byId.get(key);
    }
    item.indent = depth;
  }
}

function isLocked(page) {
  return !!(
    page &&
    page.metadata &&
    (page.metadata.locked === true || page.metadata.locked === "true")
  );
}

module.exports = {
  parentOf,
  orderOf,
  sortedSiblings,
  healSiblingOrder,
  makeRoomFor,
  lastSiblingOrder,
  syncIndentToDepth,
  isLocked,
};
