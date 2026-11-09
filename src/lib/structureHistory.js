/**
 * Page structure history (haxtheweb/issues#3191).
 *
 * Outline saves (moves, renames, publish toggles) only change site.json, so
 * `git log -- <page file>` never shows them in a page's revision history.
 * This reads site.json at each recent commit that touched it and reports the
 * commits where one item's outline entry changed, with before/after values.
 *
 * Read-only: nothing here writes to the site or changes how saves work.
 * Mirrors haxcms-php lib/StructureHistory.php; keep the two in step.
 */
const { spawn } = require("node:child_process");

const SITE_FILE = "site.json";
// how many of the most recent site.json commits are inspected per request
const STRUCTURE_SCAN_LIMIT = 300;

/**
 * The outline fields reported as structure changes, in display order.
 * parent is reported by title (with ids alongside).
 */
const TOP_LEVEL_FIELDS = ["title", "slug", "parent", "order"];
const METADATA_FIELDS = ["published", "hideInMenu", "locked"];

/**
 * Read many blobs with one `git cat-file --batch` process.
 * Returns an array aligned with specs: a Buffer, or null when missing.
 */
function readBlobs(siteDirectory, specs) {
  return new Promise((resolve) => {
    if (!specs.length) {
      resolve([]);
      return;
    }
    let child = null;
    try {
      child = spawn("git", ["--no-pager", "cat-file", "--batch"], {
        cwd: siteDirectory,
      });
    } catch {
      resolve(specs.map(() => null));
      return;
    }
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(specs.map(() => null)));
    child.on("close", () => {
      const data = Buffer.concat(chunks);
      const results = [];
      let pos = 0;
      for (let i = 0; i < specs.length; i++) {
        const newline = data.indexOf(10, pos);
        if (newline === -1) {
          results.push(null);
          continue;
        }
        const header = data.toString("utf8", pos, newline);
        pos = newline + 1;
        const parts = header.split(" ");
        if (parts.length < 3 || parts[1] !== "blob") {
          // "<spec> missing" or a non-blob object
          results.push(null);
          continue;
        }
        const size = parseInt(parts[2], 10);
        results.push(data.subarray(pos, pos + size));
        // content is followed by a newline
        pos = pos + size + 1;
      }
      resolve(results);
    });
    // specs are "<hash>:site.json": hashes come from git log, never input
    child.stdin.end(specs.join("\n") + "\n");
  });
}

/**
 * Stream many blobs out of one `git cat-file --batch` process, calling
 * onBlob(index, Buffer|null) for each spec in order as soon as it has been
 * read, so only one blob is held at a time (readBlobs keeps every blob: up
 * to 301 site.json versions, ~120MB on a 1,000-page site). Missing objects
 * and anything after a truncated stream read as null, as with readBlobs;
 * if git cannot be started every spec reads as null.
 */
function forEachBlob(siteDirectory, specs, onBlob) {
  return new Promise((resolve) => {
    let next = 0;
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      while (next < specs.length) {
        onBlob(next++, null);
      }
      resolve();
    };
    if (!specs.length) {
      finish();
      return;
    }
    let child = null;
    try {
      child = spawn("git", ["--no-pager", "cat-file", "--batch"], {
        cwd: siteDirectory,
      });
    } catch {
      finish();
      return;
    }
    let pending = [];
    let pendingLength = 0;
    // size of the blob body being read, null while waiting for a header
    let need = null;
    const flatten = () => {
      if (pending.length > 1) {
        pending = [Buffer.concat(pending, pendingLength)];
      }
      return pending.length ? pending[0] : Buffer.alloc(0);
    };
    const consume = (all, count) => {
      const rest = all.subarray(count);
      pending = rest.length ? [rest] : [];
      pendingLength = rest.length;
    };
    const drain = () => {
      while (!settled && next < specs.length) {
        if (need === null) {
          const all = flatten();
          const newline = all.indexOf(10);
          if (newline === -1) {
            return;
          }
          const parts = all.toString("utf8", 0, newline).split(" ");
          consume(all, newline + 1);
          if (parts.length < 3 || parts[1] !== "blob") {
            // "<spec> missing" or a non-blob object
            onBlob(next++, null);
            continue;
          }
          need = parseInt(parts[2], 10);
        }
        // content is followed by a newline
        if (pendingLength < need + 1) {
          return;
        }
        const all = flatten();
        // copy so the chunk the body came from can be released
        const body = Buffer.from(all.subarray(0, need));
        consume(all, need + 1);
        need = null;
        onBlob(next++, body);
      }
    };
    child.stdout.on("data", (chunk) => {
      pending.push(chunk);
      pendingLength += chunk.length;
      drain();
    });
    child.on("error", finish);
    child.on("close", () => {
      drain();
      finish();
    });
    // specs are "<hash>:site.json": hashes come from git log, never input
    child.stdin.on("error", () => {});
    child.stdin.end(specs.join("\n") + "\n");
  });
}

function parseManifest(blob) {
  if (!blob) {
    return null;
  }
  try {
    const manifest = JSON.parse(blob.toString("utf8"));
    if (manifest && Array.isArray(manifest.items)) {
      return manifest;
    }
  } catch {
    // intentionally ignored
  }
  return null;
}

function displayValue(value) {
  if (value === null || typeof value === "undefined") {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

/**
 * The outline snapshot of one item within a manifest, or null when the item
 * is not in it. Parent is resolved to its title in the same manifest.
 */
function itemSnapshot(manifest, itemId) {
  if (!manifest) {
    return null;
  }
  let item = null;
  const titles = {};
  for (let i = 0; i < manifest.items.length; i++) {
    const entry = manifest.items[i];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    titles[entry.id] = entry.title;
    if (entry.id === itemId) {
      item = entry;
    }
  }
  if (!item) {
    return null;
  }
  const metadata =
    item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const parentId = item.parent ? String(item.parent) : "";
  const snapshot = {
    title: displayValue(item.title),
    slug: displayValue(item.slug),
    parent: parentId === "" ? "" : displayValue(titles[parentId] || parentId),
    parentId: parentId,
    order: displayValue(item.order),
  };
  for (let m = 0; m < METADATA_FIELDS.length; m++) {
    // unset and false read the same
    snapshot[METADATA_FIELDS[m]] =
      metadata[METADATA_FIELDS[m]] === true ? "true" : "false";
  }
  return snapshot;
}

/**
 * The field changes between two snapshots, [] when nothing changed.
 * A parent that is renamed but not changed is not reported as a move.
 */
function diffSnapshots(before, after) {
  const changes = [];
  if (!before || !after) {
    return changes;
  }
  const fields = TOP_LEVEL_FIELDS.concat(METADATA_FIELDS);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === "parent") {
      if (before.parentId !== after.parentId) {
        changes.push({
          field: "parent",
          from: before.parent,
          to: after.parent,
          fromId: before.parentId,
          toId: after.parentId,
        });
      }
      continue;
    }
    if (before[field] !== after[field]) {
      changes.push({ field: field, from: before[field], to: after[field] });
    }
  }
  return changes;
}

/**
 * Map of commit hash -> changes for the most recent site.json commits where
 * itemId's outline entry changed. hashes must be newest first; each commit
 * is compared with the next older site.json version in the list (the oldest
 * one is only used as a baseline).
 */
async function findStructureChanges(siteDirectory, itemId, hashes) {
  const result = {};
  const list = Array.isArray(hashes) ? hashes : [];
  if (list.length < 2) {
    return result;
  }
  // one site.json version in memory at a time, compared as it streams in
  let newer = null;
  await forEachBlob(
    siteDirectory,
    list.map((hash) => hash + ":" + SITE_FILE),
    (index, blob) => {
      const snapshot = itemSnapshot(parseManifest(blob), itemId);
      if (index > 0) {
        const changes = diffSnapshots(snapshot, newer);
        if (changes.length) {
          result[list[index - 1]] = changes;
        }
      }
      newer = snapshot;
    },
  );
  return result;
}

module.exports = {
  SITE_FILE,
  STRUCTURE_SCAN_LIMIT,
  readBlobs,
  forEachBlob,
  itemSnapshot,
  diffSnapshots,
  findStructureChanges,
};
