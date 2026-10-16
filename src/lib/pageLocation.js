const fs = require('fs-extra');
const path = require('path');

/**
 * Page location containment helpers.
 *
 * Security (review 2026-10): page locations (site.json `location`, or paths
 * built from a client-supplied node id) must never resolve outside the site
 * directory. Mirrors PHP haxcmsPathWithinBase /
 * JSONOutlineSchemaItem::readLocation / writeLocation and
 * HAXCMSSite::resolvePageLocationRealPath (N1/N5): reject NUL bytes and any
 * `..` segment lexically, then prove the realpath stays inside the realpath
 * of the base directory (prefix check with a trailing separator).
 */

function normalizeSeparators(value) {
  return String(value).replace(/\\/g, '/');
}

/**
 * True when resolvedPath equals resolvedBase or sits underneath it.
 * Mirrors PHP haxcmsPathWithinBase.
 */
function pathWithinBase(resolvedPath, resolvedBase) {
  const normalizedPath = normalizeSeparators(resolvedPath || '').replace(/\/+$/, '');
  const normalizedBase = normalizeSeparators(resolvedBase || '').replace(/\/+$/, '');
  if (normalizedPath === '' || normalizedBase === '') {
    return false;
  }
  if (normalizedPath === normalizedBase) {
    return true;
  }
  return normalizedPath.indexOf(normalizedBase + '/') === 0;
}

/**
 * Lexical reject: non-string, empty, NUL byte, or any `..` segment
 * (after normalizing backslashes). Mirrors PHP's `../` / `/..` check and
 * additionally rejects a bare `..`.
 */
function hasUnsafeLocationSyntax(location) {
  if (typeof location !== 'string' || location === '') {
    return true;
  }
  if (location.indexOf('\0') !== -1) {
    return true;
  }
  const normalized = normalizeSeparators(location);
  if (
    normalized === '..' ||
    normalized.indexOf('../') !== -1 ||
    normalized.indexOf('/..') !== -1
  ) {
    return true;
  }
  return false;
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  }
  catch (e) {
    return false;
  }
}

/**
 * Realpath of the closest existing ancestor of target (inclusive) joined with
 * the not-yet-existing remainder. Lets us prove containment for paths that are
 * about to be created even when an existing parent is a symlink.
 */
function resolveThroughExistingAncestor(target) {
  let current = path.resolve(target);
  const remainder = [];
  while (true) {
    const real = safeRealpath(current);
    if (real !== false) {
      return remainder.length ? path.join(real, ...remainder.reverse()) : real;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    remainder.push(path.basename(current));
    current = parent;
  }
}

/**
 * Resolve a site-relative page location against basePath and prove it stays
 * inside basePath.
 *
 * @param {string} basePath site directory
 * @param {string} location site-relative location (e.g. pages/x/index.html)
 * @param {object} options
 *   - mustExist (default true): when the target does not exist return false
 *     (read semantics, mirrors resolvePageLocationRealPath). When false the
 *     target may be missing (write semantics) and containment is proven via
 *     the closest existing ancestor.
 * @return {string|false} absolute path that is safe to use, or false
 */
function resolvePageLocation(basePath, location, options = {}) {
  const mustExist = options.mustExist !== false;
  if (typeof basePath !== 'string' || basePath === '' || basePath.indexOf('\0') !== -1) {
    return false;
  }
  if (hasUnsafeLocationSyntax(location)) {
    return false;
  }
  const resolvedBase = safeRealpath(basePath);
  if (resolvedBase === false) {
    return false;
  }
  const candidate = path.join(basePath, location);
  if (fs.existsSync(candidate)) {
    const resolved = safeRealpath(candidate);
    if (resolved === false || !pathWithinBase(resolved, resolvedBase)) {
      return false;
    }
    return resolved;
  }
  if (mustExist) {
    return false;
  }
  const resolved = resolveThroughExistingAncestor(candidate);
  if (resolved === false || !pathWithinBase(resolved, resolvedBase)) {
    return false;
  }
  return candidate;
}

/**
 * Validate an absolute destination directory that is about to be created
 * (e.g. recurseCopy of page boilerplate) sits strictly inside basePath.
 * Mirrors PHP HAXCMSSite::recurseCopy's destination guard, plus a realpath
 * containment check since Node callers pass already-joined (normalized) paths.
 */
function isDestinationWithinBase(basePath, destination) {
  if (typeof destination !== 'string' || destination === '' || destination.indexOf('\0') !== -1) {
    return false;
  }
  if (typeof basePath !== 'string' || basePath === '' || basePath.indexOf('\0') !== -1) {
    return false;
  }
  const normalizedDst = normalizeSeparators(destination);
  if (normalizedDst.indexOf('/../') !== -1 || /(^|\/)\.\.(\/|$)/.test(normalizedDst)) {
    return false;
  }
  const resolvedBase = safeRealpath(basePath);
  const resolvedDst = resolveThroughExistingAncestor(destination);
  if (resolvedBase === false || resolvedDst === false) {
    return false;
  }
  // must be strictly beneath the base; copying page boilerplate onto the
  // site root itself would clobber the site's index.html
  const a = normalizeSeparators(resolvedDst).replace(/\/+$/, '');
  const b = normalizeSeparators(resolvedBase).replace(/\/+$/, '');
  return a !== b && pathWithinBase(resolvedDst, resolvedBase);
}

module.exports = {
  pathWithinBase,
  hasUnsafeLocationSyntax,
  resolvePageLocation,
  isDestinationWithinBase,
};
