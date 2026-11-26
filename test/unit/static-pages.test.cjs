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
  REMIX_APP,
  SEARCH_ROUTE,
  deferShellPreloads,
  STATIC_HOST_LIVE_ONLY,
  remixTerms,
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
      // the search route, so the search_site form opens a page
      "x/displays/search/index.html",
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
  // the import map is written by the shell's build/ check (#3428)
  assert.ok(about.indexOf('importmap.type = "importmap"') !== -1);
  assert.ok(about.indexOf("<haxcms-site-builder") !== -1);
  assert.ok(about.indexOf("build-haxcms.js") !== -1);
});

// haxtheweb/issues#3428: an href in the markup is fetched as soon as the
// browser sees it, before the shell has chosen where build/ is served from,
// so a host without build/ answered every hint with a 404.
test("shell preloads for build/ and wc-registry.json carry no href in the markup", async () => {
  const pages = await renderStaticPages(site);
  const about = byPath(pages, "about/index.html").html;
  const head = about.substring(0, about.indexOf("</head>"));
  assert.equal(head.indexOf(' href="./build/'), -1);
  assert.equal(head.indexOf(' href="./wc-registry.json"'), -1);
  assert.ok(
    head.indexOf(
      '<link rel="modulepreload" data-haxcms-cdn-href="./build/es6/node_modules/@haxtheweb/wc-autoload/wc-autoload.js"',
    ) !== -1,
  );
  assert.ok(head.indexOf('data-haxcms-cdn-href="./wc-registry.json"') !== -1);
  // the script that gives them an address runs after every hint
  const apply = head.indexOf("<script data-haxcms-cdn-preloads>");
  const lastHint = head.lastIndexOf("data-haxcms-cdn-href=");
  assert.ok(apply !== -1 && lastHint !== -1 && lastHint < apply);
  // build.js and build-haxcms.js are site files, never from the CDN
  assert.ok(head.indexOf(' href="./build.js"') !== -1);
});

// haxtheweb/issues#3428: a browser only looks for <meta charset> in the
// first 1024 bytes; the shell's scripts used to push it ~3 KB down
test("<meta charset> stays the first thing in every page's <head>", async () => {
  const pages = await renderStaticPages(site);
  for (const page of pages) {
    if (!/\.html$/.test(page.path)) {
      continue;
    }
    const at = page.html.indexOf("<meta charset");
    assert.ok(at !== -1, page.path);
    assert.ok(at < 1024, page.path + ": <meta charset> at byte " + at);
    const head = page.html.substring(0, page.html.indexOf("</head>"));
    assert.ok(at < head.indexOf("<script"), page.path);
    // and only once
    assert.equal(head.split("<meta charset").length - 1, 1, page.path);
  }
});

// haxtheweb/issues#3428: a fixed import map always sent custom/build/'s
// @haxtheweb/* imports to the CDN, so a site that ships its own build/ ran
// two copies of every element its custom theme imported.
test("the shell's import map follows the place it chose for build/", () => {
  const template = fs.readFileSync(
    path.join(REPO_ROOT, "src", "boilerplate", "site", "ghpages.html"),
    "utf8",
  );
  // no fixed map in the markup any more
  assert.equal(template.indexOf('<script type="importmap">'), -1);
  const head = template.substring(0, template.indexOf("</head>"));
  const probe =
    /<script>\s*\(function\(\) \{\s*var cdn = "\.\/";[\s\S]*?<\/script>/.exec(
      head,
    );
  assert.ok(probe);
  const code = probe[0].replace(/^<script>/, "").replace(/<\/script>$/, "");
  function run(status) {
    const inserted = [];
    const sandbox = {
      XMLHttpRequest: function () {
        this.open = () => {};
        this.send = () => {
          this.status = status;
        };
      },
      document: {
        createElement: () => ({}),
        currentScript: { after: (el) => inserted.push(el) },
      },
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].type, "importmap");
    return {
      cdn: sandbox.__appCDN,
      map: JSON.parse(inserted[0].textContent),
    };
  }
  // no build/ on this host: core and custom/ both come from the CDN
  const viaCdn = run(404);
  assert.equal(viaCdn.cdn, "https://cdn.hax.cloud/cdn/");
  assert.deepEqual(viaCdn.map, {
    scopes: {
      "./custom/build/": {
        "@haxtheweb/":
          "https://cdn.hax.cloud/cdn/build/es6/node_modules/@haxtheweb/",
      },
    },
  });
  // the site ships build/: custom/ uses that same copy
  const local = run(200);
  assert.equal(local.cdn, "./");
  assert.deepEqual(local.map, {
    scopes: {
      "./custom/build/": {
        "@haxtheweb/": "./build/es6/node_modules/@haxtheweb/",
      },
    },
  });
});

// haxtheweb/issues#3428: the server-rendered page is hidden under the
// loading screen (so the theme taking it over isn't a layout shift), and
// without JavaScript the loading screen goes and that page shows
test("the shell hides the rendered page only while loading, and shows it without JS", async () => {
  const pages = await renderStaticPages(site);
  const about = byPath(pages, "about/index.html").html;
  const head = about.substring(0, about.indexOf("</head>"));
  assert.ok(
    head.indexOf(
      'body:has(> #loading[aria-busy="true"]) haxcms-site-builder {',
    ) !== -1,
  );
  const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(head);
  assert.ok(noscript);
  assert.ok(noscript[1].indexOf("#loading") !== -1);
  assert.ok(noscript[1].indexOf("display: none !important") !== -1);
  assert.ok(noscript[1].indexOf("visibility: visible !important") !== -1);
  // the loading screen starts out busy, so the rule applies from first paint
  assert.ok(
    about.indexOf('<section role="status" id="loading" aria-busy="true">') !==
      -1,
  );
});

test("the shell points each deferred hint at the place it chose for build/", async () => {
  const template = fs.readFileSync(
    path.join(REPO_ROOT, "src", "boilerplate", "site", "ghpages.html"),
    "utf8",
  );
  const match = /<script data-haxcms-cdn-preloads>([\s\S]*?)<\/script>/.exec(
    template,
  );
  assert.ok(match);
  function run(cdn, paths) {
    const links = (
      paths || ["./build/es6/node_modules/lit/index.js", "./wc-registry.json"]
    ).map((value) => {
      const attrs = { "data-haxcms-cdn-href": value };
      return {
        attrs,
        getAttribute: (name) => attrs[name],
        setAttribute: (name, val) => {
          attrs[name] = val;
        },
      };
    });
    const sandbox = {
      document: { querySelectorAll: () => links },
    };
    sandbox.globalThis = sandbox;
    if (cdn) {
      sandbox.__appCDN = cdn;
    }
    vm.runInNewContext(match[1], sandbox);
    return links.map((link) => link.attrs.href);
  }
  assert.deepEqual(run("https://cdn.hax.cloud/cdn/"), [
    "https://cdn.hax.cloud/cdn/build/es6/node_modules/lit/index.js",
    "https://cdn.hax.cloud/cdn/wc-registry.json",
  ]);
  assert.deepEqual(run("./"), [
    "./build/es6/node_modules/lit/index.js",
    "./wc-registry.json",
  ]);
  assert.deepEqual(run(null), [
    "./build/es6/node_modules/lit/index.js",
    "./wc-registry.json",
  ]);
  // only the shell's own files get an address: nothing with a scheme, no
  // other host, no climbing out of build/
  assert.deepEqual(
    run("https://cdn.hax.cloud/cdn/", [
      "javascript:alert(1)",
      "//evil.example/build/x.js",
      "./build/../../x.js",
      "https://evil.example/build/x.js",
      "./custom/build/custom.es6.js",
    ]),
    [undefined, undefined, undefined, undefined, undefined],
  );
});

test("deferShellPreloads only moves build/ and wc-registry.json hints", () => {
  const input = [
    '<link rel="preload" href="./build.js" as="script" />',
    '<link rel="modulepreload" href="./build/es6/node_modules/lit/index.js" crossorigin="anonymous" />',
    '<link rel="preload" href="./wc-registry.json" as="fetch" crossorigin="anonymous" />',
    '<link rel="preload" href="./pages/item-1/index.html" as="fetch" />',
    '<link rel="modulepreload" href="./custom/build/custom.es6.js" />',
    '<link rel="modulepreload" href="https://cdn.hax.cloud/cdn/build/es6/x.js" />',
    '<link rel="icon" href="./build/es6/icon.png" />',
  ].join("\n");
  const out = deferShellPreloads(input).split("\n");
  assert.equal(out[0], '<link rel="preload" href="./build.js" as="script" />');
  assert.equal(
    out[1],
    '<link rel="modulepreload" data-haxcms-cdn-href="./build/es6/node_modules/lit/index.js" crossorigin="anonymous" />',
  );
  assert.equal(
    out[2],
    '<link rel="preload" data-haxcms-cdn-href="./wc-registry.json" as="fetch" crossorigin="anonymous" />',
  );
  assert.equal(
    out[3],
    '<link rel="preload" href="./pages/item-1/index.html" as="fetch" />',
  );
  assert.equal(
    out[4],
    '<link rel="modulepreload" href="./custom/build/custom.es6.js" />',
  );
  assert.equal(
    out[5],
    '<link rel="modulepreload" href="https://cdn.hax.cloud/cdn/build/es6/x.js" />',
  );
  assert.equal(out[6], '<link rel="icon" href="./build/es6/icon.png" />');
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
    // <slug>.html is the rendered page, not the raw content: static hosts
    // answer /about with about.html
    assert.equal(
      byPath(pages, "about.html").html,
      byPath(pages, "about/index.html").html,
    );
    assert.match(byPath(pages, "about.html").html, /<haxcms-site-builder/);
    for (const page of pages.filter((p) => p.path.endsWith(".html"))) {
      assert.doesNotMatch(
        page.html,
        /<link rel="alternate" type="text\/html"/,
        page.path + " links no raw html alternate",
      );
    }
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

// declarative WebMCP: what an agent or scanner reading the HTML finds
function toolForm(html, name) {
  const match = new RegExp(
    `<form[^>]*toolname="${name}"[^>]*>([\\s\\S]*?)</form>`,
  ).exec(html);
  return match ? match : null;
}

test("every rendered page declares search_site and remix_site as forms", async () => {
  const pages = await renderStaticPages(site);
  const rendered = pages.filter((page) => page.path.endsWith("index.html"));
  assert.ok(rendered.length > 2);
  for (const page of rendered) {
    const search = toolForm(page.html, "search_site");
    assert.ok(search, page.path + " declares search_site");
    assert.match(search[0], /action="\/static-site\/x\/displays\/search"/);
    assert.match(search[0], /method="get"/);
    assert.match(search[0], /tooldescription="[^"]+"/);
    assert.match(search[0], /<input[^>]*name="search"[^>]*required/);
    assert.match(search[0], /<label for="haxcms-tool-search">/);
    const remix = toolForm(page.html, "remix_site");
    assert.ok(remix, page.path + " declares remix_site");
    assert.ok(remix[0].indexOf('action="' + REMIX_APP + '"') !== -1);
    assert.match(
      remix[0],
      /<input type="hidden" name="remix" value="https:\/\/org\.github\.io\/static-site\/">/,
    );
    // remix only ever opens HAX in a new tab; the person confirms there
    assert.doesNotMatch(remix[0], /toolautosubmit/);
    assert.match(remix[0], /rel="license"/);
    // inside the content the front end replaces when it boots
    const builder =
      /<haxcms-site-builder[^>]*>([\s\S]*)<\/haxcms-site-builder>/.exec(
        page.html,
      );
    assert.ok(builder && builder[1].indexOf("data-haxcms-agent-tools") !== -1);
  }
});

test("the search page is published at the search route", async () => {
  const pages = await renderStaticPages(site);
  const searchPage = byPath(pages, SEARCH_ROUTE + "/index.html");
  assert.ok(searchPage, "search page returned");
  assert.ok(toolForm(searchPage.html, "search_site"));
  assert.match(searchPage.html, /<h1>Search<\/h1>/);
  assert.match(searchPage.html, /data-haxcms-static-route/);
  assert.match(searchPage.html, /var route = "\/x\/displays\/search";/);
  // the form's own address (no "/") is answered with the same page
  assert.equal(byPath(pages, SEARCH_ROUTE + ".html").html, searchPage.html);
});

test("a site whose own x/ folder exists keeps it; no search page is returned", async () => {
  const own = path.join(site.siteDirectory, "x");
  fs.ensureDirSync(own);
  try {
    const pages = await renderStaticPages(site);
    assert.equal(byPath(pages, SEARCH_ROUTE + "/index.html"), undefined);
  } finally {
    fs.removeSync(own);
  }
});

test("remix_site needs a license that allows derivatives and the site's address", async () => {
  const savedLicense = site.manifest.license;
  const savedDomain = site.manifest.metadata.site.domain;
  try {
    for (const code of [
      "by-nd",
      "by-nc-nd",
      "all-rights-reserved",
      "",
      "made-up",
    ]) {
      site.manifest.license = code;
      const pages = await renderStaticPages(site);
      assert.equal(toolForm(pages[0].html, "remix_site"), null, code);
      assert.ok(toolForm(pages[0].html, "search_site"), code);
    }
    site.manifest.license = "by-sa";
    site.manifest.metadata.site.domain = "";
    const pages = await renderStaticPages(site);
    assert.equal(toolForm(pages[0].html, "remix_site"), null);
    assert.match(
      toolForm(pages[0].html, "search_site")[0],
      /action="\/x\/displays\/search"/,
    );
  } finally {
    site.manifest.license = savedLicense;
    site.manifest.metadata.site.domain = savedDomain;
  }
});

test("remixTerms follows the HAX license list", () => {
  assert.deepEqual(remixTerms("by-sa").conditions, [
    "attribution",
    "share-alike",
  ]);
  assert.equal(remixTerms("by-sa").allowed, true);
  assert.deepEqual(remixTerms("by-nc").conditions, [
    "attribution",
    "non-commercial",
  ]);
  assert.equal(remixTerms("cc0").allowed, true);
  assert.deepEqual(remixTerms("cc0").conditions, []);
  assert.equal(remixTerms("mit").allowed, true);
  for (const code of [
    "by-nd",
    "by-nc-nd",
    "all-rights-reserved",
    "",
    null,
    "x",
  ]) {
    assert.equal(remixTerms(code).allowed, false, String(code));
  }
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
