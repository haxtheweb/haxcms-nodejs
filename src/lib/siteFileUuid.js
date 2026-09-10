const path = require('path');
const crypto = require('crypto');

// Mirrors normalizePathForResponse in siteRouteUtils.js so this lib stays
// dependency-light (lib-level, no route-util import) while behaving
// identically. Same pattern as siteFileUrl.js.
function normalizePathForResponse(value = '') {
  return String(value).split(path.sep).join('/');
}

function getSiteNameForFileUuid(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.name
  ) {
    return String(site.manifest.metadata.site.name);
  }
  if (site && site.name) {
    return String(site.name);
  }
  return 'site';
}

function getCanonicalFilePathForUuid(relativePath) {
  const normalizedPath = normalizePathForResponse(relativePath || '').replace(
    /^\/+/,
    '',
  );
  if (normalizedPath.indexOf('files/') === 0) {
    return normalizedPath;
  }
  return normalizedPath === '' ? 'files' : 'files/' + normalizedPath;
}

function toUuidFromHash(hash) {
  return (
    hash.substring(0, 8) +
    '-' +
    hash.substring(8, 12) +
    '-' +
    hash.substring(12, 16) +
    '-' +
    hash.substring(16, 20) +
    '-' +
    hash.substring(20, 32)
  );
}

// Deterministic UUID for a site file: sha256(siteName:canonicalPath:size)
// formatted as a UUID. Identical inputs produce identical UUIDs across the
// upload response (HAXCMSFile.save) and the list/get file records (v1 files
// route), so a freshly-uploaded file can be operated on immediately via
// @site/updateFileByUuid without a separate listFiles round-trip (#3028).
function getDeterministicFileUuid(site, relativePath, fileSize) {
  const canonicalPath = getCanonicalFilePathForUuid(relativePath);
  const canonicalSize =
    typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize > 0
      ? Math.round(fileSize)
      : 0;
  const identityString =
    getSiteNameForFileUuid(site) + ':' + canonicalPath + ':' + canonicalSize;
  const hash = crypto.createHash('sha256').update(identityString).digest('hex');
  return toUuidFromHash(hash);
}

module.exports = {
  normalizePathForResponse,
  getSiteNameForFileUuid,
  getCanonicalFilePathForUuid,
  toUuidFromHash,
  getDeterministicFileUuid,
};
