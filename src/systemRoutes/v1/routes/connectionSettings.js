const { HAXCMS, systemStructureContext } = require('../../../lib/HAXCMS.js');
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


// Security (review 2026-10): extract <name> from a /<base>/<sitesDirectory>/<name>/
// path without consulting (or mutating) any global request state.
function getSiteNameFromPath(pathValue = '') {
  let requestPath = String(pathValue || '').split('?')[0];
  let basePath = String(HAXCMS.basePath || '/');
  if (basePath.charAt(0) !== '/') {
    basePath = '/' + basePath;
  }
  if (basePath.charAt(basePath.length - 1) !== '/') {
    basePath += '/';
  }
  const prefix = `${basePath}${HAXCMS.sitesDirectory}/`;
  if (requestPath.indexOf(prefix) !== 0) {
    return '';
  }
  return requestPath.substring(prefix.length).split('/')[0];
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
      '..',
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
  // D6: token/JWT-bearing JS — prevent any intermediary from caching
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Content-Type', 'application/javascript');
  // System API base path is always absolute (root-level), mirroring PHP
  // (HAXCMS.php appJWTConnectionSettings forces a leading slash). System
  // routes are not site-scoped; both backends serve them at
  // /system/api/v1/ so calls resolve identically whether the page is a
  // site context (/_sites/<name>/) or the system dashboard. A relative
  // path would resolve against the current page URL and produce a
  // site-scoped system endpoint (/_sites/<name>/system/api/v1/...) which
  // works on Node but is not standardized with PHP.
  let systemNormalizedBasePath = String(HAXCMS.basePath || '/');
  if (systemNormalizedBasePath.charAt(0) !== '/') {
    systemNormalizedBasePath = '/' + systemNormalizedBasePath;
  }
  if (
    systemNormalizedBasePath.charAt(systemNormalizedBasePath.length - 1) !== '/'
  ) {
    systemNormalizedBasePath += '/';
  }
  let baseAPIPath = `${systemNormalizedBasePath}${HAXCMS.systemRequestBase}`;
  var sitename = '';
  // name parsed from a multisite site-context URL (/_sites/<name>/...).
  // tracked separately because it must drive the site API base path, whereas
  // sitename (below) may also be resolved from the single-site context.
  // Security (review 2026-10): request data is no longer written onto the
  // process-global HAXCMS singleton (HAXCMS.protocol / domain / request_url
  // used to be overwritten from the attacker-controlled Referer before auth,
  // poisoning every later consumer: app-store connection URLs, site OpenAPI
  // server URLs, generated RSS/sitemap/metadata). The site name is derived
  // per request: first from this request's own path (site-scoped system route
  // /_sites/<name>/system/api/...), then from the Referer path, then from the
  // single-site context — the same precedence the site API uses.
  var multisiteUrlName = getSiteNameFromPath(req && (req.originalUrl || req.url) ? (req.originalUrl || req.url) : '');
  if (multisiteUrlName === '' && req && req.headers && typeof req.headers.referer === 'string') {
    try {
      multisiteUrlName = getSiteNameFromPath(new url.URL(req.headers.referer).pathname);
    }
    catch (e) {
      multisiteUrlName = '';
    }
  }
  sitename = multisiteUrlName;
  // single-site mode serves the site at the web root, so the referer never
  // carries a /_sites/<name>/ segment and sitename would be blank. Resolve the
  // active site from the single-site context (cwd site.json) and use its
  // metadata.site.name so the appStore param + site token match what the site
  // API validates (resolveSiteApiRequestSiteName resolves the same value). A
  // multisite root has no site.json in cwd, so this stays blank there.
  if (sitename === '') {
    try {
      const singleSite = await systemStructureContext();
      if (
        singleSite &&
        singleSite.manifest &&
        singleSite.manifest.metadata &&
        singleSite.manifest.metadata.site &&
        singleSite.manifest.metadata.site.name
      ) {
        sitename = String(singleSite.manifest.metadata.site.name);
      }
      else if (singleSite && singleSite.name) {
        sitename = String(singleSite.name);
      }
    }
    catch (e) {}
  }
  // Security (review 2026-10): bind request tokens to the AUTHENTICATED
  // principal of this request (valid Bearer JWT, or a refresh cookie whose
  // family passes the refresh-session store check) rather than the configured
  // fallback user. NOTE: unauthenticated callers still receive tokens bound to
  // the configured user because the shipped front end (app-hax in-page login)
  // loads this script once before login and keeps using these tokens after
  // login without re-fetching; stripping them would break login. Tokens alone
  // are not sufficient to call any protected route (a valid JWT is required).
  const tokenUserName = HAXCMS.getAuthenticatedRawUserName(req) || HAXCMS.getActiveUserName();
  const siteToken = HAXCMS.getRequestToken(tokenUserName + ':' + sitename);
  // user token is just the name of the logged in user
  const userToken = HAXCMS.getRequestToken(tokenUserName);
  let normalizedBasePath = String(HAXCMS.basePath || '/');
  if (normalizedBasePath.charAt(0) !== '/') {
    normalizedBasePath = '/' + normalizedBasePath;
  }
  if (normalizedBasePath.charAt(normalizedBasePath.length - 1) !== '/') {
    normalizedBasePath += '/';
  }
  let siteApiBasePath = `${normalizedBasePath}x/api`;
  if (multisiteUrlName) {
    siteApiBasePath = `${normalizedBasePath}${HAXCMS.sitesDirectory}/${multisiteUrlName}/x/api`;
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
    login: resolveSystemOperationPath(
      'sessionLogin',
      systemApiV1BasePath,
      'session/login',
    ),
    refreshUrl: resolveSystemOperationPath(
      'sessionRefreshGet',
      systemApiV1BasePath,
      'session/refresh',
    ),
    logout: resolveSystemOperationPath(
      'sessionLogout',
      systemApiV1BasePath,
      'session/logout',
    ),
    connectionTest: resolveSystemOperationPath(
      'sessionConnectionTestGet',
      systemApiV1BasePath,
      'session/connection-test',
    ),
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
  // local no-login mode (src/local.js) injects a super-user JWT so the editor
  // works without a login screen. Security (review 2026-10): never in a
  // production runtime, matching the validateJWT bypass guard (PHP removed
  // this injection entirely, SEC-03).
  if (HAXCMS.HAXCMS_DISABLE_JWT_CHECKS && !HAXCMS.isProductionRuntime()) {
    after = `window.appSettings.jwt = "${HAXCMS.getJWT(HAXCMS.superUser.name)}"`;
  }
  res.send(`window.MicroFrontendRegistryConfig = window.MicroFrontendRegistryConfig || {};
window.appSettings =${returnData};${after}`);
}

module.exports = connectionSettings;