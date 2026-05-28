const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../lib/HAXCMS.js');

function normalizeEnabledBlocks(input = []) {
  if (!Array.isArray(input)) {
    return null;
  }
  const output = [];
  for (let i = 0; i < input.length; i++) {
    if (typeof input[i] !== 'string') {
      return null;
    }
    const tag = input[i].trim().toLowerCase();
    if (tag === '') {
      return null;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
      return null;
    }
    output.push(tag);
  }
  return [...new Set(output)].sort();
}

async function readEnabledBlocksSetting() {
  const filePath = path.join(
    HAXCMS.configDirectory,
    'settings',
    'enabledBlocks.json',
  );
  if (!(await fs.pathExists(filePath))) {
    return null;
  }
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return normalizeEnabledBlocks(parsed);
}

function defaultAutoloaderList() {
  return [
    'grid-plate',
  ];
}

/**
 * @OA\Get(
 *    path="/systemBlocksList",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Return system block inventory for AppHAX system settings"
 *   )
 * )
 */
async function systemBlocksList(req, res) {
  if (
    !req.query.user_token ||
    !HAXCMS.validateRequestToken(req.query.user_token, HAXCMS.getActiveUserName())
  ) {
    return res.status(403).json({
      status: 403,
      message: 'invalid request token',
    });
  }

  let autoloader = defaultAutoloaderList();
  if (
    HAXCMS.config &&
    HAXCMS.config.appStore &&
    HAXCMS.config.appStore.autoloader
  ) {
    autoloader = HAXCMS.config.appStore.autoloader;
  }
  const enabledBlocks = await readEnabledBlocksSetting();
  return res.json({
    status: 200,
    apps: [],
    stax: [],
    autoloader,
    enabledBlocks: Array.isArray(enabledBlocks) ? enabledBlocks : [],
  });
}

module.exports = systemBlocksList;
