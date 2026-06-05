const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { HAXCMS } = require('../../lib/HAXCMS.js');

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

function getServerBaseUrl() {
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
      message: 'Failed to load site OpenAPI specification',
    });
  }

  if (!openapi || typeof openapi !== 'object') {
    return res.status(500).json({
      status: 500,
      message: 'Invalid site OpenAPI specification',
    });
  }

  if (!openapi.info || typeof openapi.info !== 'object') {
    openapi.info = {};
  }
  openapi.info.version = await HAXCMS.getHAXCMSVersion();
  openapi.servers = [
    {
      url: getServerBaseUrl(),
      description: 'HAXcms site base URL',
    },
  ];

  if (format === 'yaml') {
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    return res.send(YAML.stringify(openapi));
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.send(JSON.stringify(openapi, null, 2));
}

module.exports = siteOpenapi;
