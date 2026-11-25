"use strict";

// Unit tests for src/lib/staticPages.js: the HTML a static host serves for
// a site (index.html plus <slug>/index.html per published page), rendered
// with the live route's metadata and content helpers (haxtheweb/issues#3327).
//
// A temp runtime with a seeded _config is created and cwd moved into it
// BEFORE the first require so config discovery and site writes stay inside
// the temp tree; sites are made with the real HAXCMS.createSite.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BOILERPLATE_SYSTEMSETUP = path.join(
  REPO_ROOT,
  "src",
  "boilerplate",
  "systemsetup",
);

const originalCwd = process.cwd();
const originalRoot = process.env.HAXCMS_ROOT;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-static-"));
const runtimeRoot = path.join(tempRoot, "runtime");
const configRoot = path.join(runtimeRoot, "_config");
const sitesRoot = path.join(runtimeRoot, "_sites");

fs.ensureDirSync(sitesRoot);
fs.ensureDirSync(configRoot);
fs.writeFileSync(path.join(configRoot, ".isHAXcmsConfig"), "");
[
  "config.json",
  "my-custom-elements.js",
  "userData.json",
  "config.php",
  ".htaccess",
  ".user-files-htaccess",
].forEach((file) => {
  fs.copySync(
    path.join(BOILERPLATE_SYSTEMSETUP, file),
    path.join(configRoot, file),
  );
});
["tmp", "cache", "user", "user/files", "skeletons", "settings"].forEach(
  (dir) => {
    fs.ensureDirSync(path.join(configRoot, dir));
  },
);
fs.writeFileSync(
  path.join(configRoot, ".user"),
  JSON.stringify({ name: "static-user", password: "static-pass" }),
);
process.chdir(runtimeRoot);
process.env.HAXCMS_ROOT = runtimeRoot + "/";
process.env.GIT_AUTHOR_NAME = "HAXcms Static";
process.env.GIT_AUTHOR_EMAIL = "static@local.invalid";
process.env.GIT_COMMITTER_NAME = "HAXcms Static";
process.env.GIT_COMMITTER_EMAIL = "static@local.invalid";

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const {
  STATIC_HOST_LIVE_ONLY,
  renderStaticPages,
  staticPagePath,
  staticPageBody,
  staticRouteScript,
} = require("../../src/lib/staticPages.js");

test.after(() => {
  process.chdir(originalCwd);
  if (originalRoot === undefined) {
    delete process.env.HAXCMS_ROOT;
  } else {
    process.env.HAXCMS_ROOT = originalRoot;
  }
  fs.removeSync(tempRoot);
});

// a page with its content file, in the site's normal layout
function addPage(site, id, fields, content) {
  const location = "pages/" + id + "/index.html";
  fs.ensureDirSync(path.join(site.siteDirectory, "pages", id));
  fs.writeFileSync(path.join(site.siteDirectory, location), content);
  const item = Object.assign(
    {
      id: id,
      indent: 0,
      location: location,
      order: site.manifest.items.length,
      parent: null,
      title: id,
      description: "",
      metadata: {},
    },
    fields,
  );
  site.manifest.items.push(item);
  return item;
}

function byPath(pages, filePath) {
  return pages.find((page) => page.path === filePath);
}

let site;

test.before(async () => {
  site = await HAXCMS.createSite("static-site");
  site.manifest.description = "A site about static publishing.";
  site.manifest.metadata.site.domain = "https://org.github.io/static-site";
  const home = site.manifest.items[0];
  fs.writeFileSync(
    path.join(site.siteDirectory, home.location),
    "<p>Welcome to the static site, with enough words to read.</p>",
  );
  addPage(
    site,
    "item-about",
    { title: "About & us", slug: "about" },
    "<h2>Who</h2><p>We publish things.</p>",
  );
  addPage(
    site,
    "item-team",
    { title: "Team", slug: "about/team" },
    "<h1>Our team</h1><p>People.</p>",
  );
  addPage(
    site,
    "item-draft",
    { title: "Draft", slug: "draft", metadata: { published: false } },
    "<p>Not yet.</p>",
  );
  addPage(
    site,
    "item-hidden",
    { title: "Hidden", slug: "hidden", metadata: { hideInMenu: true } },
    "<p>Reachable by address.</p>",
  );
  addPage(
    site,
    "item-files",
    { title: "Files", slug: "files" },
    "<p>Would land on the files folder.</p>",
  );
  addPage(
    site,
    "item-dotted",
    { title: "Dotted", slug: "../escape" },
    "<p>Not a plain path.</p>",
  );
});

test("renders index.html and one folder page per published page", async () => {
  const pages = await renderStaticPages(site);
  assert.deepEqual(
    pages
      .map((page) => page.path)
      .filter((filePath) => /(^|\/)index\.html$/.test(filePath)),
    [
      "index.html",
      "home/index.html",
      "about/index.html",
      "about/team/index.html",
      "hidden/index.html",
    ],
  );
});

test("each page carries its own metadata and content without JavaScript", async () => {
  const pages = await renderStaticPages(site);
  const home = byPath(pages, "index.html").html;
  assert.match(home, /<meta name="description" content="[^"]+"/);
  assert.equal(home.indexOf('<meta name="description" content=""'), -1);
  assert.match(home, /<title>[^<]+<\/title>/);
  assert.ok(home.indexOf("application/ld+json") !== -1);
  assert.ok(
    home.indexOf(
      '<link rel="canonical" href="https://org.github.io/static-site/" />',
    ) !== -1,
  );
  assert.ok(home.indexOf("<main>") !== -1);
  assert.ok(home.indexOf("Welcome to the static site") !== -1);
  // the home page is the site's root: no route script
  assert.equal(home.indexOf("data-haxcms-static-route"), -1);

  const about = byPath(pages, "about/index.html").html;
  assert.ok(
    about.indexOf(
      '<link rel="canonical" href="https://org.github.io/static-site/about" />',
    ) !== -1,
  );
  // title escaped into the heading; the page's own h2 follows it
  assert.ok(about.indexOf("<h1>About &amp; us</h1>") !== -1);
  assert.ok(about.indexOf("<h2>Who</h2>") !== -1);
  assert.ok(about.indexOf("data-haxcms-static-route") !== -1);
  // one charset, one title: the shell's defaults were replaced
  assert.equal(about.match(/<meta charset/gi).length, 1);
  assert.equal(about.match(/<title>/gi).length, 1);
  assert.equal(about.indexOf("<title>HAXcms</title>"), -1);

  // content with its own h1 gets no second one
  const team = byPath(pages, "about/team/index.html").html;
  assert.equal(team.match(/<h1>/gi).length, 1);
  assert.ok(team.indexOf("<h1>Our team</h1>") !== -1);
});

test("the shell's scripts are kept and the route script runs first", async () => {
  const pages = await renderStaticPages(site);
  const about = byPath(pages, "about/index.html").html;
  const route = about.indexOf("data-haxcms-static-route");
  const shellBase = about.indexOf("attempt to correctly set the base");
  assert.ok(route !== -1 && shellBase !== -1 && route < shellBase);
  assert.ok(about.indexOf('<script type="importmap">') !== -1);
  assert.ok(about.indexOf("<haxcms-site-builder") !== -1);
  assert.ok(about.indexOf("build-haxcms.js") !== -1);
});

test("without an absolute address there is no canonical or og:url", async () => {
  const saved = site.manifest.metadata.site.domain;
  site.manifest.metadata.site.domain = "";
  try {
    const pages = await renderStaticPages(site);
    const about = byPath(pages, "about/index.html").html;
    assert.equal(about.indexOf('rel="canonical"'), -1);
    assert.equal(about.indexOf('property="og:url"'), -1);
    // an address passed by the publisher is used instead
    const published = await renderStaticPages(site, {
      domain: "https://static.surge.sh/",
    });
    assert.ok(
      byPath(published, "about/index.html").html.indexOf(
        '<link rel="canonical" href="https://static.surge.sh/about" />',
      ) !== -1,
    );
  } finally {
    site.manifest.metadata.site.domain = saved;
  }
});

test("private sites render nothing and the site is not changed", async () => {
  const before = fs.readdirSync(site.siteDirectory).sort();
  await renderStaticPages(site);
  assert.deepEqual(fs.readdirSync(site.siteDirectory).sort(), before);
  site.manifest.metadata.site.settings.private = true;
  try {
    assert.deepEqual(await renderStaticPages(site), []);
  } finally {
    site.manifest.metadata.site.settings.private = false;
  }
  assert.deepEqual(await renderStaticPages(null), []);
});

// every <link rel="alternate"> a rendered page carries is a file in the output
test("each page's alternate formats are copied to <slug>.<format>", async () => {
  const pageDir = path.join(site.siteDirectory, "pages", "item-about");
  fs.writeFileSync(path.join(pageDir, "index.md"), "## Who\n\nWe publish.\n");
  fs.writeFileSync(path.join(pageDir, "index.json"), '{"id":"item-about"}');
  try {
    const pages = await renderStaticPages(site);
    assert.equal(byPath(pages, "about.md").html, "## Who\n\nWe publish.\n");
    assert.equal(byPath(pages, "about.json").html, '{"id":"item-about"}');
    assert.equal(
      byPath(pages, "about.html").html,
      "<h2>Who</h2><p>We publish things.</p>",
    );
    // no sidecar, no file
    assert.equal(byPath(pages, "about.yaml"), undefined);
    // unpublished pages and pages that land on site folders get none
    assert.equal(byPath(pages, "draft.html"), undefined);
    assert.equal(byPath(pages, "files.html"), undefined);
    const outputPaths = new Set(pages.map((page) => page.path));
    for (const page of pages) {
      if (!page.path.endsWith("index.html")) {
        continue;
      }
      const hrefs = [
        ...page.html.matchAll(
          /<link rel="alternate" type="(?!text\/markdown" href="llms)[^"]*" href="([^"]+)"/g,
        ),
      ].map((match) => match[1]);
      for (const href of hrefs) {
        const relative = href.replace(/^\/static-site\//, "");
        assert.ok(
          outputPaths.has(relative),
          `${page.path} links ${href}, which is in the output`,
        );
      }
    }
  } finally {
    fs.removeSync(path.join(pageDir, "index.md"));
    fs.removeSync(path.join(pageDir, "index.json"));
  }
});

test("an alternate path the site already has is never replaced", async () => {
  const own = path.join(site.siteDirectory, "about.html");
  fs.writeFileSync(own, "the site's own file");
  try {
    const pages = await renderStaticPages(site);
    assert.equal(byPath(pages, "about.html"), undefined);
    assert.ok(byPath(pages, "about/index.html"));
  } finally {
    fs.removeSync(own);
  }
});

test("llms.txt is the static-host copy: no x/api routes", async () => {
  const pages = await renderStaticPages(site);
  const llms = byPath(pages, "llms.txt");
  assert.ok(llms, "llms.txt is returned");
  assert.equal(pages[pages.length - 1], llms);
  assert.equal(llms.html.indexOf("x/api"), -1);
  assert.ok(
    llms.html.indexOf("https://org.github.io/static-site/llms-full.txt") !== -1,
  );
  // the live copy keeps the export route
  assert.ok(site.getLLMSTxt("").indexOf("x/api/v1/site/export/html") !== -1);
  assert.deepEqual(
    [...STATIC_HOST_LIVE_ONLY],
    ["llms.txt", ".well-known/api-catalog"],
  );
});

test("staticPagePath only accepts plain relative folder paths", () => {
  assert.equal(staticPagePath("about"), "about");
  assert.equal(staticPagePath("/about/team/"), "about/team");
  assert.equal(staticPagePath("café"), "café");
  [
    "",
    "/",
    "../x",
    "a/../b",
    "./a",
    ".well-known",
    "a//b",
    "a\\b",
    "a?b",
    "a#b",
    "a%2fb",
    null,
    5,
  ].forEach((slug) => {
    assert.equal(staticPagePath(slug), "", String(slug));
  });
  assert.equal(staticPagePath("a".repeat(1025)), "");
});

test("staticPageBody escapes the title and wraps the content", () => {
  assert.equal(
    staticPageBody({ title: '<x> "q"' }, "<p>t</p>"),
    "<main>\n<h1>&lt;x&gt; &quot;q&quot;</h1>\n<p>t</p>\n</main>",
  );
  assert.equal(
    staticPageBody({ title: "T" }, '<h1 class="a">Own</h1>'),
    '<main>\n<h1 class="a">Own</h1>\n</main>',
  );
  assert.equal(staticPageBody(null, null), "<main>\n\n</main>");
});

// run the route script against a fake document/location
function runRouteScript(pagePath, pathname) {
  const appended = [];
  const replaced = [];
  const sandbox = {
    document: {
      createElement: () => {
        const attributes = {};
        return {
          setAttribute: (name, value) => {
            attributes[name] = value;
          },
          attributes: attributes,
        };
      },
      head: {
        appendChild: (element) => {
          appended.push(element.attributes.href);
        },
      },
    },
    decodeURIComponent: decodeURIComponent,
  };
  sandbox.globalThis = {
    location: { pathname: pathname, search: "?q=1", hash: "#h" },
    history: {
      state: null,
      replaceState: (state, title, url) => {
        replaced.push(url);
      },
    },
  };
  const markup = staticRouteScript(pagePath);
  const code = markup.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  vm.runInNewContext(code, sandbox);
  return { base: appended[0], replaced: replaced[0] };
}

test("route script finds the site's base at any depth and host", () => {
  assert.deepEqual(runRouteScript("about", "/about"), {
    base: "/",
    replaced: undefined,
  });
  assert.deepEqual(runRouteScript("about/team", "/repo/about/team/"), {
    base: "/repo/",
    replaced: "/repo/about/team?q=1#h",
  });
  assert.deepEqual(
    runRouteScript("about", "/org/repo/folder/about/index.html"),
    { base: "/org/repo/folder/", replaced: "/org/repo/folder/about?q=1#h" },
  );
  // percent-encoded addresses match the decoded slug
  assert.equal(runRouteScript("café", "/caf%C3%A9").base, "/");
  // an address that isn't this page leaves the shell to work it out
  assert.deepEqual(runRouteScript("about", "/other"), {
    base: undefined,
    replaced: undefined,
  });
  assert.deepEqual(runRouteScript("about", "/notabout"), {
    base: undefined,
    replaced: undefined,
  });
});

test("route script cannot be closed by a slug", () => {
  const markup = staticRouteScript("a</script><b");
  assert.equal(markup.indexOf("</script><b"), -1);
});
