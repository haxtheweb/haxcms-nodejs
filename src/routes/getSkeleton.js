const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../lib/HAXCMS.js');

function normalizeSkeletonLookupName(value = '') {
  if (typeof value !== 'string') {
    return '';
  }
  const safeValue = path.basename(value).replace(/\.json$/i, '').trim();
  if (safeValue === '') {
    return '';
  }
  const normalized = HAXCMS.generateMachineName(safeValue);
  if (
    !normalized ||
    (normalized === 'default' && safeValue.toLowerCase() !== 'default')
  ) {
    return '';
  }
  return normalized;
}

async function resolveSkeletonByName(skeletonName = '') {
  const normalizedTarget = normalizeSkeletonLookupName(skeletonName);
  if (!normalizedTarget) {
    return null;
  }
  // directories to search for skeleton files
  // precedence: user > config (deployment) > core
  const dirs = [
    path.join(HAXCMS.configDirectory, 'user', 'skeletons'),
    path.join(HAXCMS.configDirectory, 'skeletons'),
    path.join(HAXCMS.coreConfigPath, 'skeletons'),
  ];
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    if (!(await fs.pathExists(dir))) {
      continue;
    }
    let files = [];
    try {
      files = await fs.readdir(dir);
    }
    catch (e) {
      continue;
    }
    for (let j = 0; j < files.length; j++) {
      const file = files[j];
      if (file === '.' || file === '..') {
        continue;
      }
      const filePath = path.join(dir, file);
      let stats = null;
      try {
        stats = await fs.stat(filePath);
      }
      catch (e) {
        continue;
      }
      if (
        !stats ||
        !stats.isFile() ||
        path.extname(file).toLowerCase() !== '.json'
      ) {
        continue;
      }
      let skeleton = null;
      try {
        const json = await fs.readFile(filePath, 'utf8');
        skeleton = JSON.parse(json);
      }
      catch (e) {
        continue;
      }
      if (!skeleton || typeof skeleton !== 'object' || Array.isArray(skeleton)) {
        continue;
      }
      const normalizedFileName = normalizeSkeletonLookupName(
        path.basename(file, '.json'),
      );
      const meta = (
        skeleton.meta &&
        typeof skeleton.meta === 'object' &&
        !Array.isArray(skeleton.meta)
      ) ? skeleton.meta : {};
      const normalizedMetaMachineName = normalizeSkeletonLookupName(
        typeof meta.machineName === 'string' ? meta.machineName : '',
      );
      const normalizedMetaName = normalizeSkeletonLookupName(
        typeof meta.name === 'string' ? meta.name : '',
      );
      if (
        normalizedTarget === normalizedFileName ||
        (normalizedMetaMachineName &&
          normalizedTarget === normalizedMetaMachineName) ||
        (normalizedMetaName && normalizedTarget === normalizedMetaName)
      ) {
        return skeleton;
      }
    }
  }
  return null;
}

/**
 * Get a specific skeleton file by name.
 * Returns the skeleton JSON data.
 * Requires a valid user_token and JWT.
 *
 * @OA\Get(
 *    path="/getSkeleton",
 *    tags={"cms"},
 *    @OA\Parameter(
 *         name="name",
 *         description="Skeleton file name (without .json extension)",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Returns skeleton JSON data"
 *   )
 * )
 */
async function getSkeleton(req, res) {
  // Validate user_token like listSites
  if (!req.query.user_token || !HAXCMS.validateRequestToken(req.query.user_token, HAXCMS.getActiveUserName())) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }

  const skeletonName = req.query.name;
  if (!skeletonName) {
    return res.status(400).json({
      status: 400,
      message: 'skeleton name is required',
    });
  }
  const skeleton = await resolveSkeletonByName(skeletonName);
  if (skeleton) {
    return res.json({
      status: 200,
      data: skeleton,
    });
  }

  return res.status(404).json({
    status: 404,
    message: 'skeleton not found',
  });
}

module.exports = getSkeleton;
