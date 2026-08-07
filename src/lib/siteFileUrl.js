const path = require('path');
const { HAXCMS } = require('./HAXCMS.js');

// Mirrors normalizePathForResponse in siteRouteUtils.js so this lib stays
// dependency-light (lib-level, no route-util import) while behaving identically.
function normalizePathForResponse(value = '') {
  return String(value).split(path.sep).join('/');
}

// True when the resolved site is being served under the multisite sites
// directory (e.g. /sites/<siteName>/) instead of a single-site root.
function isMultisiteContext(site) {
  if (HAXCMS.runtimeServerMode === 'single-site') {
    return false;
  }
  if (HAXCMS.runtimeServerMode === 'multisite') {
    return true;
  }
  if (HAXCMS.operatingContext === 'multisite') {
    return true;
  }
  if (
    typeof HAXCMS.getDeploymentProfile === 'function' &&
    HAXCMS.getDeploymentProfile() === 'self-hosted-multi-site'
  ) {
    return true;
  }
  if (site && typeof site.basePath === 'string' && site.basePath) {
    const basePath = normalizePathForResponse(site.basePath);
    const sitesDir = normalizePathForResponse(HAXCMS.sitesDirectory);
    if (basePath.indexOf('/' + sitesDir + '/') !== -1) {
      return true;
    }
  }
  return false;
}

// Build the public web URL for a site file given its site-relative path
// (e.g. 'files/headshot.jpg'). Single-site => '/files/headshot.jpg';
// multisite => '<basePath>/<sitesDirectory>/<siteName>/files/headshot.jpg'.
// This is the single source of truth for file public URLs so that upload
// responses (HAXCMSFile.save) and list/get records (v1 files route) agree,
// and so stored page.metadata.files entries hold real URLs, not filesystem
// paths. cloneSite's prefix-rewrite logic recognises this multisite shape.
function buildFilePublicUrl(site, relativeFilePath) {
  const normalizedRelativePath = normalizePathForResponse(relativeFilePath).replace(
    /^\/+/,
    '',
  );
  let fullUrl = '/' + normalizedRelativePath;
  if (isMultisiteContext(site)) {
    fullUrl =
      HAXCMS.basePath +
      HAXCMS.sitesDirectory +
      '/' +
      site.manifest.metadata.site.name +
      '/' +
      normalizedRelativePath;
  }
  return fullUrl;
}

module.exports = {
  normalizePathForResponse,
  isMultisiteContext,
  buildFilePublicUrl,
};
