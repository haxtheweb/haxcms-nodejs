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
const { platformAllows } = require('../../lib/platformFeatures.js');
const { convertToHtml } = require('mammoth');
const { parse } = require('node-html-parser');
const {
  stripMSWord,
  validURL,
  htmlFromEl,
  processDocxHtml,
} = require('../../lib/convertUtils.js');
const JSONOutlineSchemaItem = require('../../lib/JSONOutlineSchemaItem.js');

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

function ensureSiteTokenHeader(req) {
  const headerToken = getRequestHeaderValue(req, 'x-haxcms-site-token');
  if (headerToken === '') {
    return null;
  }
  return headerToken;
}

function ensureSiteRequestBody(req, siteName = '') {
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
  const siteToken = ensureSiteTokenHeader(req);
  if (!siteToken) {
    return res.status(403).json({
      status: 403,
      message: 'X-HAXCMS-Site-Token header is required for this endpoint',
    });
  }
  const body = ensureSiteRequestBody(req, siteName);
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

async function normalizeSiteSlugs(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/site/normalize-slugs',
    });
  }
  const siteName = getSiteNameFromResolvedSite(site);
  if (siteName === '') {
    return res.status(400).json({
      status: 400,
      message: 'Unable to resolve site name for /x/api/v1/site/normalize-slugs',
    });
  }
  const siteToken = getRequestHeaderValue(req, 'x-haxcms-site-token');
  if (
    !siteToken ||
    !HAXCMS.validateRequestToken(
      siteToken,
      HAXCMS.getActiveUserName() + ':' + siteName,
    )
  ) {
    return res.status(403).json({
      status: 403,
      message: 'X-HAXCMS-Site-Token header is required for this endpoint',
    });
  }
  if (!platformAllows(site, 'outlineDesigner')) {
    return res.status(403).json({
      status: 403,
      message: 'Outline operations are disabled for this site',
    });
  }
  const body = ensureRequestBodyObject(req);
  let isPreview = false;
  if (
    body.preview === true ||
    body.preview === 'true' ||
    body.preview === 1
  ) {
    isPreview = true;
  } else if (
    req.query &&
    (req.query.preview === 'true' || req.query.preview === '1')
  ) {
    isPreview = true;
  }
  const pathautoEnabled =
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.settings &&
    site.manifest.metadata.site.settings.pathauto;
  let items = normalizeManifestItems(site);
  const originalItems = items.map((item) => ({ ...item }));
  // Temporarily update manifest items so getUniqueSlugName sees updated parent slugs
  site.manifest.items = items;
  const processedIds = [];
  const changes = [];
  const skipped = [];
  let remaining = [...items];
  const maxIterations = remaining.length * 2;
  let iteration = 0;
  while (remaining.length > 0 && iteration < maxIterations) {
    iteration++;
    const nextBatch = [];
    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i];
      const parent = item.parent ? String(item.parent) : '';
      const canProcess = parent === '' || processedIds.indexOf(parent) !== -1;
      if (!canProcess) {
        nextBatch.push(item);
        continue;
      }
      processedIds.push(String(item.id));
      const oldSlug = item.slug ? String(item.slug) : '';
      let overridePathauto = false;
      if (
        item.metadata &&
        typeof item.metadata === 'object' &&
        item.metadata.overridePathauto === true
      ) {
        overridePathauto = true;
      }
      let shouldSkip = false;
      let reason = '';
      if (pathautoEnabled && overridePathauto) {
        shouldSkip = true;
        reason = 'overridePathauto';
      }
      if (!shouldSkip) {
        const cleanTitle = HAXCMS.cleanTitle(item.title);
        const newSlug = site.getUniqueSlugName(cleanTitle, item, true);
        if (newSlug !== oldSlug) {
          item.slug = newSlug;
          changes.push({
            id: String(item.id),
            title: item.title ? String(item.title) : '',
            oldSlug: oldSlug,
            newSlug: newSlug,
          });
        }
      } else {
        skipped.push({
          id: String(item.id),
          title: item.title ? String(item.title) : '',
          oldSlug: oldSlug,
          reason: reason,
        });
      }
    }
    remaining = nextBatch;
  }
  if (isPreview) {
    site.manifest.items = originalItems;
  } else {
    site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);
    await site.manifest.save(false);
    await site.updateAlternateFormats();
    await site.gitCommit(
      'Bulk slug normalization: ' +
        changes.length +
        ' changed, ' +
        skipped.length +
        ' skipped',
    );
  }
  return res.json({
    status: 200,
    data: {
      items: site.manifest.items,
      changed: changes.length > 0,
      preview: isPreview,
      changes: changes,
      skipped: skipped,
    },
  });
}

async function importDocx(req, res) {
  let filename = null;
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'No file uploaded',
          items: [],
          filename: null,
        },
      });
    }
    const file = req.files[0];
    filename = file.originalname;
    if (!/\.(docx|doc)$/i.test(filename)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .docx or .doc, got: ${filename}`,
          items: [],
          filename: filename,
        },
      });
    }
    const fs = require('fs-extra');
    const buffer = fs.readFileSync(file.path);
    const mammothOptions = {
      styleMap: ['u => em', 'strike => del'],
    };
    let html = '';
    try {
      const result = await convertToHtml({ buffer: buffer }, mammothOptions);
      html = result.value;
      html = processDocxHtml(html);
      html = stripMSWord(html);
    } catch (e) {
      html = '';
      throw new Error(`Error converting DOCX: ${e.message}`);
    }
    const doc = parse(`<div id="docx-import-wrapper">${html}</div>`);
    const type = req.body && req.body.type ? req.body.type : '';
    const method = req.body && req.body.method ? req.body.method : 'site';
    const parentIdField = req.body && req.body.parentId ? req.body.parentId : null;
    const parentId = parentIdField && parentIdField !== 'null' ? parentIdField : null;
    const titleValue = filename.replace(/\.(docx|doc)$/i, '');
    let items = [];
    switch (method) {
      case 'site': {
        let h1s = doc.querySelectorAll('h1');
        let h1Order = 0;
        if (h1s.length === 0) {
          items.push(importSinglePage(titleValue, processSinglePageContent(doc.querySelector('#docx-import-wrapper')), parentId));
        } else {
          for await (const h1 of h1s) {
            let item = new JSONOutlineSchemaItem();
            item.title = h1.innerText.trim().replace('  ', ' ').replace('  ', ' ');
            item.slug = HAXCMS.cleanTitle(item.title);
            item.order = h1Order;
            item.parent = parentId;
            h1Order += 1;
            let tmp = await nextUntilElement(h1, ['H1']);
            let h1Children = tmp.siblings;
            let contents = '';
            let h2 = null;
            for await (const h1Child of h1Children) {
              if (h1Child.tagName === 'H2') {
                h2 = h1Child;
                break;
              } else if (h2 === null) {
                contents += htmlFromEl(h1Child);
              }
            }
            item.contents = contents !== '' ? contents : getFallbackContent(type);
            items.push(item);
            if (h2) {
              let h2Order = 0;
              while (h2 !== null && h2.tagName === 'H2') {
                let item2 = new JSONOutlineSchemaItem();
                item2.title = h2.innerText.trim().replace('  ', ' ').replace('  ', ' ');
                item2.slug = item.slug + '/' + HAXCMS.cleanTitle(item2.title);
                item2.order = h2Order;
                h2Order += 1;
                item2.indent = 1;
                item2.parent = item.id;
                let tmp = await nextUntilElement(h2, ['H1', 'H2']);
                let h2Children = tmp.siblings;
                h2 = tmp.lastEl;
                let contents2 = '';
                for await (const h2Child of h2Children) {
                  contents2 += htmlFromEl(h2Child);
                }
                item2.contents = contents2 !== '' ? contents2 : '<p></p>';
                items.push(item2);
              }
            }
          }
        }
        break;
      }
      case 'branch': {
        let els = doc.querySelectorAll('h1');
        let order = 0;
        if (els.length === 0) {
          items.push(importSinglePage(titleValue, processSinglePageContent(doc.querySelector('#docx-import-wrapper')), parentId));
        } else {
          for await (const h1 of els) {
            let item = new JSONOutlineSchemaItem();
            item.title = h1.innerText.trim().replace('  ', ' ').replace('  ', ' ');
            item.slug = HAXCMS.cleanTitle(item.title);
            item.order = order;
            item.parent = parentId;
            order += 1;
            let tmp = await nextUntilElement(h1, ['H1']);
            let h1Children = tmp.siblings;
            let contents = '';
            for await (const h1Child of h1Children) {
              contents += htmlFromEl(h1Child);
            }
            item.contents = contents !== '' ? contents : getFallbackContent(type);
            items.push(item);
          }
        }
        break;
      }
      case 'page':
      default: {
        items.push(importSinglePage(titleValue, processSinglePageContent(doc.querySelector('#docx-import-wrapper')), parentId));
        break;
      }
    }
    return res.json({
      status: 200,
      data: {
        items: items,
        filename: filename,
      },
    });
  } catch (error) {
    console.error('docxToSite: Error processing file:', error.message);
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing DOCX import: ${error.message}`,
        items: [],
        filename: filename,
      },
    });
  }
}

function processSinglePageContent(wrapperEl) {
  if (!wrapperEl) {
    return '<p></p>';
  }
  let content = '';
  for (const child of wrapperEl.childNodes) {
    if (child && child.tagName) {
      content += htmlFromEl(child);
    }
  }
  return content !== '' ? content : wrapperEl.innerHTML;
}

function importSinglePage(title, content, pValue) {
  let item = new JSONOutlineSchemaItem();
  item.title = title;
  item.slug = HAXCMS.cleanTitle(item.title);
  item.order = 0;
  item.parent = pValue;
  item.contents = content;
  return item;
}

async function nextUntilElement(elem, tagMatches) {
  var siblings = [];
  elem = elem.nextElementSibling;
  while (elem) {
    if (tagMatches.includes(elem.tagName)) {
      break;
    }
    siblings.push(elem);
    elem = elem.nextElementSibling;
  }
  return {
    siblings: siblings,
    lastEl: elem,
  };
}

function getFallbackContent(type) {
  switch (type) {
    case 'portfolio':
      return `<p>Enjoy my portfolio and let me know if you have questions.</p>
<lesson-overview>
  <lesson-highlight smart="pages"></lesson-highlight>
</lesson-overview>`;
    case 'course':
      return `<p>Welcome to the lesson.</p>
<lesson-overview>
  <lesson-highlight smart="pages"></lesson-highlight>
  <lesson-highlight smart="readTime"></lesson-highlight>
  <lesson-highlight smart="selfChecks"></lesson-highlight>
  <lesson-highlight smart="audio"></lesson-highlight>
  <lesson-highlight smart="video"></lesson-highlight>
</lesson-overview>
<p>Let's begin!</p>`;
    default:
      return '<p></p>';
  }
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
  normalizeSiteSlugs,
  importDocx,
};
