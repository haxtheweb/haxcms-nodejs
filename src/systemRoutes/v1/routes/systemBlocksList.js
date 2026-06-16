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

function normalizeBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'true' ||
      normalized === '1' ||
      normalized === 'yes' ||
      normalized === 'on'
    ) {
      return true;
    }
    if (
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'no' ||
      normalized === 'off'
    ) {
      return false;
    }
  }
  return defaultValue;
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

function resolveEnabledFilter(req) {
  const hasEnabledQuery = (
    req &&
    req.query &&
    Object.prototype.hasOwnProperty.call(req.query, 'enabled')
  );
  const hasEnabledBody = (
    req &&
    req.body &&
    Object.prototype.hasOwnProperty.call(req.body, 'enabled')
  );
  if (hasEnabledQuery || hasEnabledBody) {
    const rawEnabled = hasEnabledQuery ? req.query.enabled : req.body.enabled;
    return normalizeBoolean(rawEnabled, true) ? 'enabled' : 'disabled';
  }
  return 'all';
}

function filterAutoloaderByEnabledState(autoloader, enabledFilter, enabledSet) {
  if (enabledFilter === 'all') {
    return autoloader;
  }
  const hasEnabledSet = enabledSet && enabledSet.size > 0;
  if (Array.isArray(autoloader)) {
    if (!hasEnabledSet) {
      return enabledFilter === 'enabled' ? [] : autoloader;
    }
    return autoloader.filter((item) => {
      if (typeof item !== 'string') {
        return false;
      }
      const isEnabled = enabledSet.has(item.toLowerCase());
      return enabledFilter === 'enabled' ? isEnabled : !isEnabled;
    });
  }
  if (autoloader && typeof autoloader === 'object') {
    const filtered = {};
    const keys = Object.keys(autoloader);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const isEnabled = hasEnabledSet && enabledSet.has(String(key).toLowerCase());
      if (
        (enabledFilter === 'enabled' && isEnabled) ||
        (enabledFilter === 'disabled' && !isEnabled)
      ) {
        filtered[key] = autoloader[key];
      }
    }
    return filtered;
  }
  return autoloader;
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
  let autoloader = defaultAutoloaderList();
  if (
    HAXCMS.config &&
    HAXCMS.config.appStore &&
    HAXCMS.config.appStore.autoloader
  ) {
    autoloader = HAXCMS.config.appStore.autoloader;
  }
  const enabledBlocks = await readEnabledBlocksSetting();
  const enabledFilter = resolveEnabledFilter(req);
  const enabledSet = new Set(Array.isArray(enabledBlocks) ? enabledBlocks : []);
  const filteredAutoloader = filterAutoloaderByEnabledState(
    autoloader,
    enabledFilter,
    enabledSet,
  );
  return res.json({
    status: 200,
    apps: [],
    stax: [],
    autoloader: filteredAutoloader,
    enabledBlocks: Array.isArray(enabledBlocks) ? enabledBlocks : [],
  });
}

module.exports = systemBlocksList;
