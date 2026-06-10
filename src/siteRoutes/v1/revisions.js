const fs = require('fs');
const path = require('path');
const util = require('node:util');
const child_process = require('node:child_process');
const execFile = util.promisify(child_process.execFile);
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

module.exports = {
  listItemRevisions,
};
