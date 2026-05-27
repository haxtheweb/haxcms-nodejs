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
 *    path="/getNodeRevisions",
 *    tags={"cms","authenticated","node","git"},
 *    @OA\Response(
 *        response="200",
 *        description="List git revisions for a single node file"
 *   )
 * )
 */
async function getNodeRevisions(req, res) {
  if (
    !req.body ||
    !req.body.site ||
    !req.body.site.name ||
    !req.body.node ||
    !req.body.node.id
  ) {
    return failed(res, 400, 'Missing required body fields: site.name and node.id');
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

  let limit = parseInt(req.body.limit, 10);
  if (isNaN(limit) || limit < 1) {
    limit = 25;
  }
  if (limit > 200) {
    limit = 200;
  }
  let offset = parseInt(req.body.offset, 10);
  if (isNaN(offset) || offset < 0) {
    offset = 0;
  }

  const logFormat =
    '%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ad%x1f%s';
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
    const revisions = [];
    if (logRaw) {
      const lines = logRaw.split('\n');
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
          timestamp: isNaN(timestamp) ? 0 : timestamp,
          date: parts[5],
          message: parts[6],
        });
      }
    }
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
          .map((item) => item.trim())
          .filter((item) => item !== '').length;
      } else {
        total = 0;
      }
    } catch (e) {}
    const jsonVariantLocation = site.getPageAlternateLocation(
      page.location,
      'json',
    );

    return res.send({
      status: 200,
      data: {
        nodeId: page.id,
        nodeTitle: page.title || '',
        jsonVariantLocation: jsonVariantLocation || '',
        limit: limit,
        offset: offset,
        total: total,
        revisions: revisions,
      },
    });
  } catch (e) {
    return failed(
      res,
      500,
      e && e.message ? e.message : 'Unable to load node revisions',
    );
  }
}

module.exports = getNodeRevisions;
