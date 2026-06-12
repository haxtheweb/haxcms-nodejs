const { HAXCMS } = require('../lib/HAXCMS.js');
const {
  discoverThemes,
  readEnabledThemeMap,
  writeEnabledThemeMap,
  applyDetectedThemeDefaults,
  isThemeEnabled,
  themesToMap,
} = require('../lib/themeSettings.js');
const fs = require('fs');
const path = require('path');
const url = require('url');
const YAML = require('yaml');

let cachedSystemOpenApiOperationPaths = null;

function stripLeadingSlash(pathValue = '') {
  return String(pathValue || '').replace(/^\/+/, '');
}

function normalizePath(pathValue = '') {
  let normalized = String(pathValue || '');
  if (normalized === '') {
    return '/';
  }
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.charAt(0) !== '/') {
    normalized = '/' + normalized;
  }
  if (
    normalized.length > 1 &&
    normalized.charAt(normalized.length - 1) === '/'
  ) {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}

function appendQueryParams(pathValue = '', params = {}) {
  const target = typeof pathValue === 'string' ? pathValue.trim() : '';
  if (!target) {
    return '';
  }
  const hashIndex = target.indexOf('#');
  const baseWithQuery = hashIndex === -1 ? target : target.substring(0, hashIndex);
  const hash = hashIndex === -1 ? '' : target.substring(hashIndex);
  const queryIndex = baseWithQuery.indexOf('?');
  const basePath =
    queryIndex === -1
      ? baseWithQuery
      : baseWithQuery.substring(0, queryIndex);
  const existingQuery =
    queryIndex === -1 ? '' : baseWithQuery.substring(queryIndex + 1);
  const searchParams = new URLSearchParams(existingQuery);
  const payload =
    params && typeof params === 'object' && !Array.isArray(params)
      ? params
      : {};
  const keys = Object.keys(payload);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = payload[key];
    if (typeof value === 'undefined' || value === null) {
      continue;
    }
    const normalizedValue = `${value}`.trim();
    if (!normalizedValue) {
      continue;
    }
    searchParams.set(key, normalizedValue);
  }
  const query = searchParams.toString();
  return `${basePath}${query ? `?${query}` : ''}${hash}`;
}

function getSystemOpenApiOperationPaths() {
  if (cachedSystemOpenApiOperationPaths) {
    return cachedSystemOpenApiOperationPaths;
  }
  const operationPaths = {};
  try {
    const systemSpecPath = path.join(
      __dirname,
      '..',
      'openapi',
      'system-spec.yaml',
    );
    const systemSpecFile = fs.readFileSync(systemSpecPath, 'utf8');
    const parsedSpec = YAML.parse(systemSpecFile);
    const specPaths =
      parsedSpec &&
      parsedSpec.paths &&
      typeof parsedSpec.paths === 'object'
        ? parsedSpec.paths
        : {};
    const httpMethods = ['get', 'post', 'put', 'patch', 'delete'];
    const specPathKeys = Object.keys(specPaths);
    for (let i = 0; i < specPathKeys.length; i++) {
      const specPathKey = specPathKeys[i];
      const pathConfig = specPaths[specPathKey];
      if (!pathConfig || typeof pathConfig !== 'object') {
        continue;
      }
      for (let methodIndex = 0; methodIndex < httpMethods.length; methodIndex++) {
        const httpMethod = httpMethods[methodIndex];
        const operationConfig = pathConfig[httpMethod];
        if (!operationConfig || typeof operationConfig !== 'object') {
          continue;
        }
        const operationId =
          typeof operationConfig.operationId === 'string'
            ? operationConfig.operationId.trim()
            : '';
        if (operationId === '') {
          continue;
        }
        if (!operationPaths[operationId]) {
          operationPaths[operationId] = specPathKey;
        }
      }
    }
  }
  catch (e) {}
  cachedSystemOpenApiOperationPaths = operationPaths;
  return cachedSystemOpenApiOperationPaths;
}

function resolveSystemOperationPath(
  operationId = '',
  systemApiV1BasePath = '',
  fallbackRelativePath = '',
) {
  const normalizedSystemBasePath =
    String(systemApiV1BasePath || '').replace(/\/+$/, '') + '/';
  const fallbackPath = stripLeadingSlash(fallbackRelativePath);
  const fallbackRoute = `${normalizedSystemBasePath}${fallbackPath}`;
  const operationPaths = getSystemOpenApiOperationPaths();
  const configuredPath =
    operationPaths && operationPaths[operationId]
      ? String(operationPaths[operationId]).trim()
      : '';
  if (configuredPath === '') {
    return fallbackRoute;
  }
  const normalizedConfiguredPath = normalizePath(configuredPath);
  const normalizedSpecBasePath = '/system/api/v1';
  if (normalizedConfiguredPath === normalizedSpecBasePath) {
    return normalizedSystemBasePath.replace(/\/$/, '');
  }
  if (
    normalizedConfiguredPath.indexOf(`${normalizedSpecBasePath}/`) === 0
  ) {
    const routeSuffix = stripLeadingSlash(
      normalizedConfiguredPath.substring(normalizedSpecBasePath.length),
    );
    return `${normalizedSystemBasePath}${routeSuffix}`;
  }
  return fallbackRoute;
}

async function loadThemeMapFromSettings() {
  const discovered = await discoverThemes(HAXCMS);
  const detectedNames = discovered.map((item) => item.machineName);
  let enabledThemes = await readEnabledThemeMap(HAXCMS);
  const withDefaults = applyDetectedThemeDefaults(
    HAXCMS,
    enabledThemes,
    detectedNames,
  );
  enabledThemes = withDefaults.enabledThemes;
  if (withDefaults.changed) {
    await writeEnabledThemeMap(HAXCMS, enabledThemes);
  }
  const themes = [];
  for (let i = 0; i < discovered.length; i++) {
    const item = discovered[i];
    const enabled = isThemeEnabled(
      HAXCMS,
      item.machineName,
      enabledThemes,
    );
    themes.push({
      ...item,
      enabled,
      hidden: item.hidden === true || !enabled,
    });
  }
  return themesToMap(themes);
}

/**
 * @OA\Get(
 *    path="/connectionSettings",
 *    tags={"cms"},
 *    @OA\Response(
 *        response="200",
 *        description="Generate the connection settings dynamically for implying we have a backend"
 *   )
 * )
 * @OA\Post(
 *    path="/connectionSettings",
 *    tags={"cms"},
 *    @OA\Response(
 *        response="200",
 *        description="Generate the connection settings dynamically for implying we have a backend"
 *   )
 * )
 */
async function connectionSettings(req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  let themes = {};
  try {
    themes = await loadThemeMapFromSettings();
  }
  catch (e) {
    const fallbackThemes = (
      HAXCMS &&
      typeof HAXCMS.getThemes === 'function'
    ) ? HAXCMS.getThemes() : {};
    themes = (
      fallbackThemes &&
      typeof fallbackThemes === 'object' &&
      !Array.isArray(fallbackThemes)
    ) ? fallbackThemes : {};
  }
  const isDashboardRequest = (
    HAXCMS &&
    HAXCMS.operatingContext !== 'single' &&
    req.headers &&
    req.headers.referer &&
    !req.headers.referer.includes(`/${HAXCMS.sitesDirectory}/`)
  );
  // default to relative API paths so calls in site context resolve correctly
  // and mirror PHP behavior for appStore-generated endpoint paths.
  let baseAPIPath = HAXCMS.systemRequestBase;
  // in non-root installs, preserve basePath for site-context API routing.
  if (!isDashboardRequest && HAXCMS.basePath && HAXCMS.basePath !== '/') {
    baseAPIPath = `${HAXCMS.basePath}${HAXCMS.systemRequestBase}`;
  }
  var sitename = '';
  // express gives this up on requests but doesn't know it ahead of time
  if (req.headers && req.headers.referer) {
    let details = new url.URL(req.headers.referer);
    HAXCMS.protocol = details.protocol.replace(':', '');
    HAXCMS.domain = details.host;
    HAXCMS.request_url = details;

    const sitepath = req.headers.referer.replace(`${HAXCMS.protocol}://${HAXCMS.domain}${HAXCMS.basePath}${HAXCMS.sitesDirectory}/`, '');
    const siteparts = sitepath.split('/');
    // should always be at the base here
    sitename = siteparts[0];
  }
  const siteToken = HAXCMS.getRequestToken(HAXCMS.getActiveUserName() + ':' + sitename);
  // user token is just the name of the logged in user
  const userToken = HAXCMS.getRequestToken(HAXCMS.getActiveUserName());
  let normalizedBasePath = String(HAXCMS.basePath || '/');
  if (normalizedBasePath.charAt(0) !== '/') {
    normalizedBasePath = '/' + normalizedBasePath;
  }
  if (normalizedBasePath.charAt(normalizedBasePath.length - 1) !== '/') {
    normalizedBasePath += '/';
  }
  let siteApiBasePath = `${normalizedBasePath}x/api`;
  if (sitename) {
    siteApiBasePath = `${normalizedBasePath}${HAXCMS.sitesDirectory}/${sitename}/x/api`;
  }
  const systemApiV1BasePath = `${baseAPIPath}v1/`;
  const getUserDataPath = resolveSystemOperationPath(
    'sessionUserGet',
    systemApiV1BasePath,
    'session/user',
  );
  const appStorePath = resolveSystemOperationPath(
    'generateAppStore',
    systemApiV1BasePath,
    'system/app-store',
  );
  const returnDataObj = {
    token: HAXCMS.getRequestToken(),
    siteToken: siteToken,
    userToken: userToken,
    siteApiBasePath: siteApiBasePath,
    siteOpenApiPath: `${siteApiBasePath}/openapi.json`,
    login: `${systemApiV1BasePath}session/login`,
    refreshUrl: `${systemApiV1BasePath}session/refresh`,
    logout: `${systemApiV1BasePath}session/logout`,
    sessionPath: `${systemApiV1BasePath}session`,
    connectionSettings: `${systemApiV1BasePath}session/connection-settings`,
    connectionTest: `${systemApiV1BasePath}session/connection-test`,
    userTokenHeader: 'X-HAXCMS-User-Token',
    // enables redirecting back to site root if JWT really is dead
    redirectUrl: HAXCMS.basePath,
    getSiteFieldsPath: `${baseAPIPath}formLoad?haxcms_form_id=siteSettings`,
    // form token to validate form submissions as unique to the session
    getFormToken: HAXCMS.getRequestToken('form'),
    listFilesPath: `${siteApiBasePath}/v1/files`,
    saveFilePath: `${siteApiBasePath}/v1/files`,
    appStore: {
      url: appStorePath,
      params: {
        'appstore_token': HAXCMS.getRequestToken('appstore'),
        'siteName': sitename,
      },
      headers: {
        'X-HAXCMS-Site-Token': siteToken,
      }
    },
    themes: themes,
  };
  returnDataObj.getUserDataPath = getUserDataPath;
  returnDataObj.getUserDataHeaders = {
    'X-HAXCMS-User-Token': userToken,
  };
  returnDataObj.createSite = `${baseAPIPath}createSite?user_token=${userToken}`;
  returnDataObj.downloadSite = `${baseAPIPath}downloadSite?user_token=${userToken}`;
  returnDataObj.downloadSiteSkeleton = `${baseAPIPath}downloadSiteSkeleton?user_token=${userToken}`;
  returnDataObj.saveSiteAsTemplate = `${baseAPIPath}saveSiteAsTemplate?user_token=${userToken}`;
  returnDataObj.archiveSite = `${baseAPIPath}archiveSite?user_token=${userToken}`;
  returnDataObj.copySite = `${baseAPIPath}cloneSite?user_token=${userToken}`;
  returnDataObj.getSitesList = `${baseAPIPath}listSites?user_token=${userToken}`;
  returnDataObj.skeletonsList = `${baseAPIPath}skeletonsList?user_token=${userToken}`;
  returnDataObj.themesList = `${baseAPIPath}themesList?user_token=${userToken}`;
  if (HAXCMS.getDeploymentProfile() !== 'haxiam-managed') {
    returnDataObj.systemStatus = `${baseAPIPath}systemStatus?user_token=${userToken}`;
    returnDataObj.getApiKeys = `${baseAPIPath}getApiKeys?user_token=${userToken}`;
    returnDataObj.saveApiKeys = `${baseAPIPath}saveApiKeys?user_token=${userToken}`;
    returnDataObj.getMediaSettings = `${baseAPIPath}getMediaSettings?user_token=${userToken}`;
    returnDataObj.saveMediaSettings = `${baseAPIPath}saveMediaSettings?user_token=${userToken}`;
    returnDataObj.systemBlocksList = `${baseAPIPath}systemBlocksList?user_token=${userToken}`;
    returnDataObj.schemaFileOperation = `${baseAPIPath}schemaFileOperation?user_token=${userToken}`;
    returnDataObj.saveEnabledSkeletons = `${baseAPIPath}saveEnabledSkeletons?user_token=${userToken}`;
    returnDataObj.saveEnabledThemes = `${baseAPIPath}saveEnabledThemes?user_token=${userToken}`;
    returnDataObj.saveEnabledBlocks = `${baseAPIPath}saveEnabledBlocks?user_token=${userToken}`;
  }
  const returnData = JSON.stringify(returnDataObj);
  let after='';
  if (HAXCMS.HAXCMS_DISABLE_JWT_CHECKS) {
    after = `window.appSettings.jwt = "${HAXCMS.getJWT(HAXCMS.superUser.name)}"`;
  }
  res.send(`// force vercel calls to go from production
    window.MicroFrontendRegistryConfig = window.MicroFrontendRegistryConfig || {};
    window.MicroFrontendRegistryConfig.base = "https://open-apis.hax.cloud";window.appSettings =${returnData};${after}`);
}

module.exports = connectionSettings;