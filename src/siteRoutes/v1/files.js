const path = require('path');
const mime = require('mime');
const { HAXCMS } = require('../../lib/HAXCMS.js');
const {
  getApiBasePath,
  getCsvQuery,
  getQueryValue,
  sortRecords,
  paginateRecords,
  projectCollection,
  resolveSiteForRequest,
  collectSiteFiles,
  normalizePathForResponse,
  sendFormattedResponse,
} = require('./siteRouteUtils.js');

function isMultisiteContext(site) {
  if (HAXCMS.operatingContext === 'multisite') {
    return true;
  }
  if (
    typeof HAXCMS.getDeploymentProfile === 'function' &&
    HAXCMS.getDeploymentProfile() === 'self-hosted-multi-site'
  ) {
    return true;
  }
  if (site && typeof site.siteDirectory === 'string' && site.siteDirectory) {
    const normalizedSiteDirectory = normalizePathForResponse(site.siteDirectory);
    const multisitePathMarker = '/' + HAXCMS.sitesDirectory + '/';
    if (normalizedSiteDirectory.indexOf(multisitePathMarker) !== -1) {
      return true;
    }
  }
  return false;
}

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

function getDateCreatedValue(entryStats) {
  if (!entryStats || typeof entryStats !== 'object') {
    return 0;
  }
  let createdMs = 0;
  if (
    typeof entryStats.mtimeMs === 'number' &&
    Number.isFinite(entryStats.mtimeMs) &&
    entryStats.mtimeMs > 0
  ) {
    createdMs = entryStats.mtimeMs;
  }
  else if (
    typeof entryStats.ctimeMs === 'number' &&
    Number.isFinite(entryStats.ctimeMs) &&
    entryStats.ctimeMs > 0
  ) {
    createdMs = entryStats.ctimeMs;
  }
  else if (
    typeof entryStats.birthtimeMs === 'number' &&
    Number.isFinite(entryStats.birthtimeMs) &&
    entryStats.birthtimeMs > 0
  ) {
    createdMs = entryStats.birthtimeMs;
  }
  if (createdMs <= 0) {
    return 0;
  }
  return Math.round(createdMs);
}

function toFileRecord(site, file) {
  const apiPath = `files/${file.relativePath}`;
  const dateCreated = getDateCreatedValue(file.stats);
  const baseFileUrl = buildFilePublicUrl(site, apiPath);
  return {
    path: apiPath,
    fullUrl:
      baseFileUrl +
      (dateCreated
        ? (baseFileUrl.indexOf('?') === -1 ? '?t=' : '&t=') + dateCreated
        : ''),
    url: apiPath,
    mimetype: mime.getType(file.absolutePath) || '',
    name: path.basename(apiPath),
    size:
      file && file.stats && typeof file.stats.size === 'number'
        ? file.stats.size
        : 0,
    dateCreated: dateCreated,
  };
}

function applyFileFilters(records, req) {
  const filterType = String(getQueryValue(req, 'filter.type', '') || '')
    .trim()
    .toLowerCase();
  const filterExtension = String(
    getQueryValue(req, 'filter.extension', '') || '',
  )
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
  const filterStartsWith = String(
    getQueryValue(req, 'filter.startsWith', '') || '',
  )
    .trim()
    .toLowerCase();
  const filterNameContains = String(
    getQueryValue(req, 'filter.nameContains', '') || '',
  )
    .trim()
    .toLowerCase();
  return records.filter((record) => {
    const mimetype = String(record.mimetype || '').toLowerCase();
    const name = String(record.name || '').toLowerCase();
    const recordPath = String(record.path || '').toLowerCase();
    if (filterType !== '' && mimetype.indexOf(filterType) !== 0) {
      return false;
    }
    if (filterExtension !== '' && !name.endsWith(`.${filterExtension}`)) {
      return false;
    }
    if (filterStartsWith !== '' && recordPath.indexOf(filterStartsWith) !== 0) {
      return false;
    }
    if (filterNameContains !== '' && name.indexOf(filterNameContains) === -1) {
      return false;
    }
    return true;
  });
}

async function files(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/files',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  const siteFilePath = path.join(site.siteDirectory, 'files');
  const records = collectSiteFiles(
    site,
    siteFilePath,
    getQueryValue(req, 'filename', ''),
  ).map((file) => toFileRecord(site, file));
  let filteredRecords = applyFileFilters(records, req);
  filteredRecords = sortRecords(
    filteredRecords,
    getQueryValue(req, 'sort', ''),
    'path',
  );
  const paged = paginateRecords(filteredRecords, req, 25, 500);
  const outputRecords = projectCollection(paged.records, fields);
  return sendFormattedResponse(
    req,
    res,
    {
      count: outputRecords.length,
      total: paged.page.total,
      page: paged.page,
      files: outputRecords,
      links: {
        self: `${apiBasePath}/v1/files`,
      },
    },
    {
      allowedFormats: ['json', 'md', 'yaml', 'xml'],
      defaultFormat: 'json',
    },
  );
}

module.exports = files;
