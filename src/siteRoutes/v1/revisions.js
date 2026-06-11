const fs = require('fs');
const path = require('path');
const util = require('node:util');
const child_process = require('node:child_process');
const execFile = util.promisify(child_process.execFile);
const stripTagsImport = require('locutus/php/strings/strip_tags');
const strip_tags = stripTagsImport.strip_tags || stripTagsImport;
const { sanitizeURLValue } = require('../../lib/sanitizeContent.js');
const {
  getApiBasePath,
  getQueryValue,
  resolveSiteForRequest,
  findItemByIdOrSlug,
  sendFormattedResponse,
} = require('./siteRouteUtils.js');

function sanitizePageLocation(siteDirectory, location) {
  const normalizedLocation = String(location || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
  if (!normalizedLocation || normalizedLocation.indexOf('..') !== -1) {
    return null;
  }
  const siteRoot = path.resolve(siteDirectory);
  const absolutePath = path.resolve(siteRoot, normalizedLocation);
  const siteRootPrefix = siteRoot + path.sep;
  if (absolutePath !== siteRoot && absolutePath.indexOf(siteRootPrefix) !== 0) {
    return null;
  }
  return {
    absolutePath,
    location: normalizedLocation,
  };
}

async function gitOutput(siteDirectory, args, trim = true) {
  const result = await execFile('git', ['--no-pager'].concat(args), {
    cwd: siteDirectory,
    maxBuffer: 1024 * 1024 * 20,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  if (trim) {
    return stdout.trim();
  }
  return stdout;
}

function toPositiveInteger(value, fallbackValue, minValue = 0, maxValue = 0) {
  let parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    parsed = fallbackValue;
  }
  if (parsed < minValue) {
    parsed = minValue;
  }
  if (maxValue > 0 && parsed > maxValue) {
    parsed = maxValue;
  }
  return parsed;
}

function parseRevisionRows(logRaw = '', offset = 0) {
  const revisions = [];
  if (!logRaw) {
    return revisions;
  }
  const lines = String(logRaw).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) {
      continue;
    }
    const parts = lines[i].split('\u001f');
    if (parts.length < 7) {
      continue;
    }
    const timestamp = parseInt(parts[4], 10);
    revisions.push({
      revisionNumber: offset + revisions.length + 1,
      hash: parts[0],
      shortHash: parts[1],
      author: parts[2],
      authorEmail: parts[3],
      timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
      date: parts[5],
      message: parts[6],
    });
  }
  return revisions;
}

function sanitizeRevisionId(value = '') {
  let revisionId = String(value || '').trim();
  if (revisionId === '') {
    return '';
  }
  try {
    revisionId = decodeURIComponent(revisionId);
  } catch (e) {}
  revisionId = revisionId.trim();
  if (!/^[a-fA-F0-9]{7,64}$/.test(revisionId)) {
    return '';
  }
  return revisionId;
}

function parseRevisionJSONPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(rawPayload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

function getItemMetadataFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const itemMetadata = {};
  if (Object.prototype.hasOwnProperty.call(payload, 'id')) {
    itemMetadata.id = payload.id;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
    itemMetadata.title = payload.title;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
    itemMetadata.description = payload.description;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'slug')) {
    itemMetadata.slug = payload.slug;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'parent')) {
    itemMetadata.parent = payload.parent;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'order')) {
    itemMetadata.order = payload.order;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'indent')) {
    itemMetadata.indent = payload.indent;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, 'metadata') &&
    payload.metadata &&
    typeof payload.metadata === 'object' &&
    !Array.isArray(payload.metadata)
  ) {
    itemMetadata.metadata = payload.metadata;
  } else {
    itemMetadata.metadata = {};
  }
  return itemMetadata;
}

function ensurePageMetadata(page) {
  if (
    !page.metadata ||
    typeof page.metadata !== 'object' ||
    Array.isArray(page.metadata)
  ) {
    page.metadata = {};
  }
}

function normalizeTextValue(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  return strip_tags(String(value));
}

function setBooleanMetadataValue(page, sourceMetadata, fieldName) {
  if (
    sourceMetadata &&
    Object.prototype.hasOwnProperty.call(sourceMetadata, fieldName)
  ) {
    page.metadata[fieldName] = Boolean(sourceMetadata[fieldName]);
  } else if (Object.prototype.hasOwnProperty.call(page.metadata, fieldName)) {
    delete page.metadata[fieldName];
  }
}

function setURLMetadataValue(page, sourceMetadata, fieldName) {
  if (
    sourceMetadata &&
    Object.prototype.hasOwnProperty.call(sourceMetadata, fieldName)
  ) {
    const safeValue = sanitizeURLValue(sourceMetadata[fieldName], '');
    if (safeValue) {
      page.metadata[fieldName] = safeValue;
    } else if (Object.prototype.hasOwnProperty.call(page.metadata, fieldName)) {
      delete page.metadata[fieldName];
    }
  } else if (Object.prototype.hasOwnProperty.call(page.metadata, fieldName)) {
    delete page.metadata[fieldName];
  }
}

function setURLArrayMetadataValue(page, sourceMetadata, fieldName) {
  if (
    sourceMetadata &&
    Object.prototype.hasOwnProperty.call(sourceMetadata, fieldName) &&
    Array.isArray(sourceMetadata[fieldName])
  ) {
    const values = [];
    for (let i = 0; i < sourceMetadata[fieldName].length; i++) {
      const safeValue = sanitizeURLValue(sourceMetadata[fieldName][i], '');
      if (safeValue) {
        values.push(safeValue);
      }
    }
    page.metadata[fieldName] = values;
  } else if (Object.prototype.hasOwnProperty.call(page.metadata, fieldName)) {
    delete page.metadata[fieldName];
  }
}

function applyItemMetadataToPage(page, itemMetadata) {
  if (
    !itemMetadata ||
    typeof itemMetadata !== 'object' ||
    Array.isArray(itemMetadata)
  ) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(itemMetadata, 'title')) {
    page.title = normalizeTextValue(itemMetadata.title);
  }
  if (Object.prototype.hasOwnProperty.call(itemMetadata, 'description')) {
    page.description = normalizeTextValue(itemMetadata.description);
  }
  const sourceMetadata =
    itemMetadata.metadata &&
    typeof itemMetadata.metadata === 'object' &&
    !Array.isArray(itemMetadata.metadata)
      ? itemMetadata.metadata
      : null;
  ensurePageMetadata(page);
  setBooleanMetadataValue(page, sourceMetadata, 'published');
  setBooleanMetadataValue(page, sourceMetadata, 'locked');
  setURLMetadataValue(page, sourceMetadata, 'image');
  setURLArrayMetadataValue(page, sourceMetadata, 'images');
  setURLArrayMetadataValue(page, sourceMetadata, 'videos');
  return true;
}

function parseRevisionMetadata(revisionMetadataRaw = '', revisionHash = '') {
  const metadataParts = String(revisionMetadataRaw || '').trim().split('\u001f');
  return {
    hash: metadataParts[0] || revisionHash,
    shortHash: metadataParts[1] || String(revisionHash).substring(0, 7),
    author: metadataParts[2] || '',
    authorEmail: metadataParts[3] || '',
    timestamp: parseInt(metadataParts[4], 10) || 0,
    date: metadataParts[5] || '',
    message: metadataParts[6] || '',
  };
}

function resolveLookupValue(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }
  if (item.slug) {
    return String(item.slug);
  }
  if (item.id) {
    return String(item.id);
  }
  return '';
}

async function listItemRevisions(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/items/:idOrSlug/revisions',
    });
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? String(req.params.idOrSlug) : '';
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item) {
    return res.status(404).json({
      status: 404,
      message: `Item not found for idOrSlug "${idOrSlug}"`,
    });
  }
  if (!item.id || typeof site.loadNode !== 'function') {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve item page context for revisions',
    });
  }
  const page = site.loadNode(item.id);
  if (!page || !page.location) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve page location for revisions',
    });
  }
  const fileData = sanitizePageLocation(site.siteDirectory, page.location);
  if (!fileData) {
    return res.status(400).json({
      status: 400,
      message: 'Invalid node file location',
    });
  }
  if (!fs.existsSync(fileData.absolutePath)) {
    return res.status(404).json({
      status: 404,
      message: 'Node file not found',
    });
  }

  const limit = toPositiveInteger(getQueryValue(req, 'page.limit', 25), 25, 1, 200);
  const offset = toPositiveInteger(getQueryValue(req, 'page.offset', 0), 0, 0, 0);
  const logFormat = '%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ad%x1f%s';
  try {
    const logRaw = await gitOutput(
      site.siteDirectory,
      [
        'log',
        '--date=iso-strict',
        '--pretty=format:' + logFormat,
        '--max-count=' + limit,
        '--skip=' + offset,
        '--',
        fileData.location,
      ],
      false,
    );
    const revisions = parseRevisionRows(logRaw, offset);
    let total = revisions.length;
    try {
      const totalRaw = await gitOutput(
        site.siteDirectory,
        ['log', '--pretty=format:%H', '--', fileData.location],
        false,
      );
      if (totalRaw) {
        total = totalRaw
          .split('\n')
          .map((row) => row.trim())
          .filter((row) => row !== '').length;
      } else {
        total = 0;
      }
    } catch (e) {}
    const lookupValue = item.slug ? String(item.slug) : String(item.id);
    const apiBasePath = getApiBasePath(req);
    const jsonVariantLocation =
      typeof site.getPageAlternateLocation === 'function'
        ? site.getPageAlternateLocation(page.location, 'json')
        : '';
    return sendFormattedResponse(
      req,
      res,
      {
        nodeId: item.id,
        nodeSlug: item.slug || '',
        nodeTitle: item.title || '',
        jsonVariantLocation: jsonVariantLocation || '',
        count: revisions.length,
        total,
        page: {
          limit,
          offset,
          total,
        },
        revisions,
        links: {
          self: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions`,
          item: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}`,
        },
      },
      {
        allowedFormats: ['json'],
        defaultFormat: 'json',
      },
    );
  } catch (e) {
    return res.status(500).json({
      status: 500,
      message: e && e.message ? e.message : 'Unable to load item revisions',
    });
  }
}

async function itemRevisionDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      message:
        'Unable to resolve site context for /x/api/v1/items/:idOrSlug/revisions/:revisionId',
    });
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? String(req.params.idOrSlug) : '';
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item) {
    return res.status(404).json({
      status: 404,
      message: `Item not found for idOrSlug "${idOrSlug}"`,
    });
  }
  if (!item.id || typeof site.loadNode !== 'function') {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve item page context for revision detail',
    });
  }
  const page = site.loadNode(item.id);
  if (!page || !page.location) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve page location for revision detail',
    });
  }
  const fileData = sanitizePageLocation(site.siteDirectory, page.location);
  if (!fileData) {
    return res.status(400).json({
      status: 400,
      message: 'Invalid node file location',
    });
  }
  if (!fs.existsSync(fileData.absolutePath)) {
    return res.status(404).json({
      status: 404,
      message: 'Node file not found',
    });
  }
  const revisionHash =
    req && req.params && req.params.revisionId
      ? sanitizeRevisionId(req.params.revisionId)
      : '';
  if (revisionHash === '') {
    return res.status(400).json({
      status: 400,
      message: 'Invalid revision hash',
    });
  }
  try {
    const revisionMetadataRaw = await gitOutput(
      site.siteDirectory,
      [
        'show',
        '--quiet',
        '--date=iso-strict',
        '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ad%x1f%s',
        revisionHash,
      ],
      false,
    );
    if (!revisionMetadataRaw) {
      return res.status(404).json({
        status: 404,
        message: 'Revision not found',
      });
    }
    const revisionMetadata = parseRevisionMetadata(
      revisionMetadataRaw,
      revisionHash,
    );
    const revisionContent = await gitOutput(
      site.siteDirectory,
      ['show', revisionHash + ':' + fileData.location],
      false,
    );
    const jsonVariantLocation =
      typeof site.getPageAlternateLocation === 'function'
        ? site.getPageAlternateLocation(page.location, 'json')
        : '';
    let itemMetadata = null;
    if (jsonVariantLocation) {
      try {
        const itemMetadataRaw = await gitOutput(
          site.siteDirectory,
          ['show', revisionHash + ':' + jsonVariantLocation],
          false,
        );
        const parsedPayload = parseRevisionJSONPayload(itemMetadataRaw);
        itemMetadata = getItemMetadataFromPayload(parsedPayload);
      } catch (e) {}
    }
    const lookupValue = resolveLookupValue(item);
    const apiBasePath = getApiBasePath(req);
    return sendFormattedResponse(
      req,
      res,
      {
        nodeId: item.id,
        nodeSlug: item.slug || '',
        nodeTitle: item.title || '',
        revision: revisionMetadata,
        content: revisionContent,
        jsonVariantLocation: jsonVariantLocation || '',
        hasItemMetadata: !!itemMetadata,
        itemMetadata: itemMetadata,
        links: {
          self: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions/${encodeURIComponent(revisionHash)}`,
          revisions: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions`,
          restore: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions/${encodeURIComponent(revisionHash)}/restore`,
          item: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}`,
        },
      },
      {
        allowedFormats: ['json'],
        defaultFormat: 'json',
      },
    );
  } catch (e) {
    const message = e && e.message ? e.message : '';
    if (message.indexOf('does not exist') !== -1) {
      return res.status(404).json({
        status: 404,
        message: 'Revision content for this page was not found',
      });
    }
    return res.status(500).json({
      status: 500,
      message: message || 'Unable to load item revision detail',
    });
  }
}

async function restoreItemRevision(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      message:
        'Unable to resolve site context for /x/api/v1/items/:idOrSlug/revisions/:revisionId/restore',
    });
  }
  const idOrSlug =
    req && req.params && req.params.idOrSlug ? String(req.params.idOrSlug) : '';
  const item = findItemByIdOrSlug(site, idOrSlug);
  if (!item) {
    return res.status(404).json({
      status: 404,
      message: `Item not found for idOrSlug "${idOrSlug}"`,
    });
  }
  if (!item.id || typeof site.loadNode !== 'function') {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve item page context for revision restore',
    });
  }
  const page = site.loadNode(item.id);
  if (!page || !page.location) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve page location for revision restore',
    });
  }
  const fileData = sanitizePageLocation(site.siteDirectory, page.location);
  if (!fileData) {
    return res.status(400).json({
      status: 400,
      message: 'Invalid node file location',
    });
  }
  if (!fs.existsSync(fileData.absolutePath)) {
    return res.status(404).json({
      status: 404,
      message: 'Node file not found',
    });
  }
  const revisionHash =
    req && req.params && req.params.revisionId
      ? sanitizeRevisionId(req.params.revisionId)
      : '';
  if (revisionHash === '') {
    return res.status(400).json({
      status: 400,
      message: 'Invalid revision hash',
    });
  }
  try {
    const revisionContent = await gitOutput(
      site.siteDirectory,
      ['show', revisionHash + ':' + fileData.location],
      false,
    );
    const bytes = await page.writeLocation(revisionContent, site.siteDirectory);
    if (bytes === false) {
      return res.status(500).json({
        status: 500,
        message: 'Failed writing restored revision',
      });
    }
    const jsonVariantLocation =
      typeof site.getPageAlternateLocation === 'function'
        ? site.getPageAlternateLocation(page.location, 'json')
        : '';
    let itemMetadata = null;
    let itemMetadataRestored = false;
    if (jsonVariantLocation) {
      try {
        const itemMetadataRaw = await gitOutput(
          site.siteDirectory,
          ['show', revisionHash + ':' + jsonVariantLocation],
          false,
        );
        const parsedPayload = parseRevisionJSONPayload(itemMetadataRaw);
        itemMetadata = getItemMetadataFromPayload(parsedPayload);
        itemMetadataRestored = applyItemMetadataToPage(page, itemMetadata);
      } catch (e) {}
    }
    if (typeof site.writePageAlternateFormats === 'function') {
      await site.writePageAlternateFormats(page, revisionContent);
    }
    if (
      !page.metadata ||
      typeof page.metadata !== 'object' ||
      Array.isArray(page.metadata)
    ) {
      page.metadata = {};
    }
    const now = Math.floor(Date.now() / 1000);
    page.metadata.updated = now;
    if (
      site.manifest &&
      site.manifest.metadata &&
      site.manifest.metadata.site &&
      typeof site.manifest.metadata.site === 'object'
    ) {
      site.manifest.metadata.site.updated = now;
    }
    if (site.manifest && typeof site.manifest.save === 'function') {
      await site.manifest.save();
    }
    if (typeof site.gitCommit === 'function') {
      await site.gitCommit(
        'Page revision restored: ' +
          (page.title || 'Untitled') +
          ' (' +
          page.id +
          ') from ' +
          revisionHash.substring(0, 12),
      );
    }
    const lookupValue = resolveLookupValue(item);
    const apiBasePath = getApiBasePath(req);
    return sendFormattedResponse(
      req,
      res,
      {
        nodeId: item.id,
        nodeSlug: item.slug || '',
        nodeTitle: page.title || item.title || '',
        restoredFromHash: revisionHash,
        jsonVariantLocation: jsonVariantLocation || '',
        hasItemMetadata: !!itemMetadata,
        itemMetadataRestored: itemMetadataRestored,
        links: {
          self: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions/${encodeURIComponent(revisionHash)}/restore`,
          revision: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions/${encodeURIComponent(revisionHash)}`,
          revisions: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}/revisions`,
          item: `${apiBasePath}/v1/items/${encodeURIComponent(lookupValue)}`,
        },
      },
      {
        allowedFormats: ['json'],
        defaultFormat: 'json',
      },
    );
  } catch (e) {
    const message = e && e.message ? e.message : '';
    if (message.indexOf('does not exist') !== -1) {
      return res.status(404).json({
        status: 404,
        message: 'Revision content for this page was not found',
      });
    }
    return res.status(500).json({
      status: 500,
      message: message || 'Unable to restore item revision',
    });
  }
}

module.exports = {
  listItemRevisions,
  itemRevisionDetail,
  restoreItemRevision,
};
