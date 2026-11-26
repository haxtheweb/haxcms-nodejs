/**
 * haxtheweb/issues#3431: start the site builder and the active theme loading
 * while the page is still being parsed.
 *
 * A modulepreload fetches only the file it names. The builder and the theme
 * each sit on a chain of imports the browser only discovers once something
 * imports them, and nothing did until the autoloader had loaded, waited for
 * DOMContentLoaded, read the registry and found <haxcms-site-builder>; the
 * theme waited further, for the builder to be defined and site.json applied.
 * Importing both entries here starts both chains at once. They are the same
 * module URLs the autoloader and build-haxcms.js resolve, so nothing loads
 * twice, and a failure here is ignored: the normal boot (with its CDN
 * fallback) still runs.
 *
 * Invariants:
 * - Only a registry path (@scope/package/file.js) or a site's own
 *   ./custom/build/ file is ever imported; anything else from site.json is
 *   dropped. Neither can contain a quote, backslash, "<" or "..".
 * - Registry modules come from globalThis.__appCDN, the place the CDN check
 *   chose, else from the base the page's loader uses. A base that is not
 *   "./" or a plain http(s) URL ending in "/" means no script at all: a
 *   guess would load a second copy of every module.
 * - The custom build is skipped when globalThis.__appCustomEnv is set, as in
 *   build-haxcms.js.
 */
const SITE_BUILDER_ENTRY =
  "@haxtheweb/haxcms-elements/lib/core/haxcms-site-builder.js";
const REGISTRY_PATH =
  /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)*\.js$/i;
const CUSTOM_PATH = /^\.\/custom\/build\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)*\.js$/i;
// a base is "./" or an http(s) URL ending in "/" with no quote, "<" or space
const BASE_URL =
  /^(?:\.\/|https?:\/\/[a-z0-9.-]+(?::[0-9]+)?\/(?:[a-z0-9._~%-]+\/)*)$/i;

function bootImportPaths(themePath = "") {
  const registry = [SITE_BUILDER_ENTRY];
  let custom = "";
  const theme = String(themePath || "").replace(
    "@lrnwebcomponents/",
    "@haxtheweb/",
  );
  if (theme.indexOf("..") === -1) {
    if (REGISTRY_PATH.test(theme) && registry.indexOf(theme) === -1) {
      registry.push(theme);
    } else if (CUSTOM_PATH.test(theme)) {
      custom = theme;
    }
  }
  return { registry, custom };
}

function bootImportsMarkup(base = "./", themePath = "") {
  if (!BASE_URL.test(String(base))) {
    return "";
  }
  const safeBase = String(base);
  const { registry, custom } = bootImportPaths(themePath);
  // every value was matched against an allow-list above; JSON quoting then
  // gives plain "..." strings (no escapes for the managed-head pass to undo)
  let js =
    "(function(){var c=(globalThis.__appCDN||" +
    JSON.stringify(safeBase) +
    ')+"build/es6/node_modules/";' +
    JSON.stringify(registry) +
    ".forEach(function(p){import(c+p).catch(function(){});});";
  if (custom) {
    js +=
      "if(!globalThis.__appCustomEnv){import(" +
      JSON.stringify(custom) +
      ").catch(function(){});}";
  }
  js += "})();";
  return "  <script data-haxcms-boot>" + js + "</script>";
}

module.exports = {
  SITE_BUILDER_ENTRY,
  bootImportPaths,
  bootImportsMarkup,
};
