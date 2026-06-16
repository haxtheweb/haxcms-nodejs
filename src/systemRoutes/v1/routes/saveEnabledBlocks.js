const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../../../lib/HAXCMS.js');

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

function enabledBlocksPayload(req) {
  if (!req || !req.body) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'enabledBlocks')) {
    return req.body.enabledBlocks;
  }
  return req.body;
}

/**
 * @OA\Post(
 *    path="/saveEnabledBlocks",
 *    tags={"cms","authenticated","settings"},
 *    @OA\Response(
 *        response="200",
 *        description="Persist enabled blocks settings"
 *   )
 * )
 */
async function saveEnabledBlocks(req, res) {
  const payload = enabledBlocksPayload(req);
  if (typeof payload === 'undefined') {
    return res.status(400).json({
      status: 400,
      message: 'Missing enabledBlocks payload',
    });
  }
  const enabledBlocks = normalizeEnabledBlocks(payload);
  if (!enabledBlocks) {
    return res.status(400).json({
      status: 400,
      message: 'Invalid enabledBlocks payload',
    });
  }

  const settingsDir = path.join(HAXCMS.configDirectory, 'settings');
  const filePath = path.join(settingsDir, 'enabledBlocks.json');
  await fs.ensureDir(settingsDir);
  await fs.writeFile(filePath, JSON.stringify(enabledBlocks, null, 2));

  return res.json({
    status: 200,
    data: {
      enabledBlocks,
    },
  });
}

module.exports = saveEnabledBlocks;
