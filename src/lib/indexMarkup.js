// Shared markup helpers for the site index.html: putting the managed head
// (getSiteMetadata) and a page's content into the shell. The live page route
// (app.js) and the static page renderer (staticPages.js) both use them, so a
// statically published page and a served page come out the same.

// Security (SEC-HEADERS): the ONE pattern used both to stamp the
// per-request nonce (injectNonce) and to pre-mark untrusted page-content
// scripts (neutralizeUntrustedScriptNonces). Sharing it guarantees every tag
// injectNonce could stamp was already marked when it came from page content.
const INLINE_SCRIPT_OPEN_TAG_PATTERN = /<script((?:\s[^>]*)?)>/gi;

// Security (SEC-HEADERS): page HTML is read from disk and spliced
// into the served index BEFORE injectNonce runs. Without this, any literal
// <script> in a page file (legacy content, git/filesystem-synced sites,
// another backend's writes) would receive the real nonce and execute, so the
// nonce CSP would give no stored-XSS protection. Mark every script open tag
// in untrusted content with an empty nonce: it can never match the real
// nonce, and injectNonce skips tags that already carry a nonce attribute.
function neutralizeUntrustedScriptNonces(html = "") {
  return String(html || "").replace(
    INLINE_SCRIPT_OPEN_TAG_PATTERN,
    function (match, attrs) {
      var attrsStr = String(attrs || "");
      if (/\snonce\s*=/i.test(attrsStr)) {
        return match;
      }
      return "<script" + attrsStr + ' nonce="">';
    },
  );
}

function sanitizeManagedHeadMarkup(markup = "") {
  return String(markup || "").replace(/\\"/g, '"');
}

function replaceManagedHeadMarkup(
  indexFile = "",
  metadata = "",
  serviceWorkerScript = "",
) {
  const cleanMetadata = sanitizeManagedHeadMarkup(metadata);
  const cleanServiceWorkerScript =
    sanitizeManagedHeadMarkup(serviceWorkerScript);
  let managedHeadMarkup = cleanMetadata;
  if (cleanServiceWorkerScript !== "") {
    managedHeadMarkup += "\n" + cleanServiceWorkerScript + "\n";
  }
  let output = String(indexFile || "");
  const managedHeadPattern = /<meta charset[\s\S]*?(?=\s*<style[\s>])/i;
  if (managedHeadPattern.test(output)) {
    // Preserve <script> blocks (the base-href document.write setter and the
    // importmap) that sit between <meta charset> and <style>. The managed
    // metadata does not regenerate these, so without preservation they are
    // swallowed by the replacement. This regressed when <meta charset> was
    // moved to the top of <head> in the site boilerplate: the regex then
    // spans the base/importmap scripts instead of starting below them.
    // Without the base-href script no <base> tag is written, so relative
    // asset paths resolve against the document URL on sub-pages and 404.
    // Mirrors the PHP index.php template where getBaseTag() + the importmap
    // are separate parts ahead of the metadata.
    const matched = output.match(managedHeadPattern)[0];
    const scriptBlockPattern = /<script\b[\s\S]*?<\/script\b[^>]*>/gi;
    const preservedScripts = [];
    let scriptMatch;
    while ((scriptMatch = scriptBlockPattern.exec(matched)) !== null) {
      preservedScripts.push(scriptMatch[0]);
    }
    const preservedScriptsMarkup =
      preservedScripts.length > 0 ? preservedScripts.join("\n  ") + "\n  " : "";
    // haxtheweb/issues#3428: <meta charset> stays the first thing in <head>,
    // ahead of the preserved scripts. A browser only looks for it in the
    // first 1024 bytes; behind the base and CDN scripts it sat ~3 KB in, so
    // a host that sends no charset header made the browser guess and
    // re-parse the page. (PHP's template keeps it first already.)
    let charsetMarkup = "";
    let restMarkup = managedHeadMarkup;
    const charsetTag = /^\s*(<meta charset[^>]*>)/i.exec(managedHeadMarkup);
    if (charsetTag) {
      charsetMarkup = charsetTag[1] + "\n  ";
      restMarkup = managedHeadMarkup.substring(charsetTag[0].length);
    }
    // a function, so a "$" in the metadata is never read as a pattern
    output = output.replace(
      managedHeadPattern,
      () => charsetMarkup + preservedScriptsMarkup + restMarkup + "\n",
    );
    return output;
  }
  if (output.indexOf("</head>") !== -1) {
    output = output.replace("</head>", managedHeadMarkup + "\n</head>");
  }
  return output;
}

function replaceSiteBuilderContent(indexFile = "", pageContent = "") {
  const builderPattern =
    /<haxcms-site-builder([^>]*)>[\s\S]*?<\/haxcms-site-builder>/i;
  if (!builderPattern.test(indexFile)) {
    return indexFile;
  }
  // Security (SEC-HEADERS): page content is untrusted for CSP purposes; pre-mark its
  // scripts so the later injectNonce pass never authorizes them.
  const safeContent = neutralizeUntrustedScriptNonces(pageContent);
  // Replacer function (not a replacement string) so `$&`, `$1`, `` $` `` or
  // `$'` sequences inside page content are inserted literally instead of
  // being expanded into other parts of the template.
  return String(indexFile || "").replace(
    builderPattern,
    function (match, builderAttrs) {
      return (
        "<haxcms-site-builder" +
        builderAttrs +
        ">" +
        safeContent +
        "</haxcms-site-builder>"
      );
    },
  );
}

module.exports = {
  INLINE_SCRIPT_OPEN_TAG_PATTERN,
  neutralizeUntrustedScriptNonces,
  sanitizeManagedHeadMarkup,
  replaceManagedHeadMarkup,
  replaceSiteBuilderContent,
};
