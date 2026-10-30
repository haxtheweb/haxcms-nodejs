const fs = require("fs");
const path = require("path");

/**
 * Security (N1/N5 parity): path confinement helpers for page locations.
 *
 * Mirrors the PHP hardening in JSONOutlineSchemaItem.php (haxcmsPathWithinBase,
 * readLocation/writeLocation) and HAXCMSSite.php (resolvePageLocationRealPath,
 * recurseCopy). A page `location` comes from site.json (which an admin import
 * or a crafted request could poison) and must never resolve outside the site
 * directory it belongs to.
 */

/**
 * Strip trailing `/` characters in linear time (a `/\/+$/` regex backtracks
 * polynomially on long runs of slashes).
 */
function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end--;
  }
  return value.slice(0, end);
}

/**
 * Trailing-slash prefix check: is resolvedPath equal to, or inside of,
 * resolvedBase. Both arguments should already be canonical (realpath'd).
 */
function pathWithinBase(resolvedPath, resolvedBase) {
  const normalizedPath = trimTrailingSlashes(
    String(resolvedPath || "").replace(/\\/g, "/"),
  );
  const normalizedBase = trimTrailingSlashes(
    String(resolvedBase || "").replace(/\\/g, "/"),
  );
  if (normalizedPath === "" || normalizedBase === "") {
    return false;
  }
  if (normalizedPath === normalizedBase) {
    return true;
  }
  return normalizedPath.indexOf(normalizedBase + "/") === 0;
}

/**
 * true when the value contains a NUL byte or a `..` path segment
 * (either separator). This is the lexical pre-check PHP applies before
 * realpath containment.
 */
function hasTraversal(value) {
  if (typeof value !== "string") {
    return true;
  }
  if (value.indexOf("\0") !== -1) {
    return true;
  }
  return value.replace(/\\/g, "/").split("/").indexOf("..") !== -1;
}

/**
 * true when a value that is meant to be a site-relative path is unsafe:
 * not a string, contains NUL or a `..` segment (either separator), or is
 * absolute (leading slash/backslash or a drive letter). Remote URLs
 * (scheme://) are not file paths and are not judged here.
 */
function isUnsafeRelativePath(value) {
  if (typeof value !== "string") {
    return true;
  }
  // traversal first: a `..` segment or NUL is unsafe even in a value that
  // looks like a URL ("x://../.." would otherwise skip the check and, used
  // as a path, climb out of the target directory)
  if (hasTraversal(value)) {
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false;
  }
  return /^([\\/]|[a-z]:)/i.test(value);
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return false;
  }
}

/**
 * Resolve `location` relative to `basePath` and prove it stays inside it.
 *
 * - rejects non-string / empty locations, NUL bytes and any `..` segment
 * - when the target exists, its realpath must be inside realpath(basePath)
 *   (defeats symlinks planted inside the site dir)
 * - when it does not exist yet, the nearest existing ancestor's realpath
 *   must be inside realpath(basePath)
 *
 * @return string|false absolute (real when it exists) path, or false
 */
function resolveContainedPath(basePath, location) {
  if (typeof basePath !== "string" || basePath === "") {
    return false;
  }
  if (
    typeof location !== "string" ||
    location === "" ||
    hasTraversal(location)
  ) {
    return false;
  }
  const resolvedBase = safeRealpath(basePath);
  if (resolvedBase === false) {
    return false;
  }
  const candidate = path.join(basePath, location);
  // lexical containment first (path.join already normalized the string)
  if (!pathWithinBase(path.resolve(candidate), path.resolve(basePath))) {
    return false;
  }
  const resolved = safeRealpath(candidate);
  if (resolved !== false) {
    return pathWithinBase(resolved, resolvedBase) ? resolved : false;
  }
  // not created yet: walk up to the nearest existing ancestor and prove that
  // one is inside the base, so a symlinked intermediate dir cannot escape
  let ancestor = path.dirname(path.resolve(candidate));
  while (true) {
    const real = safeRealpath(ancestor);
    if (real !== false) {
      return pathWithinBase(real, resolvedBase)
        ? path.resolve(candidate)
        : false;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return false;
    }
    ancestor = parent;
  }
}

module.exports = {
  pathWithinBase,
  hasTraversal,
  isUnsafeRelativePath,
  resolveContainedPath,
};
