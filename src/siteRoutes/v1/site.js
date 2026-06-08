const fs = require('fs-extra');
const path = require('path');
const { HAXCMS, systemStructureContext } = require('../../lib/HAXCMS.js');

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

module.exports = siteSummary;
