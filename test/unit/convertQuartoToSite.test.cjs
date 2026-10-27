"use strict";

// Unit tests for convertQuartoToSite (haxtheweb/issues#2189).
//
// Quarto declares its outline in _quarto.yml (book.chapters with parts and
// book.appendices for a book, website.sidebar or website.navbar for a site),
// so the converter reads that YAML as data and never renders or executes
// anything. These tests cover the outline, the page pipeline (front matter,
// headings, callouts, executable chunks, shortcodes, includes, attribute
// blocks, cross-references, notebooks, images, links, assets) and the safety
// valves.
//
// The network is stubbed at safeFetch, so the suite never leaves the machine:
// api.github.com answers the repo and tree calls, raw.githubusercontent.com
// answers file reads from an in-memory fixture repository. The fixture is
// synthetic; no third-party content is copied into the tests.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const safeFetchMod = require("../../src/lib/safeFetch.js");
const {
  convertQuartoToSite,
  LIMITS,
} = require("../../src/systemRoutes/v1/routes/imports/convertQuartoToSite.js");

const OWNER = "example-org";
const REPO = "widgets-book";
const REPO_URL = `https://github.com/${OWNER}/${REPO}`;

const BOOK_CONFIG = `project:
  type: book
  output-dir: docs

book:
  title: "Hands-On Widgets"
  author:
    - name: Ada Example
  site-url: https://example.org/widgets/
  chapters:
    - index.qmd
    - preface.qmd
    - part: basics.qmd
      chapters:
        - setup.qmd
        - first-steps.qmd
    - part: "Going Further"
      chapters:
        - chapters/*.qmd
    - href: about.qmd
      text: About the author
  appendices:
    - a1-install.qmd
    - notebook.ipynb

license: CC BY-SA 4.0
`;

const NOTEBOOK = JSON.stringify({
  cells: [
    { cell_type: "raw", source: ["---\n", "title: Notebook chapter\n", "---"] },
    { cell_type: "markdown", source: ["## Intro\n", "\n", "Notebook text."] },
    {
      cell_type: "code",
      source: ["#| label: calc\n", "total = 1 + 1\n", "total"],
      outputs: [{ output_type: "execute_result" }],
    },
  ],
  metadata: { kernelspec: { language: "python" } },
});

const BOOK_FILES = {
  "_quarto.yml": BOOK_CONFIG,
  "README.md": "# Widgets book source\n",
  "index.qmd": "---\ntitle: Welcome\n---\n\nWelcome to the book.\n",
  "preface.qmd":
    '# Preface {#sec-preface}\n\nThis book teaches widgets. See @fig-widget and @sec-setup.\n\n![A widget](images/widget.png){#fig-widget fig-alt="A blue widget"}\n',
  "basics.qmd": "# Basics\n\nPart introduction.\n",
  "setup.qmd":
    "# Setup\n\n" +
    "::: {.callout-note}\n## Heads up\nInstall the thing.\n:::\n\n" +
    "```{r}\n#| label: setup\n#| echo: true\nx <- 1\n```\n\n" +
    "```{r}\n#| echo: false\nhidden <- 2\n```\n\n" +
    "See [first steps](first-steps.qmd#sec-go) and [the appendix](a1-install.html).\n",
  "first-steps.qmd":
    '---\ntitle: First steps (front matter)\n---\n\n# Kept heading\n\nGo.\n\n{{< video https://www.youtube.com/watch?v=abc title="Demo" >}}\n',
  "chapters/two.qmd": "# Two\n\nSecond chapter.\n",
  "chapters/one.qmd": "# One\n\nFirst chapter.\n",
  "about.qmd":
    '# About\n\nSome [marked text]{.mark} and a [link](https://example.com){target="_blank"}.\n\n' +
    '::: {.content-visible when-format="pdf"}\nPDF only\n:::\n\n' +
    '::: {.content-hidden when-format="pdf"}\nHTML only\n:::\n',
  "a1-install.qmd":
    "# Installing\n\n{{< include _shared.qmd >}}\n\n{{< pagebreak >}}\n\n{{< lipsum 1 >}}\n\n{{< brand logo >}}\n",
  "_shared.qmd": "---\ntitle: ignored\n---\n\nShared text.\n",
  "notebook.ipynb": NOTEBOOK,
  "images/widget.png": "PNG",
  "images/diagram.svg": "SVG",
  "docs/old.qmd": "# Rendered output, not source\n",
};

const WEBSITE_CONFIG = `project:
  type: website

website:
  title: "Widget Docs"
  site-url: https://docs.example.org
  sidebar:
    contents:
      - index.qmd
      - section: "Guides"
        href: guides/overview.qmd
        contents:
          - guides/install.qmd
          - text: "Using widgets"
            href: guides/use.qmd
      - section: "Reference"
        contents:
          - auto: "reference/*.qmd"
      - text: "Project site"
        href: https://example.com/project
      - missing.qmd
`;

const WEBSITE_FILES = {
  "_quarto.yml": WEBSITE_CONFIG,
  "index.qmd": "# Home\n\nWelcome.\n",
  "guides/overview.qmd": "# Overview\n\nGuides start here.\n",
  "guides/install.qmd": "# Install\n\nRun the installer.\n",
  "guides/use.qmd": "# Use\n\nUse it.\n",
  "reference/b-api.qmd": "# B API\n\nB.\n",
  "reference/a-api.qmd": "# A API\n\nA.\n",
};

describe("convertQuartoToSite - #2189", () => {
  const realSafeFetch = safeFetchMod.safeFetch;
  const realLimits = Object.assign({}, LIMITS);
  let fetched;
  let requests;

  beforeEach(() => {
    fetched = [];
    requests = [];
    // no need to be polite to a stub
    LIMITS.requestDelayMs = 0;
  });

  afterEach(() => {
    safeFetchMod.safeFetch = realSafeFetch;
    Object.assign(LIMITS, realLimits);
  });

  function response(body, status, isJson) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      headers: {
        get: function () {
          return null;
        },
      },
      json: async function () {
        return isJson ? body : JSON.parse(body);
      },
      text: async function () {
        return isJson ? JSON.stringify(body) : body;
      },
    };
  }

  // answer the GitHub API and raw file reads from an in-memory repository
  function stubRepository(options) {
    const settings = options || {};
    const files = Object.assign(
      {},
      settings.only ? {} : BOOK_FILES,
      settings.files || {},
    );
    Object.keys(settings.removed || {}).forEach((path) => {
      delete files[path];
    });
    const branch = settings.branch || "main";
    safeFetchMod.safeFetch = async function (url, options) {
      fetched.push(url);
      requests.push({ url: url, options: options || {} });
      if (url === `https://api.github.com/repos/${OWNER}/${REPO}`) {
        if (settings.repoStatus) {
          return response({}, settings.repoStatus, true);
        }
        return response({ default_branch: branch }, 200, true);
      }
      if (
        url.indexOf(
          `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/`,
        ) === 0
      ) {
        const tree = Object.keys(files).map((path) => ({
          path: path,
          type: "blob",
        }));
        return response({ tree: tree }, 200, true);
      }
      const rawPrefix = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${branch}/`;
      if (url.indexOf(rawPrefix) === 0) {
        const path = decodeURI(url.slice(rawPrefix.length));
        if (settings.unreadable && settings.unreadable.indexOf(path) !== -1) {
          return response("", 500, false);
        }
        if (typeof files[path] === "string") {
          return response(files[path], 200, false);
        }
      }
      return response("", 404, false);
    };
    return files;
  }

  async function run(repoUrl) {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
    await convertQuartoToSite(
      { body: { repoUrl: repoUrl === undefined ? REPO_URL : repoUrl } },
      res,
    );
    return res;
  }

  function itemBySlug(items, slug) {
    return items.filter((item) => item.slug === slug)[0];
  }

  function itemByTitle(items, title) {
    return items.filter((item) => item.title === title)[0];
  }

  // --- request validation -------------------------------------------------

  test("a missing repoUrl is rejected before any fetch", async () => {
    stubRepository();
    const res = await run("");
    assert.equal(res.statusCode, 400);
    assert.match(res.body.data.error, /missing `repoUrl`/);
    assert.equal(fetched.length, 0);
  });

  test("a non-GitHub URL is rejected", async () => {
    stubRepository();
    const res = await run("https://gitlab.com/owner/repo");
    assert.equal(res.statusCode, 400);
    assert.match(res.body.data.error, /github\.com/);
    assert.equal(fetched.length, 0);
  });

  test("a URL without owner/repo is rejected", async () => {
    stubRepository();
    const res = await run("https://github.com/example-org");
    assert.equal(res.statusCode, 400);
    assert.match(res.body.data.error, /owner\/repo/);
  });

  test("a repository with no _quarto.yml reports 422", async () => {
    stubRepository({ removed: { "_quarto.yml": true } });
    const res = await run();
    assert.equal(res.statusCode, 422);
    assert.match(res.body.data.error, /No _quarto\.yml file found/);
  });

  test("a repository GitHub cannot find reports 422", async () => {
    stubRepository({ repoStatus: 404 });
    const res = await run();
    assert.equal(res.statusCode, 422);
  });

  test("an unreadable _quarto.yml reports 422", async () => {
    stubRepository({ unreadable: ["_quarto.yml"] });
    const res = await run();
    assert.equal(res.statusCode, 422);
    assert.match(res.body.data.error, /Unable to read _quarto\.yml/);
  });

  test("GitHub requests carry the import User-Agent", async () => {
    stubRepository();
    await run();
    const api = requests.filter(
      (request) => request.url.indexOf("https://api.github.com/") === 0,
    );
    assert.ok(api.length >= 2);
    api.forEach((request) => {
      assert.equal(request.options.headers["User-Agent"], "HAXcms-Import/1.0");
    });
  });

  test("a /tree/<branch> URL names the branch to read", async () => {
    stubRepository({ branch: "develop" });
    const res = await run(`${REPO_URL}/tree/develop`);
    assert.equal(res.statusCode, 200);
    assert.ok(
      fetched.some((url) => url.indexOf("/git/trees/develop?recursive=1") > -1),
    );
    assert.equal(res.body.data.items[0].metadata.quarto.branch, "develop");
  });

  // --- book outline -------------------------------------------------------

  test("book chapters, parts and appendices become the outline", async () => {
    stubRepository();
    const res = await run();
    assert.equal(res.statusCode, 200);
    const items = res.body.data.items;
    assert.deepEqual(
      items.map((item) => [item.indent, item.order, item.slug]),
      [
        [0, 0, "home"],
        [0, 1, "preface"],
        [0, 2, "basics"],
        [1, 0, "basics/setup"],
        [1, 1, "basics/first-steps"],
        [0, 3, "going-further"],
        [1, 0, "going-further/one"],
        [1, 1, "going-further/two"],
        [0, 4, "about-the-author"],
        [0, 5, "a1-install"],
        [0, 6, "notebook"],
      ],
    );
    const basics = itemBySlug(items, "basics");
    assert.equal(itemBySlug(items, "basics/setup").parent, basics.id);
    assert.equal(basics.parent, null);
    assert.equal(res.body.data.filename, "Hands-On Widgets");
  });

  test("a part that is a page keeps its content, a part that is a title is a landing page", async () => {
    stubRepository();
    const items = (await run()).body.data.items;
    assert.match(itemBySlug(items, "basics").contents, /Part introduction/);
    assert.equal(itemBySlug(items, "going-further").contents, "<p></p>");
  });

  test("a chapters glob expands in path order beneath its part", async () => {
    stubRepository();
    const items = (await run()).body.data.items;
    const part = itemBySlug(items, "going-further");
    const children = items.filter((item) => item.parent === part.id);
    assert.deepEqual(
      children.map((item) => item.title),
      ["One", "Two"],
    );
  });

  test("a page named twice in the outline is placed once", async () => {
    const config = BOOK_CONFIG.replace(
      "    - index.qmd\n",
      "    - index.qmd\n    - index.qmd\n",
    );
    stubRepository({ files: { "_quarto.yml": config } });
    const items = (await run()).body.data.items;
    assert.equal(
      items.filter((item) => item.metadata.quarto.path === "index.qmd").length,
      1,
    );
  });

  test("two pages with the same title keep distinct slugs", async () => {
    const config = `project:\n  type: book\nbook:\n  chapters:\n    - href: a.qmd\n      text: Same\n    - href: b.qmd\n      text: Same\n`;
    stubRepository({
      only: true,
      files: {
        "_quarto.yml": config,
        "a.qmd": "# A\n",
        "b.qmd": "# B\n",
      },
    });
    const items = (await run()).body.data.items;
    assert.deepEqual(
      items.map((item) => item.slug),
      ["same", "same-2"],
    );
  });

  test("a project file below the root sets the project root", async () => {
    stubRepository({
      only: true,
      files: {
        "book/_quarto.yml":
          "project:\n  type: book\nbook:\n  chapters:\n    - index.qmd\n    - one.qmd\n",
        "book/index.qmd": "# Start\n\n![pic](img/pic.png)\n",
        "book/one.qmd": "# One\n",
        "book/img/pic.png": "PNG",
        "other/_quarto.yml": "project:\n  type: default\n",
      },
    });
    const res = await run();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.items.length, 2);
    assert.deepEqual(Object.keys(res.body.data.files), ["files/pic.png"]);
    assert.equal(
      res.body.data.files["files/pic.png"],
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/book/img/pic.png`,
    );
  });

  // --- title resolution -----------------------------------------------------

  test("front matter title wins, then the first heading, then the file name", async () => {
    stubRepository();
    const items = (await run()).body.data.items;
    assert.equal(itemBySlug(items, "home").title, "Welcome");
    assert.equal(itemBySlug(items, "preface").title, "Preface");
    assert.equal(
      itemBySlug(items, "basics/first-steps").title,
      "First steps (front matter)",
    );
  });

  test("a heading that titled the page is not repeated in its body, one beside a front matter title is kept", async () => {
    stubRepository();
    const items = (await run()).body.data.items;
    assert.doesNotMatch(itemBySlug(items, "preface").contents, /<h1/);
    assert.match(
      itemBySlug(items, "basics/first-steps").contents,
      /<h1>Kept heading<\/h1>/,
    );
  });

  test("an outline label is the title, whatever the page says", async () => {
    stubRepository();
    const items = (await run()).body.data.items;
    assert.equal(
      itemBySlug(items, "about-the-author").title,
      "About the author",
    );
  });

  // --- metadata -----------------------------------------------------------------

  test("items record their Quarto source and where it is published", async () => {
    stubRepository();
    const items = (await run()).body.data.items;
    const setup = itemBySlug(items, "basics/setup");
    assert.equal(setup.metadata.sourceType, "quarto");
    assert.equal(setup.metadata.quarto.repo, `${OWNER}/${REPO}`);
    assert.equal(setup.metadata.quarto.path, "setup.qmd");
    assert.equal(setup.metadata.quarto.author, "Ada Example");
    assert.equal(setup.metadata.quarto.workTitle, "Hands-On Widgets");
    assert.equal(
      setup.metadata.source,
      "https://example.org/widgets/setup.html",
    );
    assert.equal(itemBySlug(items, "going-further").metadata.source, undefined);
  });

  test("a declared license is normalized, returned for the site and credited on each page", async () => {
    stubRepository();
    const res = await run();
    assert.equal(res.body.data.site.license, "by-sa");
    const setup = itemBySlug(res.body.data.items, "basics/setup");
    assert.match(
      setup.contents,
      /<license-element license="by-sa" title="Setup" creator="Ada Example" source="https:\/\/example\.org\/widgets\/setup\.html"><\/license-element>/,
    );
  });

  test("page front matter can set its own license", async () => {
    stubRepository({
      files: {
        "preface.qmd":
          "---\nlicense: cc-by\nauthor: Someone Else\n---\n\nText.\n",
      },
    });
    const items = (await run()).body.data.items;
    const preface = itemBySlug(items, "preface");
    assert.equal(preface.metadata.quarto.license, "by");
    assert.match(preface.contents, /license="by"[^>]*creator="Someone Else"/);
  });

  test("a project with no license credits nothing", async () => {
    stubRepository({
      files: {
        "_quarto.yml": BOOK_CONFIG.replace("license: CC BY-SA 4.0\n", ""),
      },
    });
    const res = await run();
    assert.equal(res.body.data.site.license, null);
    assert.deepEqual(
      res.body.data.warnings.map((warning) => warning.code),
      ["license:not-found"],
    );
    assert.doesNotMatch(
      itemBySlug(res.body.data.items, "basics/setup").contents,
      /license-element/,
    );
  });

  // --- license detection and notices ------------------------------------------

  const NO_LICENSE_CONFIG = BOOK_CONFIG.replace("license: CC BY-SA 4.0\n", "");
  const warningCodes = (res) =>
    res.body.data.warnings.map((warning) => warning.code);

  test("a share-alike license in the project file warns about share-alike only", async () => {
    stubRepository();
    const res = await run();
    assert.deepEqual(warningCodes(res), ["license:share-alike"]);
  });

  test("a no-derivatives license warns, and so does non-commercial", async () => {
    stubRepository({
      files: {
        "_quarto.yml": BOOK_CONFIG.replace(
          "license: CC BY-SA 4.0",
          "license: CC BY-NC-ND 4.0",
        ),
      },
    });
    const res = await run();
    assert.equal(res.body.data.site.license, "by-nc-nd");
    assert.deepEqual(warningCodes(res), [
      "license:no-derivatives",
      "license:non-commercial",
    ]);
  });

  test("a license file is read when the project file declares none", async () => {
    stubRepository({
      files: {
        "_quarto.yml": NO_LICENSE_CONFIG,
        LICENSE:
          "This work is licensed under the Creative Commons Attribution-NonCommercial-NoDerivs 4.0 United States License. To view a copy of this license, visit https://creativecommons.org/licenses/by-nc-nd/4.0/\n",
      },
    });
    const res = await run();
    assert.equal(res.body.data.site.license, "by-nc-nd");
    assert.deepEqual(warningCodes(res), [
      "license:no-derivatives",
      "license:non-commercial",
      "license:from-file",
    ]);
    assert.match(
      itemBySlug(res.body.data.items, "basics/setup").contents,
      /<license-element license="by-nc-nd"/,
    );
  });

  test("the project file wins and the license file is never fetched", async () => {
    stubRepository({
      files: {
        LICENSE:
          "Permission is hereby granted, free of charge, to any person obtaining a copy",
      },
    });
    const res = await run();
    assert.equal(res.body.data.site.license, "by-sa");
    assert.ok(!fetched.some((url) => /\/LICENSE$/.test(url)));
  });

  test("a project that reserves all rights is refused before any page is read", async () => {
    stubRepository({
      files: {
        "_quarto.yml": BOOK_CONFIG.replace(
          "license: CC BY-SA 4.0",
          "license: All rights reserved",
        ),
      },
    });
    const res = await run();
    assert.equal(res.statusCode, 403);
    assert.match(res.body.data.error, /all rights reserved/i);
    assert.ok(!fetched.some((url) => /\.qmd$/.test(url)));
  });

  test("a license file that reserves all rights is refused", async () => {
    stubRepository({
      files: {
        "_quarto.yml": NO_LICENSE_CONFIG,
        LICENSE: "Copyright (c) 2024 Someone. All rights reserved.\n",
      },
    });
    assert.equal((await run()).statusCode, 403);
  });

  test("a page that reserves all rights refuses the import", async () => {
    stubRepository({
      files: {
        "preface.qmd": "---\nlicense: all-rights-reserved\n---\n\nText.\n",
      },
    });
    assert.equal((await run()).statusCode, 403);
  });

  test("a software license in the license file is applied and flagged for review", async () => {
    stubRepository({
      files: {
        "_quarto.yml": NO_LICENSE_CONFIG,
        "LICENSE.md":
          "MIT License\n\nCopyright (c) 2024 Someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software\n",
      },
    });
    const res = await run();
    assert.equal(res.body.data.site.license, "mit");
    assert.deepEqual(warningCodes(res), ["license:from-file"]);
    assert.match(
      itemBySlug(res.body.data.items, "basics/setup").contents,
      /license="mit"/,
    );
  });

  test("a project file can state a software license, by SPDX name or as a map", async () => {
    stubRepository({
      files: {
        "_quarto.yml": BOOK_CONFIG.replace(
          "license: CC BY-SA 4.0",
          "license: Apache-2.0",
        ),
      },
    });
    assert.equal((await run()).body.data.site.license, "apache-2.0");
    stubRepository({
      files: {
        "_quarto.yml": BOOK_CONFIG.replace(
          "license: CC BY-SA 4.0",
          "license:\n  text: Some text\n  url: https://creativecommons.org/publicdomain/zero/1.0/",
        ),
      },
    });
    const res = await run();
    assert.equal(res.body.data.site.license, "cc0");
    assert.deepEqual(warningCodes(res), []);
  });

  test("a Creative Commons license at another version is reported, not relabeled", async () => {
    stubRepository({
      files: {
        "_quarto.yml": BOOK_CONFIG.replace(
          "license: CC BY-SA 4.0",
          "license: CC BY-SA 3.0",
        ),
      },
    });
    const res = await run();
    assert.equal(res.body.data.site.license, null);
    assert.deepEqual(warningCodes(res), ["license:unrecognized"]);
    assert.match(res.body.data.warnings[0].message, /CC BY-SA 3\.0/);
    assert.doesNotMatch(
      itemBySlug(res.body.data.items, "basics/setup").contents,
      /license-element/,
    );
  });

  test("a license file that cannot be identified is reported as unrecognized", async () => {
    stubRepository({
      files: {
        "_quarto.yml": NO_LICENSE_CONFIG,
        LICENSE: "You may look at this but not touch it.\n",
      },
    });
    const res = await run();
    assert.equal(res.body.data.site.license, null);
    assert.deepEqual(warningCodes(res), ["license:unrecognized"]);
  });

  test("a repository with no license says so", async () => {
    stubRepository({ files: { "_quarto.yml": NO_LICENSE_CONFIG } });
    const res = await run();
    assert.equal(res.body.data.site.license, null);
    assert.deepEqual(warningCodes(res), ["license:not-found"]);
  });

  test("an unreadable license file is the same as none", async () => {
    stubRepository({
      files: { "_quarto.yml": NO_LICENSE_CONFIG, LICENSE: "x" },
      removed: {},
    });
    const original = safeFetchMod.safeFetch;
    safeFetchMod.safeFetch = async function (url, options) {
      if (/\/LICENSE$/.test(url)) {
        throw new Error("boom");
      }
      return original(url, options);
    };
    const res = await run();
    assert.deepEqual(warningCodes(res), ["license:not-found"]);
  });

  test("the license file beside the project file is preferred, then the repository root", async () => {
    stubRepository({
      only: true,
      files: {
        "book/_quarto.yml": NO_LICENSE_CONFIG,
        "book/index.qmd": "# Home\n\nHi.\n",
        "book/LICENSE": "Creative Commons Attribution 4.0 International",
        LICENSE:
          "Permission is hereby granted, free of charge, to any person obtaining a copy",
      },
    });
    assert.equal((await run()).body.data.site.license, "by");
    stubRepository({
      only: true,
      files: {
        "book/_quarto.yml": NO_LICENSE_CONFIG,
        "book/index.qmd": "# Home\n\nHi.\n",
        LICENSE:
          "Permission is hereby granted, free of charge, to any person obtaining a copy",
      },
    });
    assert.equal((await run()).body.data.site.license, "mit");
  });

  test("a page license in front matter that cannot be applied falls back to the site license", async () => {
    stubRepository({
      files: {
        "preface.qmd": "---\nlicense: CC BY 3.0\n---\n\nText.\n",
      },
    });
    const res = await run();
    const preface = itemBySlug(res.body.data.items, "preface");
    assert.equal(preface.metadata.quarto.license, "by-sa");
  });

  // --- callouts, divs and chunks --------------------------------------------

  test("a callout becomes a stop-note titled by its first heading, with its content rendered", async () => {
    stubRepository();
    const setup = itemBySlug((await run()).body.data.items, "basics/setup");
    assert.match(
      setup.contents,
      /<stop-note status="info" title="Heads up">\s*<div slot="message">\s*<p>Install the thing\.<\/p>\s*<\/div>\s*<\/stop-note>/,
    );
    assert.doesNotMatch(setup.contents, /<h2>Heads up<\/h2>/);
  });

  test("callout types map onto stop-note statuses, a title attribute wins, and an untitled callout takes its type", async () => {
    const body =
      '::: {.callout-warning title="Careful"}\nW.\n:::\n\n::: {.callout-tip}\nT.\n:::\n\n:::: callout-important\nI.\n::::\n\n::: {.callout-caution}\nC.\n:::\n';
    stubRepository({ files: { "preface.qmd": body } });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.match(contents, /<stop-note status="warning" title="Careful">/);
    assert.match(contents, /<stop-note status="success" title="Tip">/);
    assert.match(contents, /<stop-note status="stop" title="Important">/);
    assert.match(contents, /<stop-note status="warning" title="Caution">/);
  });

  test("nested fenced divs keep their classes and ids and close in order", async () => {
    const body =
      "::::: {#outer .columns}\n::: {.column width=50%}\nLeft.\n:::\n::: {.column}\nRight.\n:::\n:::::\n";
    stubRepository({ files: { "preface.qmd": body } });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.match(contents, /<div id="outer" class="columns">/);
    assert.equal((contents.match(/<div class="column">/g) || []).length, 2);
    assert.equal((contents.match(/<\/div>/g) || []).length, 3);
    assert.doesNotMatch(contents, /:::/);
  });

  test("content-visible and content-hidden follow the html output", async () => {
    stubRepository();
    const about = itemBySlug((await run()).body.data.items, "about-the-author");
    assert.doesNotMatch(about.contents, /PDF only/);
    assert.match(about.contents, /HTML only/);
  });

  test("executable chunks become code in their language with their options dropped", async () => {
    stubRepository();
    const res = await run();
    const setup = itemBySlug(res.body.data.items, "basics/setup");
    assert.match(
      setup.contents,
      /<pre><code class="language-r">x &lt;- 1\n<\/code><\/pre>/,
    );
    assert.doesNotMatch(setup.contents, /#\|/);
    assert.doesNotMatch(setup.contents, /hidden/);
    assert.deepEqual(
      res.body.data.unmappedComponents.filter(
        (name) => name === "code-outputs",
      ),
      ["code-outputs"],
    );
  });

  test("a chunk with knitr header options is read the same way", async () => {
    const body =
      "```{r, echo=FALSE}\nsecret <- 1\n```\n\n```{r setup, eval=FALSE}\nshown <- 2\n```\n";
    stubRepository({ files: { "preface.qmd": body } });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.doesNotMatch(contents, /secret/);
    assert.match(contents, /shown &lt;- 2/);
  });

  test("a plain pandoc code block and a diagram chunk are not outputs to compute", async () => {
    const body =
      "```{.python .numberLines}\nprint(1)\n```\n\n```{mermaid}\ngraph TD;\n```\n\n```text\nplain\n```\n";
    stubRepository({
      only: true,
      files: {
        "_quarto.yml":
          "project:\n  type: book\nbook:\n  chapters:\n    - index.qmd\n",
        "index.qmd": body,
      },
    });
    const res = await run();
    const contents = res.body.data.items[0].contents;
    assert.match(contents, /language-python/);
    assert.match(contents, /language-mermaid/);
    assert.match(contents, /language-text/);
    assert.deepEqual(res.body.data.unmappedComponents, []);
  });

  test("raw html blocks keep their content and other raw blocks are dropped", async () => {
    const body =
      "```{=html}\n<p>kept raw</p>\n```\n\n```{=latex}\n\\newpage\n```\n";
    stubRepository({ files: { "preface.qmd": body } });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.match(contents, /<p>kept raw<\/p>/);
    assert.doesNotMatch(contents, /newpage/);
  });

  test("div and shortcode syntax inside a code block is left alone", async () => {
    const body =
      "```markdown\n::: {.callout-note}\nNot a callout\n:::\n{{< video x.mp4 >}}\n```\n";
    stubRepository({ files: { "preface.qmd": body } });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.doesNotMatch(contents, /stop-note/);
    assert.match(contents, /::: \{\.callout-note\}/);
    assert.match(contents, /\{\{&lt; video|\{\{< video/);
  });

  // --- shortcodes and includes ---------------------------------------------

  test("a video shortcode becomes a video-player", async () => {
    stubRepository();
    const contents = itemBySlug(
      (await run()).body.data.items,
      "basics/first-steps",
    ).contents;
    assert.match(
      contents,
      /<video-player source="https:\/\/www\.youtube\.com\/watch\?v=abc" media-title="Demo"><\/video-player>/,
    );
  });

  test("an include is expanded without its front matter, and other shortcodes are reported", async () => {
    stubRepository();
    const res = await run();
    const appendix = itemBySlug(res.body.data.items, "a1-install");
    assert.match(appendix.contents, /Shared text\./);
    assert.doesNotMatch(appendix.contents, /ignored|\{\{/);
    assert.deepEqual(res.body.data.unmappedComponents, [
      "code-outputs",
      "cross-references",
      "shortcode:brand",
    ]);
  });

  test("includes nest to a bounded depth", async () => {
    stubRepository({
      files: {
        "preface.qmd": "{{< include _a.qmd >}}\n",
        "_a.qmd": "A\n\n{{< include _b.qmd >}}\n",
        "_b.qmd": "B\n\n{{< include _c.qmd >}}\n",
        "_c.qmd": "C\n\n{{< include _d.qmd >}}\n",
        "_d.qmd": "D\n",
      },
    });
    const res = await run();
    const contents = itemBySlug(res.body.data.items, "preface").contents;
    assert.match(contents, /<p>A<\/p>/);
    assert.match(contents, /<p>C<\/p>/);
    assert.doesNotMatch(contents, /<p>D<\/p>/);
    assert.equal(res.body.data.truncated, true);
  });

  test("the include count is capped", async () => {
    LIMITS.maxIncludes = 1;
    stubRepository({
      files: {
        "preface.qmd": "{{< include _a.qmd >}}\n\n{{< include _b.qmd >}}\n",
        "_a.qmd": "Alpha\n",
        "_b.qmd": "Beta\n",
      },
    });
    const res = await run();
    const contents = itemBySlug(res.body.data.items, "preface").contents;
    assert.match(contents, /Alpha/);
    assert.doesNotMatch(contents, /Beta/);
    assert.equal(res.body.data.truncated, true);
  });

  // --- inline syntax -----------------------------------------------------------

  test("image attributes give the alt text, links and spans lose their attribute blocks", async () => {
    stubRepository();
    const items = (await run()).body.data.items;
    assert.match(
      itemBySlug(items, "preface").contents,
      /<media-image source="files\/widget\.png" alt="A blue widget"><\/media-image>/,
    );
    const about = itemBySlug(items, "about-the-author").contents;
    assert.match(about, /<span class="mark">marked text<\/span>/);
    assert.match(about, /<a href="https:\/\/example\.com">link<\/a>/);
    assert.doesNotMatch(about, /\{target/);
  });

  test("a figure caption is the alt text when no fig-alt is given", async () => {
    stubRepository({
      files: { "preface.qmd": "![Caption text](images/widget.png){#fig-x}\n" },
    });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.match(contents, /alt="Caption text"/);
  });

  test("a figure caption holding inline code still loses its attribute block", async () => {
    stubRepository({
      files: {
        "preface.qmd":
          "![`plot` draws points.](images/widget.png){#fig-x}\n\nUse `![a](b){c}` literally.\n",
      },
    });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.doesNotMatch(contents, /\{#fig-x\}/);
    assert.match(contents, /<media-image/);
    assert.match(contents, /<code>!\[a\]\(b\)\{c\}<\/code>/);
  });

  test("a captioned table keeps its caption without the attribute block", async () => {
    stubRepository({
      files: {
        "preface.qmd":
          "| a | b |\n|---|---|\n| 1 | 2 |\n\n: Operators in use {#tbl-ops}\n\nAfter.\n",
      },
    });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.doesNotMatch(contents, /\{#tbl-ops\}/);
    assert.match(contents, /<em>Operators in use<\/em>/);
  });

  test("heading attribute blocks are dropped from section headings", async () => {
    stubRepository({
      files: {
        "preface.qmd": "Intro.\n\n## Why {#sec-why .unnumbered}\n\nBody.\n",
      },
    });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.match(contents, /<h2>Why<\/h2>/);
  });

  test("cross-references keep a readable key and are reported", async () => {
    stubRepository();
    const res = await run();
    const preface = itemBySlug(res.body.data.items, "preface").contents;
    assert.match(preface, /See fig-widget and sec-setup\./);
    assert.doesNotMatch(preface, /@fig-widget/);
    assert.ok(
      res.body.data.unmappedComponents.indexOf("cross-references") > -1,
    );
  });

  test("an email address and a literal @ in code are not cross-references", async () => {
    stubRepository({
      files: {
        "preface.qmd": "Write to a@sec-b.example or use `@fig-x` here.\n",
      },
    });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.match(contents, /a@sec-b\.example/);
    assert.match(contents, /<code>@fig-x<\/code>/);
  });

  test("pandoc footnotes render", async () => {
    stubRepository({
      files: { "preface.qmd": "Claim.[^1]\n\n[^1]: The note.\n" },
    });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.match(contents, /footnote/);
    assert.match(contents, /The note\./);
  });

  // --- links, media and assets -------------------------------------------------

  test("links to other pages point at their imported slugs, source or rendered", async () => {
    stubRepository();
    const setup = itemBySlug(
      (await run()).body.data.items,
      "basics/setup",
    ).contents;
    assert.match(setup, /href="basics\/first-steps#sec-go"/);
    assert.match(setup, /href="a1-install"/);
  });

  test("links resolve relative to the page that carries them", async () => {
    stubRepository({
      files: {
        "chapters/one.qmd": "[sibling](two.qmd) and [up](../preface.qmd)\n",
      },
    });
    const one = itemBySlug(
      (await run()).body.data.items,
      "going-further/one",
    ).contents;
    assert.match(one, /href="going-further\/two"/);
    assert.match(one, /href="preface"/);
  });

  test("a link to a file the project carries joins the file map, one it does not is absolutized", async () => {
    stubRepository({
      files: {
        "preface.qmd": "[data](data/table.csv) and [gone](data/gone.csv)\n",
        "data/table.csv": "a,b",
      },
    });
    const res = await run();
    const contents = itemBySlug(res.body.data.items, "preface").contents;
    assert.match(contents, /href="files\/table\.csv"/);
    assert.match(
      contents,
      /href="https:\/\/raw\.githubusercontent\.com\/example-org\/widgets-book\/main\/data\/gone\.csv"/,
    );
    assert.equal(
      res.body.data.files["files/table.csv"],
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/data/table.csv`,
    );
  });

  test("images join the file map under unique names, other kinds keep a source URL", async () => {
    stubRepository({
      files: {
        "preface.qmd":
          "![a](images/widget.png)\n\n![b](more/widget.png)\n\n![c](images/diagram.svg)\n\n![d](/images/widget.png)\n",
        "more/widget.png": "PNG2",
      },
    });
    const res = await run();
    assert.deepEqual(Object.keys(res.body.data.files).sort(), [
      "files/widget-1.png",
      "files/widget.png",
    ]);
    const contents = itemBySlug(res.body.data.items, "preface").contents;
    assert.equal(
      (contents.match(/source="files\/widget\.png"/g) || []).length,
      2,
    );
    assert.match(contents, /source="files\/widget-1\.png"/);
    assert.match(
      contents,
      /<img src="https:\/\/raw\.githubusercontent\.com\/example-org\/widgets-book\/main\/images\/diagram\.svg"/,
    );
  });

  test("a remote image is left as it is", async () => {
    stubRepository({
      files: { "preface.qmd": "![remote](https://example.com/pic.png)\n" },
    });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.match(contents, /source="https:\/\/example\.com\/pic\.png"/);
  });

  test("the file map is capped", async () => {
    LIMITS.maxFiles = 1;
    stubRepository({
      files: {
        "preface.qmd": "![a](images/widget.png)\n\n![b](more/other.png)\n",
        "more/other.png": "PNG2",
      },
    });
    const res = await run();
    assert.deepEqual(Object.keys(res.body.data.files), ["files/widget.png"]);
    assert.equal(res.body.data.truncated, true);
  });

  // --- notebooks ----------------------------------------------------------------

  test("a notebook chapter reads its front matter, markdown cells and code cells", async () => {
    stubRepository();
    const res = await run();
    const notebook = itemBySlug(res.body.data.items, "notebook");
    assert.equal(notebook.title, "Notebook chapter");
    assert.match(notebook.contents, /<h2>Intro<\/h2>/);
    assert.match(notebook.contents, /Notebook text\./);
    assert.match(
      notebook.contents,
      /<code class="language-python">total = 1 \+ 1\ntotal\n<\/code>/,
    );
    assert.doesNotMatch(notebook.contents, /#\|/);
    assert.ok(res.body.data.unmappedComponents.indexOf("code-outputs") > -1);
  });

  test("a notebook that is not valid JSON becomes an empty page", async () => {
    stubRepository({ files: { "notebook.ipynb": "not json" } });
    const notebook = itemBySlug((await run()).body.data.items, "notebook");
    assert.equal(notebook.contents.indexOf("<h2"), -1);
  });

  // --- website projects ---------------------------------------------------------

  test("a website sidebar becomes the outline: sections, page sections, labels and auto entries", async () => {
    stubRepository({ only: true, files: WEBSITE_FILES });
    const res = await run();
    assert.equal(res.statusCode, 200);
    const items = res.body.data.items;
    assert.deepEqual(
      items.map((item) => [item.title, item.indent, item.order, item.slug]),
      [
        ["Home", 0, 0, "home"],
        ["Guides", 0, 1, "guides"],
        ["Install", 1, 0, "guides/install"],
        ["Using widgets", 1, 1, "guides/using-widgets"],
        ["Reference", 0, 2, "reference"],
        ["A API", 1, 0, "reference/a-api"],
        ["B API", 1, 1, "reference/b-api"],
      ],
    );
    assert.equal(res.body.data.filename, "Widget Docs");
  });

  test("a sidebar section keeps its label while its page supplies the content", async () => {
    stubRepository({ only: true, files: WEBSITE_FILES });
    const items = (await run()).body.data.items;
    const guides = itemBySlug(items, "guides");
    assert.equal(guides.title, "Guides");
    assert.match(guides.contents, /Guides start here/);
    assert.equal(
      guides.metadata.source,
      "https://docs.example.org/guides/overview.html",
    );
  });

  test("external links and pages the repository does not carry are not pages", async () => {
    stubRepository({ only: true, files: WEBSITE_FILES });
    const items = (await run()).body.data.items;
    assert.equal(itemByTitle(items, "Project site"), undefined);
    assert.equal(itemByTitle(items, "Missing"), undefined);
  });

  test("with no sidebar the navbar is the outline, and a menu is a page with children", async () => {
    const config = `project:
  type: website
website:
  navbar:
    left:
      - href: index.qmd
        text: Start
      - text: Docs
        menu:
          - href: guides/install.qmd
          - href: guides/use.qmd
            text: Use it
    right:
      - icon: github
        href: https://github.com/example-org/widgets-book
`;
    stubRepository({
      only: true,
      files: Object.assign({}, WEBSITE_FILES, { "_quarto.yml": config }),
    });
    const items = (await run()).body.data.items;
    assert.deepEqual(
      items.map((item) => [item.title, item.indent, item.order]),
      [
        ["Start", 0, 0],
        ["Docs", 0, 1],
        ["Install", 1, 0],
        ["Use it", 1, 1],
      ],
    );
  });

  // --- the file tree fallback ---------------------------------------------------

  test("with no outline, the pages on disk are imported, index first, skipping what Quarto skips", async () => {
    stubRepository({
      only: true,
      files: {
        "_quarto.yml": "project:\n  type: default\n  output-dir: docs\n",
        "index.qmd": "# Home\n",
        "zeta.qmd": "# Zeta\n",
        "alpha.md": "# Alpha\n",
        "guide/index.qmd": "# Guide\n",
        "README.md": "# Readme\n",
        "AGENTS.md": "# Agents\n",
        "_partial.qmd": "# Partial\n",
        ".hidden/page.qmd": "# Hidden\n",
        "docs/rendered.qmd": "# Output dir\n",
        "renv/library.qmd": "# Dependency\n",
        "page_files/x.qmd": "# Generated\n",
        "node_modules/pkg/readme.md": "# Dependency\n",
      },
    });
    const items = (await run()).body.data.items;
    assert.deepEqual(
      items.map((item) => item.metadata.quarto.path),
      ["index.qmd", "alpha.md", "zeta.qmd", "guide/index.qmd"],
    );
  });

  test("project.render narrows the pages and a ! entry removes some", async () => {
    stubRepository({
      only: true,
      files: {
        "_quarto.yml":
          'project:\n  type: default\n  render:\n    - "*.qmd"\n    - "!draft-*.qmd"\n',
        "a.qmd": "# A\n",
        "draft-b.qmd": "# B\n",
        "c.md": "# C\n",
      },
    });
    const items = (await run()).body.data.items;
    assert.deepEqual(
      items.map((item) => item.metadata.quarto.path),
      ["a.qmd"],
    );
  });

  test("an outline that names no readable pages falls back to the tree", async () => {
    stubRepository({
      files: {
        "_quarto.yml":
          "project:\n  type: book\nbook:\n  chapters:\n    - nowhere.qmd\n",
      },
    });
    const items = (await run()).body.data.items;
    assert.ok(items.length > 0);
    assert.equal(itemBySlug(items, "home").metadata.quarto.path, "index.qmd");
  });

  test("a project file that is not valid YAML, or uses aliases, is read as empty", async () => {
    stubRepository({
      files: { "_quarto.yml": "book: [unclosed\n  - x: : :\n" },
    });
    let res = await run();
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.data.items.length > 0);
    stubRepository({
      files: {
        "_quarto.yml":
          "base: &a\n  title: x\nproject:\n  type: book\nbook:\n  <<: *a\n",
      },
    });
    res = await run();
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.data.items.length > 0);
  });

  test("a project with no pages reports 422", async () => {
    stubRepository({
      only: true,
      files: {
        "_quarto.yml": "project:\n  type: default\n",
        "README.md": "# r\n",
      },
    });
    const res = await run();
    assert.equal(res.statusCode, 422);
    assert.match(res.body.data.error, /no pages to import/);
  });

  // --- unreadable pages and limits -----------------------------------------------

  test("a page that cannot be read links back to the source site", async () => {
    stubRepository({ unreadable: ["setup.qmd"] });
    const setup = itemBySlug((await run()).body.data.items, "basics/setup");
    assert.match(
      setup.contents,
      /<a href="https:\/\/example\.org\/widgets\/setup\.html">the source site<\/a>/,
    );
  });

  test("a page cap truncates with links to the source", async () => {
    LIMITS.maxPages = 2;
    stubRepository();
    const res = await run();
    assert.equal(res.body.data.truncated, true);
    const items = res.body.data.items;
    assert.match(
      itemBySlug(items, "preface").contents,
      /Preface|teaches widgets/,
    );
    assert.match(itemBySlug(items, "basics").contents, /the source site/);
  });

  test("the fetch budget truncates the same way", async () => {
    LIMITS.fetchBudgetSeconds = -1;
    stubRepository();
    const res = await run();
    assert.equal(res.body.data.truncated, true);
    assert.match(
      itemBySlug(res.body.data.items, "preface").contents,
      /the source site/,
    );
  });

  test("page bodies are fetched one at a time, with the configured delay", async () => {
    LIMITS.requestDelayMs = 5;
    stubRepository({
      only: true,
      files: {
        "_quarto.yml":
          "project:\n  type: book\nbook:\n  chapters:\n    - index.qmd\n    - a.qmd\n    - b.qmd\n",
        "index.qmd": "# I\n",
        "a.qmd": "# A\n",
        "b.qmd": "# B\n",
      },
    });
    const started = Date.now();
    await run();
    assert.ok(Date.now() - started >= 8);
  });

  // --- hostile input --------------------------------------------------------------

  test("script in a page is carried as text for the site's own sanitizer, never executed", async () => {
    stubRepository({
      files: {
        "preface.qmd": "Hello <script>globalThis.__quartoRan = true</script>\n",
      },
    });
    await run();
    assert.equal(globalThis.__quartoRan, undefined);
  });

  test("attribute values are escaped into the HTML the converter writes", async () => {
    stubRepository({
      files: {
        "preface.qmd":
          '::: {.callout-note title="a&quot;b<i>"}\nx\n:::\n\n![x](images/widget.png){fig-alt="q&quot;\\"><b>"}\n',
      },
    });
    const contents = itemBySlug(
      (await run()).body.data.items,
      "preface",
    ).contents;
    assert.doesNotMatch(contents, /title="a"b/);
    assert.doesNotMatch(contents, /<b>"/);
  });
});
