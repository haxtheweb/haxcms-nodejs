const { HAXCMS } = require('../../../lib/HAXCMS.js');
const EntityRegistry = require('../../../lib/EntityRegistry.js');

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

function getRequestPath(req) {
  if (req && typeof req.originalUrl === 'string' && req.originalUrl !== '') {
    return req.originalUrl.split('?')[0];
  }
  if (req && typeof req.url === 'string' && req.url !== '') {
    return req.url.split('?')[0];
  }
  return '';
}

function getDefaultSystemApiBasePath() {
  const basePath = String(HAXCMS.basePath || '/');
  const systemBase = String(HAXCMS.systemRequestBase || 'system/api/');
  return normalizePath(`${basePath}/${systemBase}v1`);
}

function getSystemApiBasePath(req) {
  const requestPath = getRequestPath(req);
  const matched = String(requestPath || '').match(
    /^(.*\/system\/api\/v1)(?:\/.*)?$/,
  );
  if (matched && matched[1]) {
    return normalizePath(matched[1]);
  }
  return getDefaultSystemApiBasePath();
}

// Source entity descriptors from the single merged entities.yaml registry —
// the same EntityRegistry::getDefinitions() that /x/api/v1/entities reads
// from, so both endpoints return one shape. Optional ?scope=site|system
// filters the merged set.
function buildSystemEntityDescriptorsFromRegistry(registry, scope) {
  const definitions = registry.getDefinitions(scope || null);
  const entities = [];
  for (let i = 0; i < definitions.length; i++) {
    entities.push(definitions[i].toDescriptorArray());
  }
  return entities;
}

async function systemEntities(req, res) {
  const apiBasePath = getSystemApiBasePath(req);
  const registry = new EntityRegistry();
  const scope = req && req.query && typeof req.query.scope === 'string'
    ? req.query.scope.trim()
    : '';
  const entities = buildSystemEntityDescriptorsFromRegistry(registry, scope);
  return res.json({
    status: 200,
    data: {
      count: entities.length,
      entities,
      links: {
        self: `${apiBasePath}/entities`,
        schemas: `${apiBasePath}/schemas`,
        sites: `${apiBasePath}/sites`,
        configuration: `${apiBasePath}/configuration`,
        integrations: `${apiBasePath}/integrations`,
        system: `${apiBasePath}/system`,
      },
    },
  });
}

module.exports = systemEntities;
