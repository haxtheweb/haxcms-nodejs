"use strict";

// saveOutline batching on a large, messy outline (haxtheweb/issues#3114).
// save-outline-batching.test.cjs proves the batched save matches the
// one-save-per-item flow for a small edit. Outline designer saves are often
// far messier, and the order site.json ends up in depends on how the save
// ran: per-item saving rebuilt the alternate formats after every existing
// page, and that rebuild stable-sorts the manifest items by order in place.
// With many pages sharing an order across different parents, that order
// decides how site.json, llms.txt, the sitemap and the search index list
// pages. These tests replay one big edit both ways and require every
// generated file to come out byte for byte the same.
//
// The edit: deep nesting, pages moved between parents, renames, deleted
// parents whose children are kept (orphan rescue), new pages including new
// pages under new pages, duplicates of existing pages, new contents, and
// optionally per-page pathauto overrides with custom slugs.
//
// CommonJS, globalThis, no optional chaining, node:test + node:assert/strict.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "saveoutline-large-"));
process.env.HAXCMS_ROOT = testRoot + "/";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const saveOutline = require("../../src/siteRoutes/v1/routes/saveOutline.js");

test.after(() => {
  fs.removeSync(testRoot);
});

const GENERATED = [
  "site.json",
  "rss.xml",
  "atom.xml",
  "sitemap.xml",
  "llms.txt",
  "lunrSearchIndex.json",
];

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

function useTempConfigDirectory(t) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "saveoutline-large-config-"),
  );
  const originalConfigDirectory = HAXCMS.configDirectory;
  HAXCMS.configDirectory = tmpDir;
  t.after(() => {
    HAXCMS.configDirectory = originalConfigDirectory;
    fs.removeSync(tmpDir);
  });
}

function mockAuth(t) {
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
}

function makeReq(siteName, items) {
  return {
    headers: { "x-haxcms-site-token": "token" },
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: siteName,
    },
    body: { site: { name: siteName }, items: items },
  };
}

// small deterministic generator so the outline is the same on every run
function prng(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function siteDir(siteName) {
  return path.join(testRoot, "_sites", siteName);
}

// a site with `count` pages nested up to five levels deep
async function buildSite(t, siteName, count) {
  assert.ok(await HAXCMS.createSite(siteName), "site is created");
  const random = prng(7);
  const items = [];
  for (let i = 0; i < count; i++) {
    let parent = null;
    let indent = 0;
    if (i > 0 && random() < 0.6) {
      const candidate = items[Math.floor(random() * items.length)];
      if (candidate.indent < 4) {
        parent = candidate.id;
        indent = candidate.indent + 1;
      }
    }
    items.push({
      id: "init-" + i,
      title: "Page " + i,
      parent: parent,
      indent: indent,
      order: items.filter((x) => x.parent === parent).length,
      metadata: {},
      contents: "<p>Page " + i + " body</p>",
      new: true,
    });
  }
  const res = stubRes();
  await saveOutline(makeReq(siteName, items), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
}

// the request the outline designer would send for a big, messy edit, built
// from the site as it is (by title, so both replays send the same thing)
function messyRequest(site, seed, options) {
  const random = prng(seed);
  const items = site.manifest.items.map((i) => ({
    id: i.id,
    title: i.title,
    parent: i.parent,
    indent: i.indent,
    order: i.order,
    metadata: {},
  }));
  const byId = {};
  items.forEach((i) => {
    byId[i.id] = i;
  });
  const isDescendant = (ancestor, id) => {
    let current = byId[id];
    while (current && current.parent) {
      if (current.parent === ancestor) {
        return true;
      }
      current = byId[current.parent];
    }
    return false;
  };
  items.forEach((i) => {
    if (random() < 0.3) {
      i.title = i.title + " renamed";
    }
  });
  items.forEach((i) => {
    if (random() < 0.2) {
      const target = items[Math.floor(random() * items.length)];
      if (target.id !== i.id && !isDescendant(i.id, target.id)) {
        i.parent = random() < 0.3 ? null : target.id;
      }
    }
  });
  // some leaves and some parents (their children stay: orphan rescue)
  items.forEach((i) => {
    if (random() < 0.1) {
      i.delete = true;
    }
  });
  const added = [];
  for (let k = 0; k < 10; k++) {
    let parent = null;
    if (k % 3 === 2 && added.length) {
      parent = added[added.length - 1].id;
    } else if (random() < 0.5) {
      parent = items[Math.floor(random() * items.length)].id;
    }
    added.push({
      id: "client-new-" + k,
      title: "New " + k,
      parent: parent,
      indent: 0,
      order: 0,
      metadata: {},
      contents: k % 2 ? "<p>new " + k + "</p>" : "",
      new: true,
    });
  }
  for (let k = 0; k < 4; k++) {
    const source = items[Math.floor(random() * items.length)];
    added.push({
      id: "client-dup-" + k,
      title: "Dup " + k,
      parent: source.parent,
      indent: 0,
      order: 0,
      metadata: {},
      duplicate: source.id,
      new: true,
    });
  }
  items.forEach((i) => {
    if (random() < 0.1) {
      i.contents = "<h2>" + i.title + "</h2><p>edited</p>";
    }
  });
  const all = items.concat(added);
  const allById = {};
  all.forEach((i) => {
    allById[i.id] = i;
  });
  // indents follow parents; siblings get unique, shuffled orders (pages
  // under different parents still share orders, which is the point)
  all.forEach((i) => {
    let depth = 0;
    let current = i;
    while (current.parent && allById[current.parent]) {
      depth++;
      current = allById[current.parent];
    }
    i.indent = depth;
  });
  const groups = {};
  all.forEach((i) => {
    const key = i.parent || "ROOT";
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(i);
  });
  Object.keys(groups).forEach((key) => {
    const group = groups[key];
    group.sort(() => random() - 0.5);
    group.forEach((i, k) => {
      i.order = k;
    });
  });
  // sent in tree order, the way the designer sends it
  const sent = [];
  const walk = (parent) =>
    all
      .filter((i) => (i.parent || null) === parent)
      .sort((a, b) => a.order - b.order)
      .forEach((i) => {
        sent.push(i);
        walk(i.id);
      });
  walk(null);
  if (options.pathautoOverrides) {
    sent.forEach((i, k) => {
      if (k % 4 === 0) {
        i.metadata.overridePathauto = true;
        i.slug = "custom-" + k;
      }
    });
  }
  return sent;
}

// generated files with every page id replaced by its title, so new pages
// (which get fresh server ids on each replay) compare equal
function snapshot(siteName) {
  const dir = siteDir(siteName);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "site.json"), "utf8"),
  );
  const replacements = [];
  manifest.items.forEach((item) => {
    replacements.push([item.id, "ID{" + item.title + "}"]);
    // the search index stores a shortened form of the id
    replacements.push([
      item.id.replace("-", "").replace("item-", "").substring(0, 29),
      "LUNR{" + item.title + "}",
    ]);
  });
  replacements.sort((a, b) => b[0].length - a[0].length);
  const out = {};
  GENERATED.forEach((file) => {
    const p = path.join(dir, file);
    let text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    if (text !== null) {
      replacements.forEach((pair) => {
        text = text.split(pair[0]).join(pair[1]);
      });
    }
    out[file] = text;
  });
  return out;
}

async function replay(t, siteName, items, legacy) {
  const site = await HAXCMS.loadSite(siteName);
  if (legacy) {
    // pre-#3114 behaviour: updateNode always saved site.json and rebuilt
    const origUpdate = site.updateNode.bind(site);
    t.mock.method(site, "updateNode", (page) => origUpdate(page, true));
  }
  t.mock.method(HAXCMS, "loadSite", async () => site);
  const res = stubRes();
  await saveOutline(makeReq(siteName, items), res);
  t.mock.restoreAll();
  return res;
}

async function assertSameBothWays(t, siteName, seed, options) {
  useTempConfigDirectory(t);
  mockAuth(t);
  t.mock.method(Date, "now", () => 1760000000000);
  await buildSite(t, siteName, 60);
  const before = path.join(testRoot, "snapshot-" + siteName);
  fs.copySync(siteDir(siteName), before);
  const items = messyRequest(await HAXCMS.loadSite(siteName), seed, options);
  // the edit really is messy
  assert.ok(items.some((i) => i.delete === true));
  assert.ok(items.some((i) => typeof i.duplicate !== "undefined"));
  assert.ok(items.some((i) => i.new && allNew(items, i.parent)));

  mockAuth(t);
  t.mock.method(Date, "now", () => 1760000000000);
  const batched = await replay(t, siteName, JSON.parse(JSON.stringify(items)));
  assert.equal(batched.statusCode, 200, JSON.stringify(batched.body));
  const batchedFiles = snapshot(siteName);

  fs.removeSync(siteDir(siteName));
  fs.copySync(before, siteDir(siteName));
  mockAuth(t);
  t.mock.method(Date, "now", () => 1760000000000);
  const legacy = await replay(
    t,
    siteName,
    JSON.parse(JSON.stringify(items)),
    true,
  );
  assert.equal(legacy.statusCode, 200, JSON.stringify(legacy.body));
  const legacyFiles = snapshot(siteName);

  GENERATED.forEach((file) => {
    assert.ok(batchedFiles[file] !== null, file + " is generated");
    assert.equal(batchedFiles[file], legacyFiles[file], file + " is identical");
  });
}

// true when `parentId` is itself a page added by the request
function allNew(items, parentId) {
  return items.some((i) => i.id === parentId && i.new === true);
}

test("a large, messy outline save matches the one-save-per-item flow", async (t) => {
  await assertSameBothWays(t, "large-parity", 11, {});
});

test("a large, messy outline save matches it with a different edit", async (t) => {
  await assertSameBothWays(t, "large-parity-2", 99, {});
});

test("a large, messy outline save with pathauto overrides matches it", async (t) => {
  await assertSameBothWays(t, "large-parity-slugs", 23, {
    pathautoOverrides: true,
  });
});
