const { HAXCMS } = require('../../lib/HAXCMS.js');

function getRequestPath(req) {
  if (req && typeof req.originalUrl === 'string' && req.originalUrl !== '') {
    return req.originalUrl.split('?')[0];
  }
  if (req && typeof req.url === 'string' && req.url !== '') {
    return req.url.split('?')[0];
  }
  return '';
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
  if (normalized.length > 1 && normalized.charAt(normalized.length - 1) === '/') {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}

function getDefaultSystemApiBasePath() {
  const basePath = String(HAXCMS.basePath || '/');
  const systemBase = String(HAXCMS.systemRequestBase || 'system/api/');
  const merged = `${basePath}/${systemBase}v1`;
  return normalizePath(merged);
}

function getApiBasePath(requestPath = '') {
  const cleanPath = String(requestPath || '');
  const matched = cleanPath.match(/^(.*\/system\/api\/v1)(?:\/.*)?$/);
  if (matched && matched[1]) {
    return normalizePath(matched[1]);
  }
  return getDefaultSystemApiBasePath();
}

function getAbsoluteApiBase(req, apiBasePath) {
  // Security (HAX-SEC / PHP [M4] parity): delegate to the shared trust-proxy-
  // aware + allowedHosts-validated helpers on HAXCMS so this endpoint cannot be
  // used for host-header injection into the absoluteLinks response field.
  // X-Forwarded-* are trusted only behind a configured trusted proxy and the
  // host is validated against config.security.allowedHosts when set.
  const protocol = HAXCMS.resolveTrustedProtocol(req);
  const host = HAXCMS.resolveTrustedHost(req);
  if (host === '') {
    return apiBasePath;
  }
  return `${protocol}://${host}${apiBasePath}`;
}

function buildLinkMap(apiBasePath = '') {
  return {
    self: apiBasePath,
    openapi: `${apiBasePath}/openapi`,
    openapiJson: `${apiBasePath}/openapi.json`,
    openapiYaml: `${apiBasePath}/openapi.yaml`,
    sites: `${apiBasePath}/sites`,
    session: `${apiBasePath}/session`,
    configuration: `${apiBasePath}/configuration`,
    integrations: `${apiBasePath}/integrations`,
    entities: `${apiBasePath}/entities`,
    schemas: `${apiBasePath}/schemas`,
    system: `${apiBasePath}/system`,
  };
}

async function systemDiscoveryApi(req, res) {
  const requestPath = getRequestPath(req);
  const apiBasePath = getApiBasePath(requestPath);
  const links = buildLinkMap(apiBasePath);
  const absoluteBase = getAbsoluteApiBase(req, apiBasePath);
  const absoluteLinks = buildLinkMap(absoluteBase);
  return res.json({
    status: 200,
    data: {
      name: 'HAXcms System API',
      version: await HAXCMS.getHAXCMSVersion(),
      mode: 'admin',
      links,
      absoluteLinks,
      supports: {
        formats: [
          'application/json',
          'application/yaml',
        ],
      },
      openapi: {
        source: 'systemRoutes/openapi/system-spec.yaml',
        routeDriven: true,
      },
    },
  });
}

module.exports = systemDiscoveryApi;
