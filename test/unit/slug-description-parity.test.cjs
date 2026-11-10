"use strict";

// nodejs / PHP parity for the site data written by slug generation and by a
// content save (haxtheweb/issues#3292):
//   - cleanTitle / generateSlugName follow one rule in both backends; the
//     vectors in test/fixtures/slug-vectors.json are shared verbatim with
//     haxcms-php tests/fixtures/slug-vectors.json
//   - the auto page description is plain text from the page body only, with
//     every newline removed and a 200 character (code point) cut; vectors in
//     test/fixtures/page-description-vectors.json are shared with haxcms-php
//   - after a content save site.json lists items in tree order (orderTree)
//
// Constraints honored: CommonJS (.cjs), node:test + node:assert/strict,
// temp dirs only, NO optional chaining.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const { HAXCMS, HAXCMSSite } = require("../../src/lib/HAXCMS.js");
const {
  pageDescriptionFromBody,
} = require("../../src/lib/sanitizePageMetadata.js");
const FileContentScanner = require("../../src/lib/FileContentScanner.js");
const saveNode = require("../../src/siteRoutes/v1/routes/saveNode.js");

const slugVectors = require("../fixtures/slug-vectors.json");
const descriptionVectors = require("../fixtures/page-description-vectors.json");

// only Unicode letters, digits, "_", "-" and "/" may appear in a slug
const ALLOWED_SLUG = /^[\p{L}\p{N}_/-]+$/u;

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
    send(obj) {
      this.body = obj;
      return this;
    },
  };
}

function saveNodeRequest(body) {
  return {
    headers: { "x-haxcms-site-token": "token" },
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "tester",
      siteName: "demo",
    },
    body: {
      site: { name: "demo" },
      node: { id: "item-1", body: body },
    },
  };
}

// saveNode against an in-memory page; returns the page after the save
async function saveAgainstStubPage(t, body) {
  const page = {
    id: "item-1",
    title: "Page",
    metadata: {},
    writeLocation: async () => 1,
  };
  const site = {
    loadNode: () => page,
    updateNode: async () => {},
    writePageAlternateFormats: async () => {},
    gitCommit: async () => {},
    getUniqueSlugName: (s) => s,
    manifest: { metadata: { site: {} }, save: async () => {} },
  };
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
  t.mock.method(HAXCMS, "loadSite", async () => site);
  t.mock.method(FileContentScanner, "rebuildPageFilesUuids", async () => {});
  const res = stubRes();
  await saveNode(saveNodeRequest(body), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return page;
}

describe("slug rule (shared vectors with haxcms-php)", () => {
  for (const vector of slugVectors.cases) {
    test(JSON.stringify(vector.input), () => {
      assert.equal(HAXCMS.cleanTitle(vector.input), vector.cleanTitle);
      assert.equal(
        HAXCMS.cleanTitle(vector.input, false),
        vector.cleanTitleKeepPage,
      );
      assert.equal(
        HAXCMS.generateSlugName(vector.input),
        vector.generateSlugName,
      );
    });
  }

  test("the reported parity cases", () => {
    assert.equal(HAXCMS.cleanTitle("C++ & C#"), "c-c");
    assert.equal(HAXCMS.generateSlugName("C++ & C#"), "c-c");
    assert.equal(HAXCMS.cleanTitle("日本語のページ"), "日本語のページ");
    assert.equal(HAXCMS.generateSlugName("日本語のページ"), "日本語のページ");
    assert.equal(HAXCMS.cleanTitle("Über cool"), "über-cool");
    assert.equal(HAXCMS.generateSlugName("Über cool"), "über-cool");
  });

  test("empty results become blank", () => {
    for (const input of ["", "   ", "...", "---", "-./-", "%", "😀"]) {
      assert.equal(HAXCMS.cleanTitle(input), "blank", input);
      assert.equal(HAXCMS.generateSlugName(input), "blank", input);
    }
    assert.equal(HAXCMS.generateSlugName(null), "blank");
    assert.equal(HAXCMS.generateSlugName(undefined), "blank");
  });

  test("Security: no traversal, backslash or null byte survives", () => {
    const inputs = [
      "../etc/passwd",
      "../../etc",
      "..%2fetc",
      "%2e%2e%2f%2e%2e%2fetc",
      "a/../b",
      "a\\..\\b",
      "..\\..\\windows",
      "./foo/./bar",
      "foo%00bar",
      "a\u0000b",
      "%C0%AE%C0%AE/etc",
      "....//....//etc",
      "/../",
    ];
    for (const input of inputs) {
      for (const slug of [
        HAXCMS.cleanTitle(input),
        HAXCMS.cleanTitle(input, false),
        HAXCMS.generateSlugName(input),
      ]) {
        assert.equal(slug.indexOf(".."), -1, input + " -> " + slug);
        assert.equal(slug.indexOf("\\"), -1, input + " -> " + slug);
        assert.equal(slug.indexOf("\u0000"), -1, input + " -> " + slug);
        assert.ok(ALLOWED_SLUG.test(slug), input + " -> " + slug);
        assert.ok(!/^[-./]|[-./]$/.test(slug), input + " -> " + slug);
      }
    }
  });

  test("invalid UTF-8 after decoding is a separator, not a failure", () => {
    // %E6 alone is a truncated UTF-8 sequence
    assert.equal(HAXCMS.generateSlugName("%E6%97%A5%E6"), "日");
    assert.equal(HAXCMS.generateSlugName("a%FFb"), "a-b");
  });

  test("the character class does not follow PCRE \\w (marks, connectors)", () => {
    assert.equal(HAXCMS.cleanTitle("a\u203Fb"), "a-b");
    assert.equal(HAXCMS.cleanTitle("cafe\u0301 ok"), "cafe-ok");
  });

  test("Unicode letters and digits are kept and lowercased", () => {
    assert.equal(HAXCMS.cleanTitle("Ñandú/Çedilla"), "ñandú/çedilla");
    assert.equal(HAXCMS.generateSlugName("Ñandú/Çedilla"), "ñandú/çedilla");
    assert.equal(HAXCMS.cleanTitle("مرحبا بالعالم"), "مرحبا-بالعالم");
    assert.equal(HAXCMS.cleanTitle("①² digits"), "①²-digits");
    // only letters / digits: emoji and punctuation become separators
    assert.equal(HAXCMS.cleanTitle("emoji 😀 test"), "emoji-test");
  });

  test("long separator runs stay linear (no regex backtracking)", () => {
    const input = "a" + "-./".repeat(20000) + "!" + "-".repeat(20000);
    const started = Date.now();
    assert.equal(HAXCMS.cleanTitle(input), "a");
    assert.equal(HAXCMS.generateSlugName(input), "a");
    assert.ok(Date.now() - started < 1000);
  });
});

describe("auto page description (shared vectors with haxcms-php)", () => {
  for (const vector of descriptionVectors.cases) {
    test(vector.name, () => {
      assert.equal(pageDescriptionFromBody(vector.body), vector.expected);
    });
  }

  test("cut at 200 characters, not UTF-16 units or bytes", () => {
    const multibyte = pageDescriptionFromBody("<p>" + "é".repeat(300) + "</p>");
    assert.equal(multibyte, "é".repeat(200));
    const astral = pageDescriptionFromBody("<p>" + "😀".repeat(300) + "</p>");
    assert.equal(Array.from(astral).length, 200);
    assert.equal(astral, "😀".repeat(200));
  });

  test("every newline is removed", () => {
    assert.equal(
      pageDescriptionFromBody("<p>a</p>\n<p>b</p>\r\n<p>c\nd</p>"),
      "abcd",
    );
  });

  test("saveNode: page-break attributes never leak into the description", async (t) => {
    const page = await saveAgainstStubPage(
      t,
      '<page-break title="a &lt;b&gt;bold&lt;/b&gt;" slug="x" order="6" item-id="item-1"></page-break><p>Hi</p>',
    );
    assert.equal(page.description, "Hi");
    assert.equal(page.title, "a bold");
  });

  test("saveNode: auto description is cut at 200 characters with newlines removed", async (t) => {
    const page = await saveAgainstStubPage(
      t,
      '<page-break title="T" item-id="item-1"></page-break>' +
        "<p>" +
        "日本\n".repeat(150) +
        "</p>",
    );
    assert.equal(page.description, "日本".repeat(100));
  });

  test("saveNode: an explicit description attribute is kept as sent (decoded, tag-free)", async (t) => {
    const page = await saveAgainstStubPage(
      t,
      '<page-break title="T" item-id="item-1" description="Mine &lt;b&gt;only&lt;/b&gt;"></page-break><p>Body</p>',
    );
    assert.equal(page.description, "Mine only");
  });
});

describe("site.json item order after a content save", () => {
  test("items are written in tree order (orderTree), like haxcms-php", async (t) => {
    const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-order-"));
    t.after(() => fs.removeSync(sitesDir));
    const siteDir = path.join(sitesDir, "demo");
    const ids = ["child-b1", "top-b", "top-a", "child-a1", "item-1"];
    for (const id of ids) {
      fs.ensureDirSync(path.join(siteDir, "pages", id));
      fs.writeFileSync(
        path.join(siteDir, "pages", id, "index.html"),
        "<p></p>",
      );
    }
    const item = (id, parent, order) => ({
      id: id,
      indent: parent ? 1 : 0,
      location: "pages/" + id + "/index.html",
      slug: id,
      order: order,
      parent: parent,
      title: id,
      description: "",
      metadata: { created: 1000000, updated: 1000000 },
    });
    // stored out of tree order: children before parents, siblings unsorted
    fs.writeJsonSync(path.join(siteDir, "site.json"), {
      id: "site-uuid",
      title: "Demo",
      author: "",
      description: "",
      license: "by-sa",
      metadata: {
        site: { name: "demo", settings: { pathauto: false } },
        platform: { features: {} },
      },
      items: [
        item("child-b1", "top-b", 0),
        item("top-b", null, 2),
        item("top-a", null, 0),
        item("child-a1", "top-a", 0),
        item("item-1", null, 1),
      ],
    });
    const site = new HAXCMSSite();
    await site.load(sitesDir, "/sites/", "demo");
    t.mock.method(site, "updateAlternateFormats", async () => {});
    t.mock.method(site, "writePageAlternateFormats", async () => {});
    t.mock.method(site, "gitCommit", async () => {});
    t.mock.method(HAXCMS, "validateRequestToken", () => true);
    t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
    t.mock.method(HAXCMS, "loadSite", async () => site);
    const res = stubRes();
    await saveNode(
      saveNodeRequest(
        '<page-break title="item-1" item-id="item-1" order="1"></page-break><p>Saved</p>',
      ),
      res,
    );
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const written = fs.readJsonSync(path.join(siteDir, "site.json"));
    // orderTree: stable sort by order, then each page followed by its
    // children (a child whose order sorts ahead of every unplaced page is
    // placed where it sorts, as in haxcms-php). The PHP test asserts the
    // same list for the same fixture.
    assert.deepEqual(
      written.items.map((i) => i.id),
      ["child-b1", "top-a", "child-a1", "item-1", "top-b"],
    );
    const saved = written.items.find((i) => i.id === "item-1");
    assert.equal(saved.description, "Saved");
    assert.equal(typeof written.metadata.site.updated, "number");
  });
});

// a temp site on disk loaded through the real HAXCMSSite, with the git and
// alternate-format collaborators stubbed
async function loadTempSite(t, items, settings) {
  const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-parity-"));
  t.after(() => fs.removeSync(sitesDir));
  const siteDir = path.join(sitesDir, "demo");
  for (const entry of items) {
    fs.ensureDirSync(path.join(siteDir, "pages", entry.id));
    fs.writeFileSync(
      path.join(siteDir, "pages", entry.id, "index.html"),
      "<p></p>",
    );
  }
  fs.writeJsonSync(path.join(siteDir, "site.json"), {
    id: "site-uuid",
    title: "Demo",
    author: "",
    description: "",
    license: "by-sa",
    metadata: {
      site: { name: "demo", settings: settings },
      platform: { features: {} },
    },
    items: items,
  });
  const site = new HAXCMSSite();
  await site.load(sitesDir, "/sites/", "demo");
  t.mock.method(site, "updateAlternateFormats", async () => {});
  t.mock.method(site, "writePageAlternateFormats", async () => {});
  t.mock.method(site, "gitCommit", async () => {});
  t.mock.method(HAXCMS, "validateRequestToken", () => true);
  t.mock.method(HAXCMS, "getActiveUserName", () => "tester");
  t.mock.method(HAXCMS, "loadSite", async () => site);
  return { site: site, siteDir: siteDir };
}

function outlineItem(id, parent, slug, metadata) {
  return {
    id: id,
    indent: parent ? 1 : 0,
    location: "pages/" + id + "/index.html",
    slug: slug,
    order: 0,
    parent: parent,
    title: id,
    description: "",
    metadata: Object.assign({ created: 1000000, updated: 1000000 }, metadata),
  };
}

describe("child slug cascade on content save (haxcms-php parity)", () => {
  test("a parent's new slug reaches every descendant; overridePathauto branches keep theirs", async (t) => {
    const { siteDir } = await loadTempSite(
      t,
      [
        outlineItem("parent", null, "title-with-b-bold-/b"),
        outlineItem("child", "parent", "b/child"),
        outlineItem("grandchild", "child", "b/child/grandchild"),
        outlineItem("locked", "parent", "keep-me", { overridePathauto: true }),
        outlineItem("under-locked", "locked", "keep-me/under-locked"),
      ],
      { pathauto: true },
    );
    const res = stubRes();
    const req = saveNodeRequest(
      '<page-break title="Title with bold" item-id="parent"></page-break><p>x</p>',
    );
    req.body.node.id = "parent";
    await saveNode(req, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const written = fs.readJsonSync(path.join(siteDir, "site.json"));
    const slugs = {};
    for (const entry of written.items) {
      slugs[entry.id] = entry.slug;
    }
    assert.deepEqual(slugs, {
      parent: "title-with-bold",
      child: "title-with-bold/child",
      grandchild: "title-with-bold/child/grandchild",
      locked: "keep-me",
      "under-locked": "keep-me/under-locked",
    });
  });

  test("no cascade when pathauto is off", async (t) => {
    const { siteDir } = await loadTempSite(
      t,
      [
        outlineItem("parent", null, "old-parent"),
        outlineItem("child", "parent", "old-parent/child"),
      ],
      { pathauto: false },
    );
    const res = stubRes();
    const req = saveNodeRequest(
      '<page-break title="Renamed" item-id="parent"></page-break><p>x</p>',
    );
    req.body.node.id = "parent";
    await saveNode(req, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const written = fs.readJsonSync(path.join(siteDir, "site.json"));
    assert.deepEqual(
      written.items.map((i) => i.slug),
      ["old-parent", "old-parent/child"],
    );
  });
});

describe("description from the content as saved", () => {
  test("script text never reaches the auto description", async (t) => {
    const page = await saveAgainstStubPage(
      t,
      '<page-break title="T" item-id="item-1"></page-break><script>alert("x")</script><p>After script</p>',
    );
    assert.equal(page.description, "After script");
  });
});

describe("site.json top-level keys survive load + save (haxcms-php parity)", () => {
  const JSONOutlineSchema = require("../../src/lib/JSONOutlineSchema.js");

  function tempManifest(t, data) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-jos-"));
    t.after(() => fs.removeSync(dir));
    const file = path.join(dir, "site.json");
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
  }

  test("location and every top-level key round-trip, in haxcms-php key order", async (t) => {
    const file = tempManifest(t, {
      location: "/sites/demo/index.html",
      license: "by",
      id: "site-uuid",
      title: "Demo",
      author: "Ada",
      description: "About",
      metadata: { site: { name: "demo" } },
      items: [],
    });
    const manifest = new JSONOutlineSchema();
    await manifest.load(file);
    await manifest.save();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(raw), [
      "id",
      "title",
      "author",
      "description",
      "license",
      "metadata",
      "items",
      "location",
    ]);
    assert.equal(raw.location, "/sites/demo/index.html");
    assert.equal(raw.id, "site-uuid");
    assert.equal(raw.title, "Demo");
    assert.equal(raw.author, "Ada");
    assert.equal(raw.description, "About");
    assert.equal(raw.license, "by");
    // a second load + save is byte-stable
    const first = fs.readFileSync(file, "utf8");
    const again = new JSONOutlineSchema();
    await again.load(file);
    await again.save();
    assert.equal(fs.readFileSync(file, "utf8"), first);
  });

  test("a site.json without location writes location: null (as haxcms-php)", async (t) => {
    const file = tempManifest(t, { id: "x", title: "T", items: [] });
    const manifest = new JSONOutlineSchema();
    await manifest.load(file);
    await manifest.save();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(raw.location, null);
    assert.ok(Object.prototype.hasOwnProperty.call(raw, "location"));
  });

  test("Security: site.json cannot redirect the save target or replace methods", async (t) => {
    const elsewhere = path.join(os.tmpdir(), "haxcms-jos-elsewhere.json");
    const file = tempManifest(t, {
      id: "x",
      file: elsewhere,
      save: "not a function",
      unknownKey: "dropped",
      items: [],
    });
    const manifest = new JSONOutlineSchema();
    await manifest.load(file);
    assert.equal(manifest.file, file);
    assert.equal(typeof manifest.save, "function");
    await manifest.save();
    assert.equal(fs.existsSync(elsewhere), false);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(
      Object.prototype.hasOwnProperty.call(raw, "unknownKey"),
      false,
    );
    assert.equal(Object.prototype.hasOwnProperty.call(raw, "file"), false);
  });
});

describe("reserved x route segment (haxcms-php parity)", () => {
  const { reserveSlugRoutes } = require("../../src/lib/slugRules.js");

  test("every x segment becomes x-x; idempotent", () => {
    // same cases as haxcms-php SlugDescriptionParityTest
    const cases = {
      x: "x-x",
      "x/a": "x-x/a",
      "a/x": "a/x-x",
      "a/x/b": "a/x-x/b",
      "x/inbox/a": "x-x/inbox/a",
      "x-x": "x-x",
      xx: "xx",
      "box/x": "box/x-x",
      "inbox/a": "inbox/a",
    };
    for (const input of Object.keys(cases)) {
      assert.equal(reserveSlugRoutes(input), cases[input], input);
      assert.equal(reserveSlugRoutes(cases[input]), cases[input], input);
    }
    assert.equal(
      reserveSlugRoutes(HAXCMS.generateSlugName("X/Search")),
      "x-x/search",
    );
  });

  test("the cascade applies the rule to every generated segment", async (t) => {
    const items = [
      outlineItem("resume", null, "old"),
      outlineItem("padded", "resume", "old/padded-title"),
      outlineItem("leaf", "padded", "old/padded-title/x-x"),
      outlineItem("direct", "resume", "old/x-x"),
    ];
    items[1].title = "Padded Title";
    // titles that clean to the reserved "x" segment
    items[2].title = "X";
    items[3].title = "X";
    const { siteDir } = await loadTempSite(t, items, { pathauto: true });
    const res = stubRes();
    const req = saveNodeRequest(
      '<page-break title="Résumé" item-id="resume"></page-break><p>x</p>',
    );
    req.body.node.id = "resume";
    await saveNode(req, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const slugs = {};
    for (const entry of fs.readJsonSync(path.join(siteDir, "site.json"))
      .items) {
      slugs[entry.id] = entry.slug;
    }
    assert.deepEqual(slugs, {
      resume: "résumé",
      padded: "résumé/padded-title",
      leaf: "résumé/padded-title/x-x",
      direct: "résumé/x-x",
    });
  });

  test("slug attribute and new pages never use the reserved segment", async (t) => {
    const { site } = await loadTempSite(
      t,
      [outlineItem("item-1", null, "item-1")],
      { pathauto: false },
    );
    const cases = { X: "x-x", "x/inbox/a": "x-x/inbox/a", "a/x": "a/x-x" };
    for (const input of Object.keys(cases)) {
      const res = stubRes();
      await saveNode(
        saveNodeRequest(
          '<page-break title="T" item-id="item-1" slug="' +
            input +
            '"></page-break><p>b</p>',
        ),
        res,
      );
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(site.loadNode("item-1").slug, cases[input], input);
    }
    // createItem / addPage derive slugs through getUniqueSlugName
    assert.equal(site.getUniqueSlugName("x"), "x-x");
    assert.equal(site.getUniqueSlugName("item-1/x"), "item-1/x-x");
  });
});
