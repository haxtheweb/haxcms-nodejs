const { HAXCMS } = require('../../../lib/HAXCMS.js');

function normalizeSiteName(value = '') {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/^\/+|\/+$/g, '');
}

function getSiteNameFromRequest(req) {
  if (
    req &&
    req.params &&
    Object.prototype.hasOwnProperty.call(req.params, 'siteName') &&
    req.params.siteName
  ) {
    return normalizeSiteName(req.params.siteName);
  }
  if (
    req &&
    req.body &&
    req.body.site &&
    typeof req.body.site === 'object' &&
    typeof req.body.site.name === 'string'
  ) {
    return normalizeSiteName(req.body.site.name);
  }
  if (
    req &&
    req.query &&
    Object.prototype.hasOwnProperty.call(req.query, 'siteName')
  ) {
    return normalizeSiteName(req.query.siteName);
  }
  return '';
}

function toIsoDateFromUnixTime(value) {
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return new Date(parsed * 1000).toISOString();
}

function normalizePath(pathValue = '') {
  let normalized = String(pathValue || '');
  if (normalized === '') {
    return '/';
  }
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.charAt(0) !== '/') {
    normalized = '/' + normalized;
  }
  if (normalized.length > 1 && normalized.charAt(normalized.length - 1) === '/') {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}

function getSystemApiBasePath() {
  const basePath = String(HAXCMS.basePath || '/');
  const systemBase = String(HAXCMS.systemRequestBase || 'system/api/');
  return normalizePath(`${basePath}/${systemBase}v1`);
}

function getSiteItemCount(site) {
  if (!site || !site.manifest || !site.manifest.items) {
    return 0;
  }
  if (Array.isArray(site.manifest.items)) {
    return site.manifest.items.length;
  }
  if (typeof site.manifest.items === 'object') {
    return Object.keys(site.manifest.items).length;
  }
  return 0;
}

function buildSiteLinks(siteName = '') {
  const cleanSiteName = normalizeSiteName(siteName);
  const encodedSiteName = encodeURIComponent(cleanSiteName);
  const basePath = getSystemApiBasePath();
  const sitesDirectory = String(HAXCMS.sitesDirectory || '_sites').replace(
    /^\/+|\/+$/g,
    '',
  );
  return {
    self: `${basePath}/sites/${encodedSiteName}`,
    clone: `${basePath}/sites/${encodedSiteName}/clone`,
    archive: `${basePath}/sites/${encodedSiteName}/archive`,
    download: `${basePath}/sites/${encodedSiteName}/download`,
    downloadSkeleton: `${basePath}/sites/${encodedSiteName}/download-skeleton`,
    saveAsTemplate: `${basePath}/sites/${encodedSiteName}/save-as-template`,
    siteApi: `${normalizePath(HAXCMS.basePath || '/')}/${sitesDirectory}/${encodedSiteName}/x/api`,
  };
}

async function siteInfo(req, res) {
  const siteName = getSiteNameFromRequest(req);
  if (siteName === '') {
    return res.status(400).json({
      status: 400,
      message: 'siteName is required',
    });
  }
  const site = await HAXCMS.loadSite(siteName);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Site not found',
    });
  }
  const links = buildSiteLinks(siteName);
  const metadata = (
    site.manifest &&
    site.manifest.metadata &&
    typeof site.manifest.metadata === 'object'
  ) ? site.manifest.metadata : {};
  const siteMetadata = (
    metadata.site &&
    typeof metadata.site === 'object'
  ) ? metadata.site : {};
  return res.json({
    status: 200,
    data: {
      id: site.manifest.id || null,
      name: siteName,
      title: site.manifest.title || siteName,
      description: site.manifest.description || '',
      location: `${normalizePath(HAXCMS.basePath || '/')}/${String(HAXCMS.sitesDirectory || '_sites').replace(/^\/+|\/+$/g, '')}/${encodeURIComponent(siteName)}/`,
      metadata: {
        pageCount: getSiteItemCount(site),
        created: toIsoDateFromUnixTime(siteMetadata.created),
        updated: toIsoDateFromUnixTime(siteMetadata.updated),
      },
      links,
    },
  });
}

module.exports = siteInfo;
