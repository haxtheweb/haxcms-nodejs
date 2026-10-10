const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { HAXCMS } = require('../../lib/HAXCMS.js');
const {
  getApiBasePath,
  isAnonymousSiteApiRequest,
} = require('../v1/siteRouteUtils.js');

const OPENAPI_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// haxtheweb/issues#3104: reduce the spec to the operations an anonymous
// caller can use (effective security is an empty list). Paths left with no
// operations are dropped. Mirrors PHP SiteRouteUtils::filterOpenApiToPublicOperations.
function filterOpenApiToPublicOperations(openapi) {
  if (!openapi || typeof openapi !== 'object' || !openapi.paths || typeof openapi.paths !== 'object') {
    return openapi;
  }
  const globalSecurity = Array.isArray(openapi.security) ? openapi.security : [];
  const publicPaths = {};
  for (const pathKey of Object.keys(openapi.paths)) {
    const pathItem = openapi.paths[pathKey];
    if (!pathItem || typeof pathItem !== 'object') {
      continue;
    }
    const kept = {};
    let hasOperation = false;
    for (const key of Object.keys(pathItem)) {
      const value = pathItem[key];
      if (OPENAPI_METHODS.indexOf(String(key).toLowerCase()) !== -1) {
        const security = value && Array.isArray(value.security) ? value.security : globalSecurity;
        if (security.length === 0) {
          kept[key] = value;
          hasOperation = true;
        }
      }
      else {
        // path-level parameters, summary, servers, etc.
        kept[key] = value;
      }
    }
    if (hasOperation) {
      publicPaths[pathKey] = kept;
    }
  }
  openapi.paths = publicPaths;
  if (!openapi.info || typeof openapi.info !== 'object') {
    openapi.info = {};
  }
  const note = 'This is the public profile: only operations that work without logging in. Request ?profile=full for every operation.';
  openapi.info.description = typeof openapi.info.description === 'string' && openapi.info.description !== ''
    ? openapi.info.description + '\n\n' + note
    : note;
  openapi['x-haxcms-profile'] = 'public';
  return openapi;
}

const SITE_OPENAPI_SPEC_PATH = path.join(__dirname, '../../openapi/site-spec.yaml');

function normalizeFormatValue(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  if (normalized === 'yml') {
    return 'yaml';
  }
  if (
    normalized === 'yaml' ||
    normalized === 'application/yaml' ||
    normalized === 'application/x-yaml' ||
    normalized === 'text/yaml'
  ) {
    return 'yaml';
  }
  if (
    normalized === 'json' ||
    normalized === 'application/json' ||
    normalized === 'application/vnd.oai.openapi+json;version=3.0' ||
    normalized === 'application/vnd.oai.openapi+json'
  ) {
    return 'json';
  }
  return '';
}

function getRequestPath(req) {
  if (req && typeof req.originalUrl === 'string' && req.originalUrl !== '') {
    return req.originalUrl.split('?')[0];
  }
  if (req && typeof req.url === 'string' && req.url !== '') {
    return req.url.split('?')[0];
  }
  if (
    req &&
    req.route &&
    typeof req.route.path === 'string' &&
    req.route.path !== ''
  ) {
    return req.route.path;
  }
  return '';
}

function detectRequestedFormat(req) {
  const requestPath = getRequestPath(req).toLowerCase();
  if (requestPath.endsWith('.yaml') || requestPath.endsWith('.yml')) {
    return 'yaml';
  }
  if (requestPath.endsWith('.json')) {
    return 'json';
  }

  if (req && req.query && typeof req.query === 'object') {
    const queryFormat = normalizeFormatValue(req.query.format);
    if (queryFormat) {
      return queryFormat;
    }
  }

  const acceptHeader =
    req &&
    req.headers &&
    typeof req.headers.accept === 'string'
      ? req.headers.accept.toLowerCase()
      : '';
  if (
    acceptHeader.indexOf('application/yaml') !== -1 ||
    acceptHeader.indexOf('application/x-yaml') !== -1 ||
    acceptHeader.indexOf('text/yaml') !== -1
  ) {
    return 'yaml';
  }
  if (
    acceptHeader.indexOf('application/json') !== -1 ||
    acceptHeader.indexOf('application/vnd.oai.openapi+json') !== -1
  ) {
    return 'json';
  }

  // default to JSON for /x/api/openapi
  return 'json';
}

// haxtheweb/issues#3104: every path in the spec starts with /x/api, so the
// server URL is the base of the site this request came through (e.g.
// https://host/_sites/<name>/), not the HAXcms install base.
function getServerBaseUrl(req) {
  const apiBasePath = req ? getApiBasePath(req) : '';
  const sitePrefix = apiBasePath.replace(/\/x\/api$/, '');
  if (req && sitePrefix !== apiBasePath) {
    return `${HAXCMS.protocol}://${HAXCMS.domain}${sitePrefix.replace(/\/+$/, '')}/`;
  }
  let basePath = HAXCMS.basePath || '/';
  if (basePath.charAt(0) !== '/') {
    basePath = '/' + basePath;
  }
  if (basePath.charAt(basePath.length - 1) !== '/') {
    basePath += '/';
  }
  return `${HAXCMS.protocol}://${HAXCMS.domain}${basePath}`;
}

async function siteOpenapi(req, res) {
  const format = detectRequestedFormat(req);
  let openapi = {};
  try {
    const fileContents = await fs.promises.readFile(SITE_OPENAPI_SPEC_PATH, {
      encoding: 'utf8',
      flag: 'r',
    });
    openapi = YAML.parse(fileContents);
  }
  catch (e) {
    return res.status(500).json({
      status: 500,
      data: {
        message: 'Failed to load site OpenAPI specification',
      },
    });
  }

  if (!openapi || typeof openapi !== 'object') {
    return res.status(500).json({
      status: 500,
      data: {
        message: 'Invalid site OpenAPI specification',
      },
    });
  }

  if (!openapi.info || typeof openapi.info !== 'object') {
    openapi.info = {};
  }
  openapi.info.version = await HAXCMS.getHAXCMSVersion();
  openapi.servers = [
    {
      url: getServerBaseUrl(req),
      description: 'HAXcms site base URL',
    },
  ];

  // haxtheweb/issues#3104: anonymous callers (agents, crawlers) get the
  // public profile so they don't plan around endpoints that answer 401.
  // ?profile=full or a logged-in caller gets the whole spec; this is
  // documentation, not a security boundary.
  const requestedProfile = req && req.query && typeof req.query.profile === 'string'
    ? req.query.profile.trim().toLowerCase()
    : '';
  if (requestedProfile !== 'full' && isAnonymousSiteApiRequest(req)) {
    openapi = filterOpenApiToPublicOperations(openapi);
  }

  if (format === 'yaml') {
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    return res.send(YAML.stringify(openapi));
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.send(JSON.stringify(openapi, null, 2));
}

module.exports = siteOpenapi;
module.exports.filterOpenApiToPublicOperations = filterOpenApiToPublicOperations;
module.exports.getServerBaseUrl = getServerBaseUrl;
