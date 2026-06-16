const { HAXCMS } = require('../../../lib/HAXCMS.js');

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

function buildSystemEntityDescriptors(apiBasePath = '/system/api/v1') {
  return [
    {
      name: 'site',
      description: 'System-level site lifecycle resources and site metadata.',
      primaryKey: 'siteName',
      endpoints: [
        `${apiBasePath}/sites`,
        `${apiBasePath}/sites/{siteName}`,
        `${apiBasePath}/sites/{siteName}/clone`,
        `${apiBasePath}/sites/{siteName}/archive`,
        `${apiBasePath}/sites/{siteName}/download`,
        `${apiBasePath}/sites/{siteName}/download-skeleton`,
        `${apiBasePath}/sites/{siteName}/save-as-template`,
      ],
      auth: 'authenticated-user',
      supportedOperations: ['read', 'create', 'update'],
    },
    {
      name: 'theme',
      description: 'System theme catalog and enabled state configuration.',
      primaryKey: 'machineName',
      endpoints: [
        `${apiBasePath}/themes`,
      ],
      auth: 'authenticated-user',
      supportedOperations: ['read', 'update'],
    },
    {
      name: 'block',
      description: 'System block catalog and enabled block configuration.',
      primaryKey: 'tag',
      endpoints: [
        `${apiBasePath}/blocks`,
      ],
      auth: 'authenticated-user',
      supportedOperations: ['read', 'update'],
    },
    {
      name: 'skeleton',
      description:
        'System skeleton catalog, detail, and enabled skeleton configuration.',
      primaryKey: 'skeletonName',
      endpoints: [
        `${apiBasePath}/skeletons`,
        `${apiBasePath}/skeletons/{skeletonName}`,
      ],
      auth: 'authenticated-user',
      supportedOperations: ['read', 'update'],
    },
    {
      name: 'integration',
      description: 'System integration providers and app store manifest.',
      primaryKey: 'id',
      endpoints: [
        `${apiBasePath}/integrations/app-store`,
      ],
      auth: 'public',
      supportedOperations: ['read'],
    },
    {
      name: 'configuration',
      description: 'System configuration resources for settings and schema files.',
      primaryKey: 'id',
      endpoints: [
        `${apiBasePath}/configuration/api-keys`,
        `${apiBasePath}/configuration/media`,
        `${apiBasePath}/configuration/skeletons`,
      ],
      auth: 'authenticated-user',
      supportedOperations: ['read', 'update'],
    },
  ];
}

async function systemEntities(req, res) {
  const apiBasePath = getSystemApiBasePath(req);
  const entities = buildSystemEntityDescriptors(apiBasePath);
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
