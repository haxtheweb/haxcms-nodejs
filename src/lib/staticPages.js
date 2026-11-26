// Static page renderer: the HTML a static host serves for a site.
//
// The live page route renders every request with the site's metadata (title,
// description, canonical, social cards, JSON-LD) and the page's content in
// the shell. A static host has no server, so a site published to Surge,
// GitHub Pages, Netlify, Vercel or from haxcms-browser shipped the bare
// ghpages.html shell instead: no description, the title "HAXcms", no text for
// anything that reads the page without running JavaScript (search and AI
// crawlers, agents), and deep links that only work through 404.html's
// JavaScript redirect.
//
// renderStaticPages() produces the same output the live route gives, for the
// home page (index.html) and for every published page (<slug>/index.html),
// so each URL is a real file with its own metadata and text
// (haxtheweb/issues#3327). It only returns { path, html } entries: callers
// (the HAX CLI static publish, haxcms-browser's packer) decide where they go.
//
// Invariants:
// - nothing is written and the site is never changed
// - only pages an anonymous visitor may see are rendered (published, not
//   theme-region content); private sites render nothing
// - a page whose path would land on a file or folder the site already has
//   (files/, pages/, assets/, ...) or that is not a plain relative path is
//   skipped, so publishing never replaces site files
// - page content goes through the same helpers as the live route
//   (replaceSiteBuilderContent), and the page title is escaped
// - the shell's own scripts are kept; a page in a folder adds one script
//   that sets the site's base before the shell's base script runs, so the
//   page finds the site's files at any depth and on any host
// - every address the output links is a file in the output: each rendered
//   page's alternate formats (<slug>.md, .json, ...) are copied from the
//   page's own sidecar files, the way the live route answers them, and
//   llms.txt is the static-host copy (no x/api routes)
// - <slug>.html is the rendered page itself, never the raw content the live
//   route answers at that address: static hosts (GitHub Pages, Vercel with
//   clean URLs) answer /<slug> with <slug>.html, so the page's own address
//   serves the page with a 200 instead of a redirect to /<slug>/. Static
//   pages link no text/html alternate for the same reason.
// - STATIC_HOST_LIVE_ONLY names the live-server files a static host must not
//   ship as they are; callers take those out of what they publish before
//   writing these entries, which include a static replacement where there
//   is one (llms.txt)
// - every rendered page declares the public WebMCP tools as plain forms
//   (toolname/tooldescription, the declarative WebMCP API): search_site, and
//   remix_site when the site's license allows derivatives and its address is
//   known. Nothing runs; they work without JavaScript and are what an agent
//   or scanner reading the HTML finds. The front end removes them when it
//   boots and registers the same tools itself (HAXCMSWebMCP.js).
// - the search page the search form opens (x/displays/search) is published
//   as a page too, so it answers 200 on a static host

const fs = require("fs-extra");
const path = require("path");
const {
  replaceManagedHeadMarkup,
  replaceSiteBuilderContent,
} = require("./indexMarkup.js");
const { trimLeadingSlashes, trimTrailingSlashes } = require("./linearText.js");
const { resolveContainedPath } = require("./pathConfinement.js");
const { getLicense } = require("./licenses.js");

const STATIC_TEMPLATE = "ghpages.html";
const MAX_SLUG_LENGTH = 1024;
// the formats getPageAlternateLinkTags links from a page's head that a
// static publish copies; html is left out (<slug>.html is the page itself)
const PAGE_VARIANT_FORMATS = ["md", "json", "yaml", "xml"];
// the raw-content text/html alternate getPageAlternateLinkTags writes
const HTML_ALTERNATE_LINK =
  /[ \t]*<link rel="alternate" type="text\/html" href="[^"]*" \/>\n?/g;
// Files the live server answers that describe routes a static host does not
// have: llms.txt links x/api/v1/site/export/html (renderStaticPages returns
// a static llms.txt), and .well-known/api-catalog advertises the x/api
// OpenAPI documents (a static host has no API, so it ships none).
const STATIC_HOST_LIVE_ONLY = Object.freeze([
  "llms.txt",
  ".well-known/api-catalog",
]);
// the front end's search route; the search_site form opens it
const SEARCH_ROUTE = "x/displays/search";
// where remix_site opens a copy of the site: HAXcms in the browser, which
// imports a published HAX site from its address (haxcms-browser ?remix=)
const REMIX_APP = "https://browser.hax.cloud/";
// licenses that keep others from making a derivative; any other license on
// HAX's list allows a remix (the same rule as HAXCMSWebMCP.js remixTerms)
const NO_DERIVATIVES = Object.freeze([
  "by-nd",
  "by-nc-nd",
  "all-rights-reserved",
]);

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isAbsoluteHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\/[^/\s]+/i.test(value);
}

// the path part of the site's address, without a trailing "/"
// ("https://org.github.io/repo/" -> "/repo", "https://example.com" -> "")
function domainBasePath(domain) {
  if (!isAbsoluteHttpUrl(domain)) {
    return "";
  }
  try {
    return trimTrailingSlashes(new URL(domain).pathname);
  } catch {
    return "";
  }
}

/**
 * The folder path a page is published at, or "" when its slug can't be a
 * folder: empty, absolute, with "." or ".." parts, a part starting with "."
 * (static hosts and publishers drop dot folders), backslashes, characters a
 * URL path or file name can't carry, or longer than MAX_SLUG_LENGTH.
 */
function staticPagePath(slug) {
  if (typeof slug !== "string") {
    return "";
  }
  const clean = trimTrailingSlashes(trimLeadingSlashes(slug));
  if (clean === "" || clean.length > MAX_SLUG_LENGTH) {
    return "";
  }
  if (/[\\?#%:*"<>|\u0000-\u001f\u007f]/.test(clean)) {
    return "";
  }
  const parts = clean.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "" || parts[i].charAt(0) === ".") {
      return "";
    }
  }
  return clean;
}

/**
 * Script for a page in a folder: the site's base is the page's address
 * without the page's slug, so it is set before the shell's own base script
 * runs (a document uses its first <base>). The address is also put in the
 * form the site router uses (no trailing "/" or "index.html"), so a host that
 * answers /slug with /slug/ still opens the page.
 */
function staticRouteScript(pagePath) {
  // JSON keeps it a plain string; "<" is escaped so it can't end the script.
  // Compared with the decoded address: browsers leave some characters
  // (&, =, +, ...) unescaped in a path that encodeURIComponent escapes.
  const route = JSON.stringify("/" + pagePath).replace(/</g, "\\u003c");
  return `<script data-haxcms-static-route>
    (function () {
      var route = ${route};
      var pathname = globalThis.location.pathname;
      try {
        pathname = decodeURIComponent(pathname);
      } catch (e) {}
      if (pathname.substring(pathname.length - 11) === "/index.html") {
        pathname = pathname.substring(0, pathname.length - 11);
      }
      while (pathname.charAt(pathname.length - 1) === "/") {
        pathname = pathname.substring(0, pathname.length - 1);
      }
      if (pathname.length < route.length || pathname.substring(pathname.length - route.length) !== route) {
        return;
      }
      var base = document.createElement("base");
      base.setAttribute("href", pathname.substring(0, pathname.length - route.length) + "/");
      document.head.appendChild(base);
      var raw = globalThis.location.pathname;
      if ((raw.charAt(raw.length - 1) === "/" || raw.substring(raw.length - 11) === "/index.html") && globalThis.history && globalThis.history.replaceState) {
        globalThis.history.replaceState(globalThis.history.state, "", pathname + globalThis.location.search + globalThis.location.hash);
      }
    })();
  </script>`;
}

// the shell's base and CDN scripts come first in <head> (the managed head
// keeps them ahead of the metadata), so the route script goes before them
function insertBeforeShellScripts(html, markup) {
  const head = /<head[^>]*>/i.exec(html);
  if (!head) {
    return html;
  }
  const headEnd = html.indexOf("</head>", head.index);
  const firstScript = html.indexOf("<script", head.index);
  if (firstScript !== -1 && (headEnd === -1 || firstScript < headEnd)) {
    return (
      html.substring(0, firstScript) +
      markup +
      "\n  " +
      html.substring(firstScript)
    );
  }
  const at = head.index + head[0].length;
  return html.substring(0, at) + "\n  " + markup + html.substring(at);
}

// haxtheweb/issues#3428: a shell whose template has the
// data-haxcms-cdn-preloads script gives each preload hint its address after
// the head is read, from the place the shell chose for build/ (this site or
// the CDN). The managed head's hints for build/ and wc-registry.json move
// their path to data-haxcms-cdn-href so the browser doesn't fetch them from
// ./ first, which 404s on a host that doesn't ship build/.
const CDN_PRELOADS_MARKER = "data-haxcms-cdn-preloads";

function deferShellPreloads(metadata) {
  return String(metadata).replace(/<link [^>]*>/g, (tag) => {
    if (
      tag.indexOf(' rel="modulepreload"') === -1 &&
      tag.indexOf(' rel="preload"') === -1
    ) {
      return tag;
    }
    const at = tag.indexOf(' href="./');
    if (at === -1) {
      return tag;
    }
    const end = tag.indexOf('"', at + 7);
    if (end === -1) {
      return tag;
    }
    const href = tag.substring(at + 7, end);
    if (href.indexOf("./build/") !== 0 && href !== "./wc-registry.json") {
      return tag;
    }
    return (
      tag.substring(0, at) +
      ' data-haxcms-cdn-href="' +
      href +
      '"' +
      tag.substring(end + 1)
    );
  });
}

// haxtheweb/issues#3429: site:build-static knows where build/ comes from
// (its output ships a real build/, or it relies on the CDN), so it can write
// that answer in place of the shell's check, a synchronous HEAD request that
// blocked every page load. Accepted: "./" or a plain https base ending in "/".
const CDN_CHECK = /<script data-haxcms-cdn-check>[\s\S]*?<\/script>/;
const CDN_PRELOADS_SCRIPT =
  /\s*<script data-haxcms-cdn-preloads>[\s\S]*?<\/script>/;

function validStaticCdn(cdn) {
  if (cdn === "./") {
    return cdn;
  }
  if (
    typeof cdn === "string" &&
    /^https:\/\/[a-z0-9.-]+(:[0-9]+)?\/([a-z0-9._~-]+\/)*$/i.test(cdn)
  ) {
    return cdn;
  }
  return null;
}

// the decided shell: where build/ comes from, and the import map that sends
// custom/build/'s @haxtheweb/* imports to the same place
function decidedCdnMarkup(cdn) {
  const map = {
    scopes: {
      "./custom/build/": {
        "@haxtheweb/": cdn + "build/es6/node_modules/@haxtheweb/",
      },
    },
  };
  return (
    "<script data-haxcms-cdn-check>globalThis.__appCDN = " +
    JSON.stringify(cdn) +
    ';</script>\n  <script type="importmap">' +
    JSON.stringify(map) +
    "</script>"
  );
}

// the managed head's hints for build/ and wc-registry.json, pointed straight
// at the decided place (the shell no longer moves them after the check)
function resolveShellPreloads(metadata, cdn) {
  return String(metadata).replace(/<link [^>]*>/g, (tag) => {
    if (
      tag.indexOf(' rel="modulepreload"') === -1 &&
      tag.indexOf(' rel="preload"') === -1
    ) {
      return tag;
    }
    const at = tag.indexOf(' href="./');
    if (at === -1) {
      return tag;
    }
    const end = tag.indexOf('"', at + 7);
    if (end === -1) {
      return tag;
    }
    const href = tag.substring(at + 7, end);
    if (href.indexOf("./build/") !== 0 && href !== "./wc-registry.json") {
      return tag;
    }
    return (
      tag.substring(0, at) +
      ' href="' +
      escapeHtml(cdn + href.substring(2)) +
      '"' +
      tag.substring(end + 1)
    );
  });
}

// a relative canonical or og:url points at the wrong page once the site sits
// under a path, so without an absolute address the page carries neither
function dropRelativeAddresses(metadata) {
  return String(metadata)
    .replace(/<link rel="canonical" href="(?!https?:\/\/)[^"]*" \/>/i, "")
    .replace(
      /<meta name="og:url" property="og:url" content="(?!https?:\/\/)[^"]*" \/>/i,
      "",
    );
}

/**
 * Page content in the shell: the page title as the document's heading
 * (themes render the title outside the content, so the content alone has no
 * h1) and the content, in <main>. The front end replaces all of it when it
 * boots, as it does on the live route.
 */
function staticPageBody(item, content) {
  const body = typeof content === "string" ? content : "";
  let heading = "";
  if (!/<h1[\s>]/i.test(body) && item && item.title) {
    heading = "<h1>" + escapeHtml(item.title) + "</h1>\n";
  }
  return "<main>\n" + heading + body + "\n</main>";
}

/**
 * Whether and on what terms a site's content may be remixed, from its
 * license code: { allowed, license: { code, name, link } | null,
 * conditions: [...] }. An unset or unknown license allows nothing.
 */
function remixTerms(code) {
  const license = getLicense(typeof code === "string" ? code.trim() : "");
  if (!license) {
    return { allowed: false, license: null, conditions: [] };
  }
  const conditions = [];
  if (/^by(-|$)/.test(license.code)) {
    conditions.push("attribution");
  }
  if (/(^|-)sa$/.test(license.code)) {
    conditions.push("share-alike");
  }
  if (/(^|-)nc(-|$)/.test(license.code)) {
    conditions.push("non-commercial");
  }
  return {
    allowed: !NO_DERIVATIVES.includes(license.code),
    license: { code: license.code, name: license.name, link: license.link },
    conditions,
  };
}

/**
 * The public WebMCP tools as declarative forms (toolname/tooldescription on
 * a <form>), placed after a page's content. search_site opens the site's
 * search page; remix_site opens browser.hax.cloud to import a copy, which
 * waits for the person to confirm. remix_site is left out without an
 * absolute site address or a license that allows derivatives.
 */
function agentToolForms(searchAction, siteUrl, terms) {
  let markup =
    '\n<aside aria-label="Site tools" data-haxcms-agent-tools>\n' +
    '<form role="search" method="get" action="' +
    escapeHtml(searchAction) +
    '" toolname="search_site" tooldescription="Search this site\'s pages by keyword and show the pages that match." toolautosubmit data-haxcms-agent-tool>\n' +
    '<label for="haxcms-tool-search">Search this site</label>\n' +
    '<input id="haxcms-tool-search" type="search" name="search" required toolparamdescription="Words to search for.">\n' +
    '<button type="submit">Search</button>\n' +
    "</form>\n";
  if (siteUrl !== "" && terms.allowed) {
    const conditions =
      terms.conditions.length > 0
        ? " (" + terms.conditions.join(", ") + ")"
        : "";
    markup +=
      '<form method="get" action="' +
      REMIX_APP +
      '" target="_blank" rel="noopener" toolname="remix_site" tooldescription="Open a copy of this site in HAX (browser.hax.cloud) to remix it. Nothing is made until the person confirms there; the copy is theirs, under this site\'s license." data-haxcms-agent-tool>\n' +
      '<input type="hidden" name="remix" value="' +
      escapeHtml(siteUrl) +
      '">\n' +
      '<button type="submit">Remix this site in HAX</button>\n' +
      '<p>Licensed <a href="' +
      escapeHtml(terms.license.link) +
      '" rel="license">' +
      escapeHtml(terms.license.name) +
      "</a>" +
      escapeHtml(conditions) +
      ".</p>\n" +
      "</form>\n";
  }
  return markup + "</aside>";
}

function readTemplate(site) {
  const candidates = [];
  if (site && site.siteDirectory) {
    candidates.push(path.join(site.siteDirectory, STATIC_TEMPLATE));
  }
  candidates.push(
    path.join(__dirname, "..", "boilerplate", "site", STATIC_TEMPLATE),
  );
  for (let i = 0; i < candidates.length; i++) {
    try {
      const stat = fs.lstatSync(candidates[i]);
      if (stat.isFile()) {
        return fs.readFileSync(candidates[i], "utf8");
      }
    } catch {
      // try the next one
    }
  }
  return "";
}

/**
 * Render the static pages for a loaded HAXCMSSite.
 *
 * options.domain: the address the site is published at (used when site.json
 * has no metadata.site.domain), e.g. "https://example.com/" or
 * "https://org.github.io/repo/". Without an absolute address the pages have
 * no canonical link or og:url.
 *
 * Returns [{ path, html }] (paths relative to the site folder, "/"
 * separated): "index.html" first, then one "<slug>/index.html" per page,
 * each followed by that page's "<slug>.<format>" alternate files, then
 * "llms.txt". `html` is the text to write for every entry.
 */
async function renderStaticPages(site, options = {}) {
  if (!site || !site.manifest || !Array.isArray(site.manifest.items)) {
    return [];
  }
  const settings =
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.settings
      ? site.manifest.metadata.site.settings
      : {};
  if (settings.private === true || settings.private === "true") {
    return [];
  }
  const template = readTemplate(site);
  if (template === "") {
    return [];
  }
  // lazy require: siteRouteUtils requires HAXCMS.js
  const { isItemPublished } = require("../siteRoutes/v1/siteRouteUtils.js");
  const siteDomain =
    site.manifest.metadata && site.manifest.metadata.site
      ? site.manifest.metadata.site.domain
      : "";
  // getSiteMetadata prefers the site's own domain, so the base path does too
  let domain = "";
  if (isAbsoluteHttpUrl(siteDomain)) {
    domain = siteDomain;
  } else if (isAbsoluteHttpUrl(options.domain)) {
    domain = options.domain;
  }
  const basePath = domainBasePath(domain);
  // where build/ comes from, when the caller knows (#3429); only a shell
  // that carries the marked check can take the answer
  const cdn = validStaticCdn(options.cdn);
  const decided = cdn !== null && CDN_CHECK.test(template);
  const regionIds =
    typeof site.getThemeRegionItemIds === "function"
      ? site.getThemeRegionItemIds()
      : new Set();
  const isRendered = (item) =>
    item && isItemPublished(item) && !regionIds.has(String(item.id));
  // the site's own address with a trailing "/", or "" when it is not known
  const siteUrl = domain === "" ? "" : trimTrailingSlashes(domain) + "/";
  const tools = agentToolForms(
    basePath + "/" + SEARCH_ROUTE,
    siteUrl,
    remixTerms(site.manifest.license),
  );

  async function renderPage(item, canonicalPath, pagePath, bodyContent) {
    let metadata = await site.getSiteMetadata(
      item || null,
      domain,
      "",
      canonicalPath,
    );
    if (domain === "") {
      metadata = dropRelativeAddresses(metadata);
    }
    if (decided) {
      metadata = resolveShellPreloads(metadata, cdn);
    } else if (template.indexOf(CDN_PRELOADS_MARKER) !== -1) {
      metadata = deferShellPreloads(metadata);
    }
    let html = replaceManagedHeadMarkup(
      template,
      String(metadata).replace(HTML_ALTERNATE_LINK, ""),
      "",
    );
    if (decided) {
      // the answer in place of the check, and nothing left to move
      html = html
        .replace(CDN_CHECK, () => decidedCdnMarkup(cdn))
        .replace(CDN_PRELOADS_SCRIPT, "");
    }
    let content = typeof bodyContent === "string" ? bodyContent : "";
    if (item) {
      try {
        content = (await site.getPageContent(item)) || "";
      } catch {
        content = "";
      }
    }
    html = replaceSiteBuilderContent(
      html,
      staticPageBody(item, content) + tools,
    );
    if (pagePath !== "") {
      html = insertBeforeShellScripts(html, staticRouteScript(pagePath));
    }
    return html;
  }

  const pages = [];
  const home = site.manifest.items[0];
  pages.push({
    path: "index.html",
    html: await renderPage(
      isRendered(home) ? home : null,
      basePath === "" ? "/" : basePath + "/",
      "",
    ),
  });
  const taken = new Set(["index.html"]);
  for (let i = 0; i < site.manifest.items.length; i++) {
    const item = site.manifest.items[i];
    if (!isRendered(item)) {
      continue;
    }
    const pagePath = staticPagePath(item.slug);
    if (pagePath === "") {
      continue;
    }
    const filePath = pagePath + "/index.html";
    if (taken.has(filePath)) {
      continue;
    }
    // never over a file or folder the site already has
    if (site.siteDirectory) {
      const top = pagePath.split("/")[0];
      if (fs.existsSync(path.join(site.siteDirectory, top))) {
        continue;
      }
    }
    taken.add(filePath);
    const rendered = await renderPage(
      item,
      basePath + "/" + pagePath,
      pagePath,
    );
    pages.push({ path: filePath, html: rendered });
    // the page at its own address: /<slug> is answered with <slug>.html
    const pageFile = pagePath + ".html";
    if (
      !taken.has(pageFile) &&
      !fs.existsSync(path.join(site.siteDirectory, pageFile))
    ) {
      taken.add(pageFile);
      pages.push({ path: pageFile, html: rendered });
    }
    // the <slug>.<format> files this page's head links as alternates
    const variants = pageVariantFiles(site, item, pagePath);
    for (let v = 0; v < variants.length; v++) {
      if (!taken.has(variants[v].path)) {
        taken.add(variants[v].path);
        pages.push(variants[v]);
      }
    }
  }
  // the search page the search_site form opens: a page at the front end's
  // search route, so the address answers 200 and the front end shows results
  const searchPath = SEARCH_ROUTE + "/index.html";
  const searchTop = path.join(site.siteDirectory, SEARCH_ROUTE.split("/")[0]);
  if (!taken.has(searchPath) && !fs.existsSync(searchTop)) {
    taken.add(searchPath);
    const searchPage = await renderPage(
      null,
      basePath + "/" + SEARCH_ROUTE,
      SEARCH_ROUTE,
      "<h1>Search</h1>",
    );
    pages.push({ path: searchPath, html: searchPage });
    // the form opens the address without a "/": answered with the page too
    taken.add(SEARCH_ROUTE + ".html");
    pages.push({ path: SEARCH_ROUTE + ".html", html: searchPage });
  }
  if (typeof site.getLLMSTxt === "function") {
    pages.push({
      path: "llms.txt",
      html: site.getLLMSTxt(domain, { staticHost: true }),
    });
  }
  return pages;
}

/**
 * The alternate formats a rendered page's head links (<link rel="alternate">
 * from getPageAlternateLinkTags, href "<slug>.<format>"), read from the page's
 * own sidecar files: [{ path: "<pagePath>.<format>", html }]. A sidecar that
 * is missing or outside the site is left out, and so is one whose path the
 * site already has a file or folder at.
 */
function pageVariantFiles(site, item, pagePath) {
  const files = [];
  if (
    !site ||
    !site.siteDirectory ||
    !item ||
    typeof item.location !== "string" ||
    typeof site.getPageAlternateLocation !== "function"
  ) {
    return files;
  }
  for (let i = 0; i < PAGE_VARIANT_FORMATS.length; i++) {
    const format = PAGE_VARIANT_FORMATS[i];
    const location = site.getPageAlternateLocation(item.location, format);
    if (!location) {
      continue;
    }
    const source = resolveContainedPath(site.siteDirectory, location);
    const filePath = pagePath + "." + format;
    try {
      if (
        source === false ||
        !fs.lstatSync(source).isFile() ||
        fs.existsSync(path.join(site.siteDirectory, filePath))
      ) {
        continue;
      }
      files.push({ path: filePath, html: fs.readFileSync(source, "utf8") });
    } catch {
      // no sidecar in this format
    }
  }
  return files;
}

module.exports = {
  validStaticCdn,
  deferShellPreloads,
  REMIX_APP,
  SEARCH_ROUTE,
  STATIC_HOST_LIVE_ONLY,
  remixTerms,
  renderStaticPages,
  staticPagePath,
  staticPageBody,
  staticRouteScript,
};
