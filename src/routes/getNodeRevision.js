const fs = require('fs');
const path = require('path');
const util = require('node:util');
const child_process = require('node:child_process');
const execFile = util.promisify(child_process.execFile);
const { HAXCMS } = require('../lib/HAXCMS.js');

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
 *    path="/getNodeRevision",
 *    tags={"cms","authenticated","node","git"},
 *    @OA\Response(
 *        response="200",
 *        description="Get page content for a specific git hash"
 *   )
 * )
 */
async function getNodeRevision(req, res) {
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
    const metadataRaw = await gitOutput(
      site.siteDirectory,
      [
        'show',
        '--quiet',
        '--date=iso-strict',
        '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ad%x1f%s',
        hash,
      ],
      false,
    );
    if (!metadataRaw) {
      return failed(res, 404, 'Revision not found');
    }
    const metadataParts = metadataRaw.trim().split('\u001f');
    const revisionMetadata = {
      hash: metadataParts[0] || hash,
      shortHash: metadataParts[1] || hash.substring(0, 7),
      author: metadataParts[2] || '',
      authorEmail: metadataParts[3] || '',
      timestamp: parseInt(metadataParts[4], 10) || 0,
      date: metadataParts[5] || '',
      message: metadataParts[6] || '',
    };
    const fileContent = await gitOutput(
      site.siteDirectory,
      ['show', hash + ':' + fileData.location],
      false,
    );
    return res.send({
      status: 200,
      data: {
        nodeId: page.id,
        nodeTitle: page.title || '',
        revision: revisionMetadata,
        content: fileContent,
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
      message || 'Unable to load node revision',
    );
  }
}

module.exports = getNodeRevision;
