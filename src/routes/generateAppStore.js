const { HAXCMS } = require('../lib/HAXCMS.js');
const HAXAppStoreService = require('../lib/HAXAppStoreService.js');
const AppStoreService = new HAXAppStoreService();
const fs = require('fs-extra');
const path = require('path');

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


function filterAutoloaderList(autoloaderList, enabledSet) {
  if (!enabledSet || enabledSet.size === 0) {
    if (Array.isArray(autoloaderList)) {
      return [];
    }
    if (autoloaderList && typeof autoloaderList === 'object') {
      return {};
    }
    return autoloaderList;
  }
  if (Array.isArray(autoloaderList)) {
    return autoloaderList.filter((item) => {
      if (typeof item !== 'string') {
        return false;
      }
      return enabledSet.has(item.toLowerCase());
    });
  }
  if (autoloaderList && typeof autoloaderList === 'object') {
    const filtered = {};
    const keys = Object.keys(autoloaderList);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (enabledSet.has(key.toLowerCase())) {
        filtered[key] = autoloaderList[key];
      }
    }
    return filtered;
  }
  return autoloaderList;
}
/**
 * @OA\Get(
 *    path="/generateAppStore",
 *    tags={"hax","api"},
 *    @OA\Parameter(
 *         name="appstore_token",
 *         description="security token for appstore",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Generate the AppStore spec for HAX editor directions"
 *   )
 * )
 */
async function generateAppStore(req, res) {
  let returnData = {};
  // test if this is a valid user login with this specialty token that HAX looks for
  if (
    req.query['appstore_token'] &&
    HAXCMS.validateRequestToken(req.query['appstore_token'], 'appstore', req.query) &&
    req.query['site_token'] &&
    req.query['siteName'] &&
    HAXCMS.validateRequestToken(
      req.query['site_token'],
      HAXCMS.getActiveUserName() + ':' + req.query['siteName'],
      req.query
    )
  ) {
    let apikeys = {};
    let baseApps = AppStoreService.baseSupportedApps();
    for (var key in baseApps) {
      if (
        HAXCMS.config.appStore.apiKeys[key] &&
        HAXCMS.config.appStore.apiKeys[key] != ''
      ) {
        apikeys[key] = HAXCMS.config.appStore.apiKeys[key];
      }
    }
    let appStore = AppStoreService.loadBaseAppStore(apikeys);
    // pull in the core one we supply, though only upload works currently
    let tmp = HAXCMS.siteConnectionJSON(req.query['site_token']);
    appStore.push(tmp);
    let staxList,autoloaderList;
    if (HAXCMS.config.appStore && HAXCMS.config.appStore.stax) {
        staxList = HAXCMS.config.appStore.stax;
    } else {
        staxList = AppStoreService.loadBaseStax();
    }
    if (HAXCMS.config.appStore && HAXCMS.config.appStore.autoloader) {
        autoloaderList = HAXCMS.config.appStore.autoloader;
    } else {
      // should not be possible but at least load something if they bricked their autoloader manually
        autoloaderList = 
      [
        "grid-plate",
      ];
    }
    const enabledBlocks = await readEnabledBlocksSetting();
    const enabledSet = enabledBlocks ? new Set(enabledBlocks) : null;
    const finalAutoloaderList = enabledSet
      ? filterAutoloaderList(autoloaderList, enabledSet)
      : autoloaderList;
    returnData = {
        'status': 200,
        'apps': appStore,
        'stax': staxList,
        'autoloader': finalAutoloaderList
    };
  }
  res.send(returnData);
}
  module.exports = generateAppStore;
