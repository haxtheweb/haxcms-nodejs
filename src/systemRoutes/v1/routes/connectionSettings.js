const { HAXCMS, systemStructureContext } = require('../../../lib/HAXCMS.js');
const fs = require('fs');
const path = require('path');
const url = require('url');
const YAML = require('yaml');
const { shouldEmbedBypassJwt } = require('../../../lib/listenHost.js');

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
  catch {}
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
  var multisiteUrlName = '';
  // Security (SEC-SESSION): derive the site context from the Referer PER
  // REQUEST using the trusted protocol/host resolvers. The Referer is
  // attacker-controlled, so it must never be written onto the process-global
  // HAXCMS singleton (it previously set HAXCMS.protocol / domain / request_url
  // for every later request, poisoning app-store connection URLs and build
  // output). The referer PATH is still used to pick the site context (it only
  // selects which site the editor talks to; tokens are gated on auth below),
  // matching PHP which also reads the site name from the referer path.
  const trustedProtocol = HAXCMS.resolveTrustedProtocol(req);
  const trustedHost = HAXCMS.resolveTrustedHost(req);
  let refererDetails = null;
  if (req && req.headers && typeof req.headers.referer === 'string' && req.headers.referer !== '') {
    try {
      refererDetails = new url.URL(req.headers.referer);
    }
    catch {
      refererDetails = null;
    }
  }
  // host[:port] comparison only (scheme not compared; parity with
  // HAXCMS.isSameOriginRequest). The recorded protocol always comes from the
  // trusted resolver, never from the referer.
  const sameOriginReferer = !!(
    refererDetails &&
    refererDetails.host === trustedHost
  );
  if (refererDetails) {
    const siteContextPrefix = `${HAXCMS.basePath}${HAXCMS.sitesDirectory}/`;
    const refererPath = refererDetails.pathname;
    if (refererPath.indexOf(siteContextPrefix) === 0) {
      const sitepath = refererPath.substring(siteContextPrefix.length);
      const siteparts = sitepath.split('/');
      multisiteUrlName = siteparts[0];
    }
  }
  // Security (SEC-SESSION): decide whether siteToken / userToken (and the
  // token header entries) are included -- see HAXCMS.shouldIncludeRequestTokens
  // for the ordered rules (Sec-Fetch-Site cross-site/same-site -> omit;
  // authenticated -> include; security.requireSessionForRequestTokens ->
  // omit; else include). Anonymous callers still get the rest of the payload
  // (the editor boots from it before login).
  const tokenDecision = HAXCMS.shouldIncludeRequestTokens(req);
  const authenticatedUser = tokenDecision.authenticatedUser;
  const includeRequestTokens = tokenDecision.include;
  // Remember the deployment's public origin for build-time / app-store URLs
  // (HAXCMS.getDomain / getURI / siteConnectionJSON), but only from an
  // authenticated, same-origin editor load and only from the trusted
  // protocol/host resolvers -- never from Referer-supplied values.
  if (authenticatedUser !== '' && sameOriginReferer && trustedHost !== '') {
    HAXCMS.protocol = trustedProtocol;
    HAXCMS.domain = trustedHost;
    HAXCMS.request_url = new url.URL(
      `${trustedProtocol}://${trustedHost}${refererDetails.pathname}`,
    );
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
    catch {}
  }
  const siteToken = includeRequestTokens
    ? HAXCMS.getRequestToken(HAXCMS.getActiveUserName() + ':' + sitename)
    : '';
  // user token is just the name of the logged in user
  const userToken = includeRequestTokens
    ? HAXCMS.getRequestToken(HAXCMS.getActiveUserName())
    : '';
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
  const appStoreHeaders = {};
  if (includeRequestTokens) {
    userDataHeaders[userTokenHeaderName] = userToken;
    appStoreHeaders['X-HAXCMS-Site-Token'] = siteToken;
  }
  const returnDataObj = {
    token: HAXCMS.getRequestToken(),
  };
  if (includeRequestTokens) {
    returnDataObj.siteToken = siteToken;
    returnDataObj.userToken = userToken;
  }
  Object.assign(returnDataObj, {
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
      headers: appStoreHeaders,
    },
  });
  const returnData = JSON.stringify(returnDataObj);
  let after='';
  // Security (SEC-DEPLOY / PHP SEC-03 parity): the superuser JWT is only handed
  // out by the no-login bypass outside production and to loopback clients
  // (unless HAXCMS_HOST deliberately exposes the bypass beyond loopback).
  if (shouldEmbedBypassJwt(req, {
    jwtChecksDisabled: !!HAXCMS.HAXCMS_DISABLE_JWT_CHECKS,
    isProduction: HAXCMS.isProductionRuntime(),
  })) {
    after = `window.appSettings.jwt = "${HAXCMS.getJWT(HAXCMS.superUser.name)}"`;
  }
  res.send(`window.MicroFrontendRegistryConfig = window.MicroFrontendRegistryConfig || {};
window.appSettings =${returnData};${after}`);
}

module.exports = connectionSettings;