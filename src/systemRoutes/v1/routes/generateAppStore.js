const { HAXCMS } = require('../../../lib/HAXCMS.js');
const HAXAppStoreService = require('../../../lib/HAXAppStoreService.js');
const AppStoreService = new HAXAppStoreService();
const { readEffectiveApiKeys } = require('../../../lib/apiKeys.js');
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

function buildProviderConnectionMap() {
  return {
    'www.googleapis.com/youtube/v3|search': 'youtube',
    'api.vimeo.com|videos': 'vimeo',
    'api.giphy.com|v1/gifs/search': 'giphy',
    'api.unsplash.com|search/photos': 'unsplash',
    'api.flickr.com|services/rest': 'flickr',
    'images-api.nasa.gov|search': 'nasa',
    'api.sketchfab.com|v3/search': 'sketchfab',
    'api.dailymotion.com|videos': 'dailymotion',
    'en.wikipedia.org|w/api.php': 'wikipedia',
    'ccmixter.org|api/query': 'ccmixter',
  };
}

function normalizeConnectionSegment(value = '') {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function resolveProviderForApp(app, providerConnectionMap) {
  if (!app || !app.connection || typeof app.connection !== 'object') {
    return '';
  }
  if (!app.connection.operations || !app.connection.operations.browse) {
    return '';
  }
  const connectionUrl = normalizeConnectionSegment(app.connection.url);
  const browseEndPoint = normalizeConnectionSegment(
    app.connection.operations.browse.endPoint,
  );
  const signature = `${connectionUrl}|${browseEndPoint}`;
  if (Object.prototype.hasOwnProperty.call(providerConnectionMap, signature)) {
    return providerConnectionMap[signature];
  }
  return '';
}

function parseConnectionUrl(urlString = '') {
  try {
    let parseTarget = `${urlString || ''}`.trim();
    if (!/^[a-z]+:\/\//i.test(parseTarget)) {
      parseTarget = `https://${parseTarget.replace(/^\/+/, '')}`;
    }
    const parsed = new URL(parseTarget);
    const params = {};
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return {
      valid: true,
      params,
    };
  }
  catch (e) {
    return {
      valid: false,
      params: {},
    };
  }
}

function mergeConnectionData(base = {}, extra = {}) {
  const merged = {};
  const baseKeys = Object.keys(base || {});
  for (let i = 0; i < baseKeys.length; i++) {
    const key = baseKeys[i];
    merged[key] = base[key];
  }
  const extraKeys = Object.keys(extra || {});
  for (let i = 0; i < extraKeys.length; i++) {
    const key = extraKeys[i];
    merged[key] = extra[key];
  }
  return merged;
}

function sanitizeBrokerConnectionData(input = {}) {
  const blockedAuthParams = {
    key: true,
    access_token: true,
    api_key: true,
    client_id: true,
    provider: true,
    appstore_token: true,
    site_token: true,
    siteToken: true,
    siteName: true,
  };
  const sanitized = {};
  const keys = Object.keys(input || {});
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (blockedAuthParams[key]) {
      continue;
    }
    sanitized[key] = input[key];
  }
  return sanitized;
}
function getSiteTokenFromHeader(req) {
  if (!req || !req.headers || typeof req.headers !== 'object') {
    return '';
  }
  const rawValue = req.headers['x-haxcms-site-token'];
  if (Array.isArray(rawValue)) {
    return rawValue.length > 0 ? String(rawValue[0] || '').trim() : '';
  }
  if (typeof rawValue === 'string') {
    return rawValue.trim();
  }
  return '';
}

function getSiteApiPathForBroker(req) {
  const siteName =
    req &&
    req.query &&
    req.query.siteName
      ? String(req.query.siteName).trim()
      : '';
  if (siteName !== '') {
    return `${HAXCMS.sitesDirectory}/${encodeURIComponent(siteName)}/x/api`;
  }
  return 'x/api';
}

function rewriteConnectionToBroker(connection, provider, req) {
  const parsed = parseConnectionUrl(connection.url || '');
  const mergedData = sanitizeBrokerConnectionData(
    mergeConnectionData(parsed.params, connection.data || {}),
  );
  const rewrittenHeaders =
    connection.headers && typeof connection.headers === 'object'
      ? { ...connection.headers }
      : {};
  const siteToken = getSiteTokenFromHeader(req);
  if (
    siteToken !== '' &&
    !Object.prototype.hasOwnProperty.call(
      rewrittenHeaders,
      'X-HAXCMS-Site-Token',
    ) &&
    !Object.prototype.hasOwnProperty.call(
      rewrittenHeaders,
      'x-haxcms-site-token',
    )
  ) {
    rewrittenHeaders['X-HAXCMS-Site-Token'] = siteToken;
  }
  const browseOperation = (
    connection.operations &&
    connection.operations.browse &&
    typeof connection.operations.browse === 'object'
  ) ? connection.operations.browse : {};
  const normalizedDomain = String(HAXCMS.domain || '').replace(/\/+$/, '');
  const normalizedBasePath = String(HAXCMS.basePath || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const rewrittenUrl = normalizedBasePath
    ? `${normalizedDomain}/${normalizedBasePath}`
    : normalizedDomain;
  return {
    ...connection,
    protocol: HAXCMS.protocol,
    url: rewrittenUrl,
    headers: rewrittenHeaders,
    data: mergedData,
    operations: {
      ...(connection.operations || {}),
      browse: {
        ...browseOperation,
        method: browseOperation.method || 'GET',
        endPoint: `${getSiteApiPathForBroker(req)}/v1/integrations/app-store/providers/${encodeURIComponent(provider)}/search`,
      },
    },
  };
}
/**
 * @OA\Get(
 *    path="/generateAppStore",
 *    tags={"hax","api"},
 *    @OA\Parameter(
 *         name="site_token",
 *         description="security token for appstore generation",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Parameter(
 *         name="siteName",
 *         description="site context used to validate site token",
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
  const siteToken = getSiteTokenFromHeader(req);
  const siteName =
    req && req.query && req.query.siteName
      ? String(req.query.siteName).trim()
      : '';
  // test if this is a valid user login with this specialty token that HAX looks for
  if (
    siteToken !== '' &&
    siteName !== '' &&
    HAXCMS.validateRequestToken(
      siteToken,
      HAXCMS.getActiveUserName() + ':' + siteName,
      req.query
    )
  ) {
    const effectiveApiKeys = await readEffectiveApiKeys(HAXCMS);
    const baseApps = AppStoreService.baseSupportedApps();
    const providerConnectionMap = buildProviderConnectionMap();
    const loadKeys = {};
    const baseAppKeys = Object.keys(baseApps || {});
    for (let i = 0; i < baseAppKeys.length; i++) {
      const key = baseAppKeys[i];
      const value = effectiveApiKeys[key];
      if (typeof value === 'string' && value !== '') {
        loadKeys[key] = value;
      }
    }
    let appStore = AppStoreService.loadBaseAppStore(loadKeys);
    const rewrittenApps = [];
    for (let i = 0; i < appStore.length; i++) {
      const app = appStore[i];
      if (!app || typeof app !== 'object') {
        continue;
      }
      const provider = resolveProviderForApp(app, providerConnectionMap);
      if (provider && app.connection && typeof app.connection === 'object') {
        rewrittenApps.push({
          ...app,
          connection: rewriteConnectionToBroker(app.connection, provider, req),
        });
      }
      else {
        rewrittenApps.push(app);
      }
    }
    appStore = rewrittenApps;
    // pull in the core one we supply, though only upload works currently
    let tmp = HAXCMS.siteConnectionJSON(
      siteToken,
      siteName,
    );
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
