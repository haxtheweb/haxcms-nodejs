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
// - STATIC_HOST_LIVE_ONLY names the live-server files a static host must not
//   ship as they are; callers take those out of what they publish before
//   writing these entries, which include a static replacement where there
//   is one (llms.txt)

const fs = require("fs-extra");
const path = require("path");
const {
  replaceManagedHeadMarkup,
  replaceSiteBuilderContent,
} = require("./indexMarkup.js");
const { trimLeadingSlashes, trimTrailingSlashes } = require("./linearText.js");
const { resolveContainedPath } = require("./pathConfinement.js");

const STATIC_TEMPLATE = "ghpages.html";
const MAX_SLUG_LENGTH = 1024;
// the formats getPageAlternateLinkTags links from a page's head
const PAGE_VARIANT_FORMATS = ["html", "md", "json", "yaml", "xml"];
// Files the live server answers that describe routes a static host does not
// have: llms.txt links x/api/v1/site/export/html (renderStaticPages returns
// a static llms.txt), and .well-known/api-catalog advertises the x/api
// OpenAPI documents (a static host has no API, so it ships none).
const STATIC_HOST_LIVE_ONLY = Object.freeze([
  "llms.txt",
  ".well-known/api-catalog",
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
  const regionIds =
    typeof site.getThemeRegionItemIds === "function"
      ? site.getThemeRegionItemIds()
      : new Set();
  const isRendered = (item) =>
    item && isItemPublished(item) && !regionIds.has(String(item.id));

  async function renderPage(item, canonicalPath, pagePath) {
    let metadata = await site.getSiteMetadata(
      item || null,
      domain,
      "",
      canonicalPath,
    );
    if (domain === "") {
      metadata = dropRelativeAddresses(metadata);
    }
    let html = replaceManagedHeadMarkup(template, metadata, "");
    let content = "";
    if (item) {
      try {
        content = (await site.getPageContent(item)) || "";
      } catch {
        content = "";
      }
    }
    html = replaceSiteBuilderContent(html, staticPageBody(item, content));
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
    pages.push({
      path: filePath,
      html: await renderPage(item, basePath + "/" + pagePath, pagePath),
    });
    // the <slug>.<format> files this page's head links as alternates
    const variants = pageVariantFiles(site, item, pagePath);
    for (let v = 0; v < variants.length; v++) {
      if (!taken.has(variants[v].path)) {
        taken.add(variants[v].path);
        pages.push(variants[v]);
      }
    }
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
  STATIC_HOST_LIVE_ONLY,
  renderStaticPages,
  staticPagePath,
  staticPageBody,
  staticRouteScript,
};
