const fs = require('fs');
const path = require('path');
const util = require('node:util');
const child_process = require('node:child_process');
const execFile = util.promisify(child_process.execFile);
const { HAXCMS } = require('../lib/HAXCMS.js');
const stripTagsImport = require('locutus/php/strings/strip_tags');
const strip_tags = stripTagsImport.strip_tags || stripTagsImport;
const { sanitizeURLValue } = require('../lib/sanitizeContent.js');

function failed(res, status, message) {
  return res.status(status).send({
    __failed: {
      status: status,
      message: message,
    },
  });
}

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
  if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
    itemMetadata.title = payload.title;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
    itemMetadata.description = payload.description;
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
  if (!page.metadata || typeof page.metadata !== 'object' || Array.isArray(page.metadata)) {
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
  if (!itemMetadata || typeof itemMetadata !== 'object' || Array.isArray(itemMetadata)) {
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

/**
 * @OA\Post(
 *    path="/restoreNodeRevision",
 *    tags={"cms","authenticated","node","git"},
 *    @OA\Response(
 *        response="200",
 *        description="Restore a page revision as a new commit"
 *   )
 * )
 */
async function restoreNodeRevision(req, res) {
  if (
    !req.body ||
    !req.body.site ||
    !req.body.site.name ||
    !req.body.node ||
    !req.body.node.id ||
    !req.body.hash
  ) {
    return failed(
      res,
      400,
      'Missing required body fields: site.name, node.id and hash',
    );
  }
  const siteName = req.body.site.name;
  if (
    !req.query.site_token ||
    !HAXCMS.validateRequestToken(
      req.query.site_token,
      HAXCMS.getActiveUserName() + ':' + siteName,
    )
  ) {
    return failed(res, 403, 'Invalid site token');
  }
  const site = await HAXCMS.loadSite(siteName);
  if (!site || !site.siteDirectory) {
    return failed(res, 404, 'Site not found');
  }
  const page = site.loadNode(req.body.node.id);
  if (!page) {
    return failed(res, 404, 'Node not found');
  }
  const fileData = sanitizePageLocation(site.siteDirectory, page.location);
  if (!fileData) {
    return failed(res, 400, 'Invalid node file location');
  }
  if (!fs.existsSync(fileData.absolutePath)) {
    return failed(res, 404, 'Node file not found');
  }
  const hash = String(req.body.hash).trim();
  if (!/^[a-fA-F0-9]{7,64}$/.test(hash)) {
    return failed(res, 400, 'Invalid revision hash');
  }

  try {
    const revisionContent = await gitOutput(
      site.siteDirectory,
      ['show', hash + ':' + fileData.location],
      false,
    );
    const bytes = await page.writeLocation(
      revisionContent,
      site.siteDirectory,
    );
    if (bytes === false) {
      return failed(res, 500, 'Failed writing restored revision');
    }
    const jsonVariantLocation = site.getPageAlternateLocation(
      page.location,
      'json',
    );
    let itemMetadata = null;
    let itemMetadataRestored = false;
    if (jsonVariantLocation) {
      try {
        const itemMetadataRaw = await gitOutput(
          site.siteDirectory,
          ['show', hash + ':' + jsonVariantLocation],
          false,
        );
        const parsedPayload = parseRevisionJSONPayload(itemMetadataRaw);
        itemMetadata = getItemMetadataFromPayload(parsedPayload);
        itemMetadataRestored = applyItemMetadataToPage(page, itemMetadata);
      } catch (e) {}
    }

    await site.writePageAlternateFormats(page, revisionContent);
    if (!page.metadata) {
      page.metadata = {};
    }
    const now = Math.floor(Date.now() / 1000);
    page.metadata.updated = now;
    site.manifest.metadata.site.updated = now;
    await site.manifest.save();
    await site.gitCommit(
      'Page revision restored: ' +
        (page.title || 'Untitled') +
        ' (' +
        page.id +
        ') from ' +
        hash.substring(0, 12),
    );

    return res.send({
      status: 200,
      data: {
        nodeId: page.id,
        nodeTitle: page.title || '',
        restoredFromHash: hash,
        jsonVariantLocation: jsonVariantLocation || '',
        hasItemMetadata: !!itemMetadata,
        itemMetadataRestored: itemMetadataRestored,
      },
    });
  } catch (e) {
    const message = e && e.message ? e.message : '';
    if (message.indexOf('does not exist') !== -1) {
      return failed(res, 404, 'Revision content for this page was not found');
    }
    return failed(
      res,
      500,
      message || 'Unable to restore node revision',
    );
  }
}

module.exports = restoreNodeRevision;
