const { HAXCMS } = require('../lib/HAXCMS.js');
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
    const siteContextPrefix = `${HAXCMS.protocol}://${HAXCMS.domain}${HAXCMS.basePath}${HAXCMS.sitesDirectory}/`;
    if (req.headers.referer.indexOf(siteContextPrefix) === 0) {
      const sitepath = req.headers.referer.replace(siteContextPrefix, '');
      const siteparts = sitepath.split('/');
      sitename = siteparts[0];
    }
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
  const systemApiBasePath = systemApiV1BasePath.replace(/\/$/, '');
  const systemOpenApiPath = resolveSystemOperationPath(
    'systemOpenapiJson',
    systemApiV1BasePath,
    'openapi.json',
  );
  const userTokenHeaderName = 'X-HAXCMS-User-Token';
  const appStorePath = resolveSystemOperationPath(
    'generateAppStore',
    systemApiV1BasePath,
    'integrations/app-store',
  );
  const userDataPath = resolveSystemOperationPath(
    'sessionUserGet',
    systemApiV1BasePath,
    'session/user',
  );
  const userDataHeaders = {};
  userDataHeaders[userTokenHeaderName] = userToken;
  const returnDataObj = {
    token: HAXCMS.getRequestToken(),
    siteToken: siteToken,
    userToken: userToken,
    siteApiBasePath: siteApiBasePath,
    siteOpenApiPath: `${siteApiBasePath}/openapi.json`,
    systemApiBasePath: systemApiBasePath,
    systemOpenApiPath: systemOpenApiPath,
    login: `${systemApiV1BasePath}session/login`,
    refreshUrl: `${systemApiV1BasePath}session/refresh`,
    logout: `${systemApiV1BasePath}session/logout`,
    connectionTest: `${systemApiV1BasePath}session/connection-test`,
    getUserDataPath: userDataPath,
    getUserDataHeaders: userDataHeaders,
    userTokenHeader: userTokenHeaderName,
    redirectUrl: HAXCMS.basePath,
    appStore: {
      url: appStorePath,
      params: {
        'siteName': sitename,
      },
      headers: {
        'X-HAXCMS-Site-Token': siteToken,
      }
    },
  };
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