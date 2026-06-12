const { HAXCMS } = require('../lib/HAXCMS.js');
const fs = require('fs');
const YAML = require('yaml');

function getRequestPath(req) {
  if (req && req.route && typeof req.route.path === 'string') {
    return req.route.path;
  }
  if (req && typeof req.originalUrl === 'string' && req.originalUrl !== '') {
    return req.originalUrl.split('?')[0];
  }
  if (req && typeof req.url === 'string' && req.url !== '') {
    return req.url.split('?')[0];
  }
  return '';
}

function isSystemV1Request(req) {
  const requestPath = getRequestPath(req);
  return (
    requestPath === '/system/api/v1' ||
    requestPath.indexOf('/system/api/v1/') !== -1
  );
}

function isJsonRequest(req) {
  const requestPath = getRequestPath(req);
  return (
    requestPath.indexOf('/openapi') === requestPath.length - '/openapi'.length ||
    requestPath.indexOf('/openapi.json') === requestPath.length - '/openapi.json'.length
  );
}

function loadOpenApiDocument(req) {
  const systemV1 = isSystemV1Request(req);
  if (systemV1) {
    const systemSpecPath = `${__dirname}/../openapi/system-spec.yaml`;
    const fileContents = fs.readFileSync(
      systemSpecPath,
      { encoding: 'utf8', flag: 'r' },
      'utf8',
    );
    return YAML.parse(fileContents);
  }
  const legacyYamlPath = `${__dirname}/../openapi/spec.yaml`;
  const fileContents = fs.readFileSync(
    legacyYamlPath,
    { encoding: 'utf8', flag: 'r' },
    'utf8',
  );
  return YAML.parse(fileContents);
}

/**
 * Generate swagger API documentation for this site.
 */
async function openapi(req, res) {
  const requestJson = isJsonRequest(req);
  if (requestJson) {
    res.setHeader('Content-Type', 'application/json');
  }
  else {
    res.setHeader('Content-Type', 'application/yaml');
  }
  let openapi = {};
  try {
    openapi = loadOpenApiDocument(req);
  } catch (e) {
    console.warn(e);
    openapi = {};
  }
  if (!openapi.info || typeof openapi.info !== 'object') {
    openapi.info = {};
  }
  openapi.info.version = await HAXCMS.getHAXCMSVersion();
  openapi.servers = [];
  openapi.servers[0] = {};
  const systemApiBase = isSystemV1Request(req)
    ? `${HAXCMS.systemRequestBase}v1/`
    : HAXCMS.systemRequestBase;
  openapi.servers[0].url =
    HAXCMS.protocol +
    '://' +
    HAXCMS.domain +
    HAXCMS.basePath +
    systemApiBase;
  openapi.servers[0].description = isSystemV1Request(req)
    ? 'System v1 control-plane API'
    : 'Site list / dashboard for administrator user';
  if (requestJson) {
    return res.send(JSON.stringify(openapi));
  }
  return res.send(YAML.stringify(openapi));
}

module.exports = openapi;
