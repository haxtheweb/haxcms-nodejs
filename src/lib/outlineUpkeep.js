"use strict";
/**
 * Outline upkeep shared by the single-page operations (create, move, indent,
 * outdent, set parent, delete). saveOutline writes the whole outline as the
 * outline designer sent it; it uses adoptChildren only, for the pages a
 * deleted page leaves behind.
 *
 * The rules kept here, the same in haxcms-php (lib/OutlineUpkeep.php):
 *  - after a single-page operation the pages under each parent are numbered
 *    0..n-1 with no gaps and no repeats, in the sequence a reader sees them.
 *    The front end numbers siblings by position when it loads the outline,
 *    so an order it sends ("after this page") means the same spot here.
 *  - `indent` is the page's depth: 0 at the top level, parent's indent + 1 below
 *  - a locked page is changed by nothing but unlocking it
 *  - a deleted page's children move up one level, into its place
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
 * Number the pages under every parent 0..n-1 in the sequence they are shown
 * in (by order, then position in the items array), so orders have no gaps
 * and no repeats. `except` is left out and keeps its order: a page that is
 * about to be placed by an order the client counted without it.
 * @returns {boolean} whether any order changed
 */
function compactSiblingOrders(items = [], except = null) {
  const parents = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item && item !== except && !parents.includes(parentOf(item))) {
      parents.push(parentOf(item));
    }
  }
  let changed = false;
  for (let p = 0; p < parents.length; p++) {
    const siblings = sortedSiblings(items, parents[p]).filter(
      (item) => item !== except,
    );
    for (let i = 0; i < siblings.length; i++) {
      if (siblings[i].order !== i) {
        siblings[i].order = i;
        changed = true;
      }
    }
  }
  return changed;
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

/**
 * A page was deleted: its children (the pages in items whose parent is its
 * id) move up one level into the deleted page's place. They go under its
 * parent, starting at its order and keeping their own order among
 * themselves; the siblings after that slot move down to make room.
 * `deleted` is { id, parent, order } as the page was before it was removed.
 * Returns the pages that moved, so the caller can re-slug them and their
 * branches and set indents.
 */
function adoptChildren(items = [], deleted = null) {
  if (!deleted || deleted.id === undefined || deleted.id === null) {
    return [];
  }
  const id = String(deleted.id);
  const children = items
    .filter(
      (item) =>
        item && parentOf(item) !== null && String(parentOf(item)) === id,
    )
    .sort((a, b) => orderOf(a) - orderOf(b));
  if (children.length === 0) {
    return [];
  }
  const newParent = parentOf(deleted);
  const slot = orderOf(deleted);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (
      item &&
      children.indexOf(item) === -1 &&
      parentOf(item) === newParent &&
      orderOf(item) > slot
    ) {
      item.order = orderOf(item) + children.length - 1;
    }
  }
  for (let i = 0; i < children.length; i++) {
    children[i].parent = newParent;
    children[i].order = slot + i;
  }
  return children;
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
  compactSiblingOrders,
  makeRoomFor,
  lastSiblingOrder,
  syncIndentToDepth,
  adoptChildren,
  isLocked,
};
