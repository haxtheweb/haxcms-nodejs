const { HAXCMS } = require('../../lib/HAXCMS.js');

function getRequestPath(req) {
  if (req && typeof req.originalUrl === 'string' && req.originalUrl !== '') {
    return req.originalUrl.split('?')[0];
  }
  if (req && typeof req.url === 'string' && req.url !== '') {
    return req.url.split('?')[0];
  }
  return '/x/api';
}

function getApiBasePath(requestPath = '') {
  const cleanPath = String(requestPath || '');
  const matched = cleanPath.match(/^(.*\/x\/api)(?:\/.*)?$/);
  if (matched && matched[1]) {
    return matched[1];
  }
  return '/x/api';
}

function getAbsoluteApiBase(req, apiBasePath) {
  const requestHeaders =
    req && req.headers && typeof req.headers === 'object' ? req.headers : {};
  let protocol = 'http';
  if (
    typeof requestHeaders['x-forwarded-proto'] === 'string' &&
    requestHeaders['x-forwarded-proto'] !== ''
  ) {
    protocol = requestHeaders['x-forwarded-proto'].split(',')[0].trim();
  }
  else if (req && typeof req.protocol === 'string' && req.protocol !== '') {
    protocol = req.protocol;
  }
  let host = '';
  if (
    typeof requestHeaders['x-forwarded-host'] === 'string' &&
    requestHeaders['x-forwarded-host'] !== ''
  ) {
    host = requestHeaders['x-forwarded-host'].split(',')[0].trim();
  }
  else if (typeof requestHeaders.host === 'string' && requestHeaders.host !== '') {
    host = requestHeaders.host;
  }
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
    entities: `${apiBasePath}/v1/entities`,
    schemas: `${apiBasePath}/v1/schemas`,
    site: `${apiBasePath}/v1/site`,
  };
}

async function siteApiDiscovery(req, res) {
  const requestPath = getRequestPath(req);
  const apiBasePath = getApiBasePath(requestPath);
  const links = buildLinkMap(apiBasePath);
  const absoluteBase = getAbsoluteApiBase(req, apiBasePath);
  const absoluteLinks = buildLinkMap(absoluteBase);
  return res.json({
    status: 200,
    data: {
      name: 'HAXcms Site API',
      version: await HAXCMS.getHAXCMSVersion(),
      mode: 'read-only',
      links,
      absoluteLinks,
      supports: {
        formats: [
          'application/json',
          'text/markdown',
          'application/yaml',
          'application/xml',
          'text/html',
        ],
        modes: ['bundle', 'concat'],
        queryGrammar: [
          'filter.*',
          'page.limit',
          'page.offset',
          'sort',
          'fields',
          'include',
          'format',
          'mode',
        ],
      },
      openapi: {
        source: 'openapi/site-spec.yaml',
        routeDriven: true,
      },
    },
  });
}

module.exports = siteApiDiscovery;
