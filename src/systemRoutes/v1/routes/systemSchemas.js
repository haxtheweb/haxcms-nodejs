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

function getQueryValue(req, key = '') {
  if (
    req &&
    req.query &&
    Object.prototype.hasOwnProperty.call(req.query, key) &&
    typeof req.query[key] !== 'undefined' &&
    req.query[key] !== null
  ) {
    return req.query[key];
  }
  return '';
}

function buildSystemSchemaDescriptors(apiBasePath = '/system/api/v1') {
  return [
    {
      id: 'json-outline-schema',
      title: 'JSON Outline Schema',
      version: '1.0.0',
      kind: 'jsonOutlineSchema',
      mediaType: 'application/json',
      appliesTo: ['site', 'site-template', 'skeleton'],
      links: {
        spec: 'https://github.com/haxtheweb/json-outline-schema',
      },
      schema: {
        type: 'object',
        required: ['id', 'title', 'items'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          metadata: { type: 'object' },
          items: { type: 'array', items: { type: 'object' } },
        },
      },
    },
    {
      id: 'json-outline-schema-item',
      title: 'JSON Outline Schema Item',
      version: '1.0.0',
      kind: 'jsonOutlineSchemaItem',
      mediaType: 'application/json',
      appliesTo: ['site', 'skeleton'],
      links: {
        spec: 'https://github.com/haxtheweb/json-outline-schema',
      },
      schema: {
        type: 'object',
        required: ['id', 'title', 'slug', 'location'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          slug: { type: 'string' },
          location: { type: 'string' },
          parent: { type: ['string', 'null'] },
          indent: { type: 'number' },
          order: { type: 'number' },
          description: { type: 'string' },
          metadata: { type: 'object' },
        },
      },
    },
    {
      id: 'app-store-schema',
      title: 'HAX App Store Schema',
      version: '1.0.0',
      kind: 'appStoreSchema',
      mediaType: 'application/json',
      appliesTo: ['integration'],
      links: {
        endpoint: `${apiBasePath}/integrations/app-store`,
        spec: 'https://github.com/haxtheweb/appstore-spec',
      },
      schema: {
        type: 'object',
        properties: {
          apps: { type: 'array', items: { type: 'object' } },
          stax: { type: 'array', items: { type: 'object' } },
          autoloader: { type: ['array', 'object'] },
        },
      },
    },
    {
      id: 'theme-configuration',
      title: 'Theme Configuration Settings',
      version: '1.0.0',
      kind: 'themeConfiguration',
      mediaType: 'application/json',
      appliesTo: ['configuration'],
      links: {
        endpoint: `${apiBasePath}/themes`,
      },
      schema: {
        type: 'object',
        additionalProperties: {
          type: 'boolean',
        },
      },
    },
    {
      id: 'block-configuration',
      title: 'Block Configuration Settings',
      version: '1.0.0',
      kind: 'blockConfiguration',
      mediaType: 'application/json',
      appliesTo: ['configuration'],
      links: {
        endpoint: `${apiBasePath}/blocks`,
      },
      schema: {
        type: 'object',
        properties: {
          enabledBlocks: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
      },
    },
    {
      id: 'skeleton-configuration',
      title: 'Skeleton Configuration Settings',
      version: '1.0.0',
      kind: 'skeletonConfiguration',
      mediaType: 'application/json',
      appliesTo: ['configuration'],
      links: {
        endpoint: `${apiBasePath}/skeletons`,
      },
      schema: {
        type: 'object',
        additionalProperties: {
          type: 'boolean',
        },
      },
    },
  ];
}

async function systemSchemas(req, res) {
  const apiBasePath = getSystemApiBasePath(req);
  let schemas = buildSystemSchemaDescriptors(apiBasePath);
  const filterKind = String(getQueryValue(req, 'filter.kind') || '').trim();
  if (filterKind !== '') {
    schemas = schemas.filter((schema) => String(schema.kind || '') === filterKind);
  }
  return res.json({
    status: 200,
    data: {
      count: schemas.length,
      schemas,
      links: {
        self: `${apiBasePath}/schemas`,
        entities: `${apiBasePath}/entities`,
      },
    },
  });
}

module.exports = systemSchemas;
