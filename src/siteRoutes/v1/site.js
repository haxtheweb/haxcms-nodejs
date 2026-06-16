const fs = require('fs-extra');
const path = require('path');
const { HAXCMS, systemStructureContext } = require('../../lib/HAXCMS.js');
const saveManifestRoute = require('./routes/saveManifest.js');
const saveAppearanceSettingsRoute = require('./routes/saveAppearanceSettings.js');
const savePlatformSettingsRoute = require('./routes/savePlatformSettings.js');
const saveAllowedBlocksRoute = require('./routes/saveAllowedBlocks.js');
const saveEditorSettingsRoute = require('./routes/saveEditorSettings.js');
const saveSeoSettingsRoute = require('./routes/saveSeoSettings.js');
const saveOutlineRoute = require('./routes/saveOutline.js');

function getRequestPath(req) {
  if (req && typeof req.originalUrl === 'string' && req.originalUrl !== '') {
    return req.originalUrl.split('?')[0];
  }
  if (req && typeof req.url === 'string' && req.url !== '') {
    return req.url.split('?')[0];
  }
  return '';
}

function getMultisiteSiteNameFromPath(requestPath = '') {
  const parts = String(requestPath || '')
    .split('/')
    .filter((part) => part !== '');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === HAXCMS.sitesDirectory && parts[i + 1]) {
      return decodeURIComponent(parts[i + 1]);
    }
  }
  return '';
}

function getRequestHeaderValue(req, headerName = '') {
  if (!req || !req.headers || typeof req.headers !== 'object') {
    return '';
  }
  const normalizedHeaderName = String(headerName || '').toLowerCase().trim();
  if (normalizedHeaderName === '') {
    return '';
  }
  const value = req.headers[normalizedHeaderName];
  if (Array.isArray(value)) {
    if (value.length > 0) {
      return String(value[0] || '').trim();
    }
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

function ensureRequestQueryObject(req) {
  if (!req.query || typeof req.query !== 'object') {
    req.query = {};
  }
  return req.query;
}

function ensureRequestBodyObject(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    req.body = {};
  }
  return req.body;
}

function getSiteNameFromResolvedSite(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    typeof site.manifest.metadata.site.name === 'string' &&
    site.manifest.metadata.site.name.trim() !== ''
  ) {
    return site.manifest.metadata.site.name.trim();
  }
  return '';
}

function ensureLegacySiteTokenQuery(req) {
  const query = ensureRequestQueryObject(req);
  const body = ensureRequestBodyObject(req);
  if (Object.prototype.hasOwnProperty.call(query, 'site_token')) {
    delete query.site_token;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'site_token')) {
    delete body.site_token;
  }
  const headerToken = getRequestHeaderValue(req, 'x-haxcms-site-token');
  if (headerToken === '') {
    return null;
  }
  query.site_token = headerToken;
  body.site_token = headerToken;
  return query;
}

function ensureLegacySiteRequestBody(req, siteName = '') {
  const body = ensureRequestBodyObject(req);
  if (!body.site || typeof body.site !== 'object' || Array.isArray(body.site)) {
    body.site = {};
  }
  if ((!body.site.name || String(body.site.name).trim() === '') && siteName !== '') {
    body.site.name = siteName;
  }
  return body;
}

function toIsoDateFromUnixTime(value) {
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return new Date(parsed * 1000).toISOString();
}

function normalizeManifestItems(site) {
  if (!site || !site.manifest || !site.manifest.items) {
    return [];
  }
  if (Array.isArray(site.manifest.items)) {
    return site.manifest.items.filter((item) => item);
  }
  const items = [];
  for (const key in site.manifest.items) {
    if (site.manifest.items[key]) {
      items.push(site.manifest.items[key]);
    }
  }
  return items;
}

function normalizeTagList(tags) {
  if (Array.isArray(tags)) {
    return tags
      .map((tag) => String(tag || '').trim())
      .filter((tag) => tag !== '');
  }
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
  }
  return [];
}

function countSiteFiles(site) {
  if (!site || !site.siteDirectory) {
    return 0;
  }
  const filesRoot = path.join(site.siteDirectory, 'files');
  if (!fs.pathExistsSync(filesRoot) || !fs.lstatSync(filesRoot).isDirectory()) {
    return 0;
  }
  const ignoredNames = ['.gitkeep', '.DS_Store', '._.DS_Store', '.htaccess', '._htaccess'];
  const stack = [filesRoot];
  let total = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current);
    }
    catch (e) {
      entries = [];
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === '.' || entry === '..' || ignoredNames.indexOf(entry) !== -1) {
        continue;
      }
      const entryPath = path.join(current, entry);
      let stats = null;
      try {
        stats = fs.lstatSync(entryPath);
      }
      catch (e) {
        stats = null;
      }
      if (!stats || stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (stats.isFile()) {
        total++;
      }
    }
  }
  return total;
}

function getSiteLanguage(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.settings &&
    site.manifest.metadata.site.settings.lang
  ) {
    return String(site.manifest.metadata.site.settings.lang);
  }
  if (site && site.language) {
    return String(site.language);
  }
  return 'en';
}

function getSiteTheme(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.theme &&
    site.manifest.metadata.theme.element
  ) {
    return String(site.manifest.metadata.theme.element);
  }
  return null;
}

function getSiteBasePath(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.name
  ) {
    let basePath = String(HAXCMS.basePath || '/');
    if (basePath.charAt(0) !== '/') {
      basePath = '/' + basePath;
    }
    if (basePath.charAt(basePath.length - 1) !== '/') {
      basePath += '/';
    }
    if (site.basePath && String(site.basePath).indexOf('/' + HAXCMS.sitesDirectory + '/') !== -1) {
      return `${basePath}${HAXCMS.sitesDirectory}/${site.manifest.metadata.site.name}/`;
    }
    return `${basePath}${site.manifest.metadata.site.name}/`;
  }
  return String(HAXCMS.basePath || '/');
}

function normalizeBasePath(basePath = '/') {
  let output = String(basePath || '/').trim();
  if (output === '') {
    output = '/';
  }
  if (output.charAt(0) !== '/') {
    output = '/' + output;
  }
  if (output.charAt(output.length - 1) !== '/') {
    output += '/';
  }
  return output;
}

function joinRelativePath(basePath = '/', relativePath = '') {
  const normalizedBasePath = normalizeBasePath(basePath);
  const cleanRelativePath = String(relativePath || '').replace(/^\/+/, '');
  return `${normalizedBasePath}${cleanRelativePath}`;
}

function buildCounts(site, items) {
  const tagSet = new Set();
  const regionSet = new Set();
  let publishedItems = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || !item.metadata) {
      continue;
    }
    if (item.metadata.published !== false) {
      publishedItems++;
    }
    const tags = normalizeTagList(item.metadata.tags);
    for (let t = 0; t < tags.length; t++) {
      tagSet.add(tags[t]);
    }
    if (item.metadata.region) {
      regionSet.add(String(item.metadata.region));
    }
  }
  return {
    items: items.length,
    publishedItems,
    tags: tagSet.size,
    regions: regionSet.size,
    files: countSiteFiles(site),
  };
}

function buildSiteJsonLd(site, links, counts = {}) {
  const siteName =
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.name
      ? String(site.manifest.metadata.site.name)
      : String(site && site.name ? site.name : 'site');
  const siteTitle =
    site && site.manifest && site.manifest.title
      ? String(site.manifest.title)
      : siteName;
  const siteDescription =
    site && site.manifest && site.manifest.description
      ? String(site.manifest.description)
      : '';
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    '@id': `${links.self}#site-summary`,
    name: `${siteTitle} API summary`,
    description: siteDescription,
    url: links.self,
    inLanguage: getSiteLanguage(site),
    distribution: [
      {
        '@type': 'DataDownload',
        name: 'Site manifest (site.json)',
        encodingFormat: 'application/json',
        contentUrl: links.siteJson,
      },
      {
        '@type': 'DataDownload',
        name: 'RSS feed',
        encodingFormat: 'application/rss+xml',
        contentUrl: links.rss,
      },
      {
        '@type': 'DataDownload',
        name: 'Sitemap',
        encodingFormat: 'application/xml',
        contentUrl: links.sitemap,
      },
    ],
    variableMeasured: [
      {
        '@type': 'PropertyValue',
        name: 'items',
        value: Number(counts.items || 0),
      },
      {
        '@type': 'PropertyValue',
        name: 'publishedItems',
        value: Number(counts.publishedItems || 0),
      },
      {
        '@type': 'PropertyValue',
        name: 'tags',
        value: Number(counts.tags || 0),
      },
      {
        '@type': 'PropertyValue',
        name: 'regions',
        value: Number(counts.regions || 0),
      },
      {
        '@type': 'PropertyValue',
        name: 'files',
        value: Number(counts.files || 0),
      },
    ],
  };
}

function buildSiteLinks(req, site) {
  const requestPath = getRequestPath(req);
  const matched = String(requestPath || '').match(/^(.*\/x\/api)(?:\/.*)?$/);
  const apiBasePath = matched && matched[1] ? matched[1] : '/x/api';
  const siteBasePath = getSiteBasePath(site);
  return {
    self: `${apiBasePath}/v1/site`,
    items: `${apiBasePath}/v1/items`,
    entities: `${apiBasePath}/v1/entities`,
    schemas: `${apiBasePath}/v1/schemas`,
    openapi: `${apiBasePath}/openapi`,
    openapiJson: `${apiBasePath}/openapi.json`,
    openapiYaml: `${apiBasePath}/openapi.yaml`,
    manifest: joinRelativePath(siteBasePath, 'manifest.json'),
    serviceWorker: joinRelativePath(siteBasePath, 'service-worker.js'),
    serviceWorkerManifest: joinRelativePath(siteBasePath, 'push-manifest.json'),
    rss: joinRelativePath(siteBasePath, 'rss.xml'),
    atom: joinRelativePath(siteBasePath, 'atom.xml'),
    siteJson: joinRelativePath(siteBasePath, 'site.json'),
    sitemap: joinRelativePath(siteBasePath, 'sitemap.xml'),
    sitemapIndex: joinRelativePath(siteBasePath, 'sitemap-index.xml'),
    exports: {
      zip: `${apiBasePath}/v1/site/export/zip`,
      markdown: `${apiBasePath}/v1/site/export/markdown`,
      pdf: `${apiBasePath}/v1/site/export/pdf`,
      docx: `${apiBasePath}/v1/site/export/docx`,
      epub: `${apiBasePath}/v1/site/export/epub`,
      skeleton: `${apiBasePath}/v1/site/export/skeleton`,
    },
  };
}

async function resolveSiteForRequest(req) {
  const requestPath = getRequestPath(req);
  const siteName = getMultisiteSiteNameFromPath(requestPath);
  if (siteName !== '') {
    return await HAXCMS.loadSite(siteName);
  }
  return await systemStructureContext();
}

async function siteSummary(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/site',
    });
  }
  const items = normalizeManifestItems(site);
  const counts = buildCounts(site, items);
  const links = buildSiteLinks(req, site);
  return res.json({
    status: 200,
    data: {
      id: site.manifest.id || null,
      name:
        site.manifest &&
        site.manifest.metadata &&
        site.manifest.metadata.site &&
        site.manifest.metadata.site.name
          ? String(site.manifest.metadata.site.name)
          : String(site.name || ''),
      title: site.manifest.title || '',
      description: site.manifest.description || '',
      language: getSiteLanguage(site),
      basePath: getSiteBasePath(site),
      theme: getSiteTheme(site),
      updated:
        site.manifest &&
        site.manifest.metadata &&
        site.manifest.metadata.site
          ? toIsoDateFromUnixTime(site.manifest.metadata.site.updated)
          : null,
      counts,
      links,
      jsonld: buildSiteJsonLd(site, links, counts),
    },
  });
}

async function delegateToLegacySiteWrite(
  req,
  res,
  next,
  routeLabel,
  legacyHandler,
  validateBody = null,
) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: `Unable to resolve site context for ${routeLabel}`,
    });
  }
  const siteName = getSiteNameFromResolvedSite(site);
  if (siteName === '') {
    return res.status(400).json({
      status: 400,
      message: `Unable to resolve site name for ${routeLabel}`,
    });
  }
  const legacyTokenQuery = ensureLegacySiteTokenQuery(req);
  if (!legacyTokenQuery) {
    return res.status(403).json({
      status: 403,
      message: 'X-HAXCMS-Site-Token header is required for this endpoint',
    });
  }
  const body = ensureLegacySiteRequestBody(req, siteName);
  if (typeof validateBody === 'function') {
    const validationResult = validateBody(body);
    if (validationResult && validationResult.valid === false) {
      return res.status(validationResult.status || 400).json({
        status: validationResult.status || 400,
        message: validationResult.message || 'Invalid request payload',
      });
    }
  }
  return legacyHandler(req, res, next);
}

async function updateSite(req, res, next) {
  return delegateToLegacySiteWrite(
    req,
    res,
    next,
    '/x/api/v1/site',
    saveManifestRoute,
  );
}

async function updateSiteAppearance(req, res, next) {
  return delegateToLegacySiteWrite(
    req,
    res,
    next,
    '/x/api/v1/site/appearance',
    saveAppearanceSettingsRoute,
  );
}

async function updateSitePlatform(req, res, next) {
  return delegateToLegacySiteWrite(
    req,
    res,
    next,
    '/x/api/v1/site/platform',
    savePlatformSettingsRoute,
  );
}

async function updateSiteBlocks(req, res, next) {
  return delegateToLegacySiteWrite(
    req,
    res,
    next,
    '/x/api/v1/site/blocks',
    saveAllowedBlocksRoute,
  );
}

async function updateSiteEditor(req, res, next) {
  return delegateToLegacySiteWrite(
    req,
    res,
    next,
    '/x/api/v1/site/editor',
    saveEditorSettingsRoute,
  );
}

async function updateSiteSeo(req, res, next) {
  return delegateToLegacySiteWrite(
    req,
    res,
    next,
    '/x/api/v1/site/seo',
    saveSeoSettingsRoute,
  );
}

async function updateSiteOutline(req, res, next) {
  return delegateToLegacySiteWrite(
    req,
    res,
    next,
    '/x/api/v1/site/outline',
    saveOutlineRoute,
    (body) => {
      if (!body || !Array.isArray(body.items)) {
        return {
          valid: false,
          status: 400,
          message: 'Outline payload requires an items array',
        };
      }
      return { valid: true };
    },
  );
}

async function updateSiteAlternativeFormats(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message:
        'Unable to resolve site context for /x/api/v1/site/updateAlternativeFormats',
    });
  }
  const siteName = getSiteNameFromResolvedSite(site);
  if (siteName === '') {
    return res.status(400).json({
      status: 400,
      message:
        'Unable to resolve site name for /x/api/v1/site/updateAlternativeFormats',
    });
  }
  let format = null;
  if (
    req &&
    req.body &&
    typeof req.body === 'object' &&
    !Array.isArray(req.body) &&
    Object.prototype.hasOwnProperty.call(req.body, 'format')
  ) {
    const requestedFormat = String(req.body.format || '').trim();
    if (requestedFormat !== '') {
      format = requestedFormat;
    }
  }
  try {
    await site.updateAlternateFormats(format);
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      message: 'Unable to update alternative formats for this site',
    });
  }
  return res.json({
    status: 200,
    data: {
      updated: true,
      site: {
        name: siteName,
      },
      format: format,
    },
  });
}

module.exports = {
  listSite: siteSummary,
  updateSite,
  updateSiteAppearance,
  updateSitePlatform,
  updateSiteBlocks,
  updateSiteEditor,
  updateSiteSeo,
  updateSiteOutline,
  updateSiteAlternativeFormats,
};
