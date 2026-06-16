const fs = require('node:fs/promises');
const yaml = require('js-yaml');

function getRequestPath(req) {
  if (req && typeof req.originalUrl === 'string' && req.originalUrl !== '') {
    return req.originalUrl.split('?')[0];
  }
  if (req && typeof req.url === 'string' && req.url !== '') {
    return req.url.split('?')[0];
  }
  return '';
}

function detectRequestedFormat(req) {
  const pathValue = getRequestPath(req).toLowerCase();
  if (pathValue.endsWith('.yaml') || pathValue.endsWith('.yml')) {
    return 'yaml';
  }
  if (pathValue.endsWith('.json')) {
    return 'json';
  }
  if (
    req &&
    req.query &&
    typeof req.query.format === 'string' &&
    req.query.format !== ''
  ) {
    const format = req.query.format.toLowerCase();
    if (format === 'yaml' || format === 'yml') {
      return 'yaml';
    }
    if (format === 'json') {
      return 'json';
    }
  }
  return 'json';
}

async function loadSystemSpecRaw() {
  const specPath = `${__dirname}/../../openapi/system-spec.yaml`;
  return fs.readFile(specPath, 'utf8');
}

function parseYamlOrThrow(rawSpec) {
  try {
    const parsed = yaml.load(rawSpec);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('System OpenAPI specification is empty or invalid');
    }
    return parsed;
  }
  catch (e) {
    throw new Error(`Failed to parse system OpenAPI specification: ${e.message}`);
  }
}

async function openapi(req, res) {
  try {
    const rawSpec = await loadSystemSpecRaw();
    const format = detectRequestedFormat(req);
    const normalizedPath = getRequestPath(req).toLowerCase();
    if (normalizedPath.endsWith('/openapi')) {
      res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
      return res.send(rawSpec);
    }
    const parsedSpec = parseYamlOrThrow(rawSpec);
    if (format === 'yaml') {
      res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
      return res.send(yaml.dump(parsedSpec));
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.json(parsedSpec);
  }
  catch (e) {
    res.status(500);
    return res.json({
      status: 500,
      error: `Unable to load system OpenAPI specification: ${e.message}`,
    });
  }
}

module.exports = openapi;
