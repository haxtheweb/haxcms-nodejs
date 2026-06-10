const { HAXCMS, systemStructureContext } = require('../../lib/HAXCMS.js');

function getRequestPath(req) {
  if (req && typeof req.originalUrl === 'string' && req.originalUrl !== '') {
    return req.originalUrl.split('?')[0];
  }
  if (req && typeof req.url === 'string' && req.url !== '') {
    return req.url.split('?')[0];
  }
  return '';
}

function getMultisiteSiteNameFromPath(requestPath = '') {
  const parts = String(requestPath || '')
    .split('/')
    .filter((part) => part !== '');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === HAXCMS.sitesDirectory && parts[i + 1]) {
      return decodeURIComponent(parts[i + 1]);
    }
  }
  return '';
}

function getApiBasePath(req) {
  const requestPath = getRequestPath(req);
  const matched = String(requestPath || '').match(/^(.*\/x\/api)(?:\/.*)?$/);
  if (matched && matched[1]) {
    return matched[1];
  }
  return '/x/api';
}

function buildDiscoveryLinks(apiBasePath = '/x/api') {
  return {
    self: `${apiBasePath}/v1/entities`,
    site: `${apiBasePath}/v1/site`,
    schemas: `${apiBasePath}/v1/schemas`,
    openapi: `${apiBasePath}/openapi`,
    openapiJson: `${apiBasePath}/openapi.json`,
    openapiYaml: `${apiBasePath}/openapi.yaml`,
  };
}

function buildEntityDescriptors(apiBasePath = '/x/api') {
  return [
    {
      name: 'site',
      description: 'Site-level metadata and API capability summary.',
      primaryKey: 'id',
      endpoints: [
        `${apiBasePath}/v1/site`,
        `${apiBasePath}/v1/site/export/{format}`,
      ],
      filterableFields: [],
      sortableFields: ['title', 'updated'],
      selectableFields: [
        'id',
        'name',
        'title',
        'description',
        'language',
        'basePath',
        'theme',
        'updated',
        'counts',
        'links',
        'jsonld',
      ],
      includes: [],
      formats: ['application/json'],
      modes: [],
      auth: 'public',
      supportedOperations: ['read'],
    },
    {
      name: 'item',
      description: 'Outline item metadata records and hierarchy.',
      primaryKey: 'id',
      endpoints: [
        `${apiBasePath}/v1/items`,
        `${apiBasePath}/v1/items/{idOrSlug}`,
        `${apiBasePath}/v1/items/{idOrSlug}/export/{format}`,
      ],
      filterableFields: [
        'filter.parent',
        'filter.ancestor',
        'filter.depth',
        'filter.tags',
        'filter.pageType',
        'filter.published',
        'filter.region',
      ],
      sortableFields: ['title', 'order', 'updated', 'created'],
      selectableFields: [
        'id',
        'title',
        'slug',
        'parent',
        'indent',
        'order',
        'description',
        'metadata',
        'links',
        'exports',
        'jsonld',
        'haxElementSchema',
      ],
      includes: ['content', 'tags', 'region', 'jsonld', 'haxElementSchema'],
      formats: [
        'application/json',
        'text/markdown',
        'application/yaml',
        'application/xml',
        'text/html',
      ],
      modes: ['bundle'],
      auth: 'public',
      supportedOperations: ['read'],
      related: [
        {
          rel: 'entity',
          type: 'item',
          href: `${apiBasePath}/v1/entities#item`,
        },
        {
          rel: 'schema',
          type: 'jsonOutlineSchema',
          href: `${apiBasePath}/v1/schemas?filter.kind=jsonOutlineSchema`,
        },
        {
          rel: 'schema',
          type: 'jsonOutlineSchemaItem',
          href: `${apiBasePath}/v1/schemas?filter.kind=jsonOutlineSchemaItem`,
        },
      ],
    },
    {
      name: 'content',
      description: 'Page body/content representations and transformed variants.',
      primaryKey: 'id',
      endpoints: [
        `${apiBasePath}/v1/content`,
        `${apiBasePath}/v1/content/{idOrSlug}`,
      ],
      filterableFields: [
        'filter.parent',
        'filter.ancestor',
        'filter.depth',
        'filter.tags',
        'filter.published',
        'filter.region',
      ],
      sortableFields: ['title', 'updated', 'created'],
      selectableFields: ['id', 'slug', 'title', 'format', 'mode', 'body'],
      includes: ['item', 'region', 'tags'],
      formats: [
        'application/json',
        'text/markdown',
        'application/yaml',
        'application/xml',
        'text/html',
      ],
      modes: ['bundle', 'concat'],
      auth: 'public',
      supportedOperations: ['read'],
    },
    {
      name: 'file',
      description: 'File assets available in the site files directory.',
      primaryKey: 'path',
      endpoints: [`${apiBasePath}/v1/files`],
      filterableFields: ['filter.type', 'filter.extension', 'filter.startsWith', 'filter.nameContains'],
      sortableFields: ['name', 'path', 'dateCreated', 'size'],
      selectableFields: ['path', 'url', 'fullUrl', 'name', 'mimetype', 'size', 'dateCreated'],
      includes: [],
      formats: [
        'application/json',
        'text/markdown',
        'application/yaml',
        'application/xml',
      ],
      modes: ['bundle'],
      auth: 'authenticated-site',
      supportedOperations: ['read'],
    },
    {
      name: 'tag',
      description: 'Tag facet values and usage counts.',
      primaryKey: 'tag',
      endpoints: [`${apiBasePath}/v1/tags`],
      filterableFields: ['filter.tags'],
      sortableFields: ['tag', 'count'],
      selectableFields: ['tag', 'count'],
      includes: ['items'],
      formats: ['application/json'],
      modes: ['bundle'],
      auth: 'public',
      supportedOperations: ['read'],
    },
    {
      name: 'customElement',
      description: 'Custom element metadata available to the site.',
      primaryKey: 'tag',
      endpoints: [
        `${apiBasePath}/v1/custom-elements`,
        `${apiBasePath}/v1/custom-elements/{webcomponentName}`,
      ],
      filterableFields: ['filter.tag'],
      sortableFields: ['tag'],
      selectableFields: ['tag', 'import', 'package', 'description', 'haxProperties'],
      includes: ['haxProperties', 'haxSchema', 'haxElementSchema'],
      formats: ['application/json'],
      modes: ['bundle'],
      auth: 'public',
      supportedOperations: ['read'],
      related: [
        {
          rel: 'entity',
          type: 'block',
          href: `${apiBasePath}/v1/entities#block`,
        },
        {
          rel: 'endpoint',
          type: 'usage',
          href: `${apiBasePath}/v1/blocks/{webcomponentName}/usage`,
        },
        {
          rel: 'schema',
          type: 'haxProperties',
          href: `${apiBasePath}/v1/schemas?filter.kind=haxProperties`,
        },
        {
          rel: 'schema',
          type: 'haxSchema',
          href: `${apiBasePath}/v1/schemas?filter.kind=haxSchema`,
        },
        {
          rel: 'schema',
          type: 'haxElementSchema',
          href: `${apiBasePath}/v1/schemas?filter.kind=haxElementSchema`,
        },
      ],
    },
    {
      name: 'block',
      description: 'Block usage and HAX schema details for custom element tags.',
      primaryKey: 'tag',
      endpoints: [
        `${apiBasePath}/v1/blocks`,
        `${apiBasePath}/v1/blocks/{webcomponentName}`,
        `${apiBasePath}/v1/blocks/{webcomponentName}/usage`,
      ],
      filterableFields: ['filter.tag', 'filter.enabled', 'filter.region'],
      sortableFields: ['tag', 'usageCount'],
      selectableFields: ['tag', 'enabled', 'usageCount', 'haxProperties', 'haxSchema', 'haxElementSchema'],
      includes: ['item', 'region', 'haxProperties', 'haxSchema', 'haxElementSchema'],
      formats: ['application/json'],
      modes: ['bundle'],
      auth: 'public',
      supportedOperations: ['read'],
    },
    {
      name: 'region',
      description: 'Region-level grouping of site items and content.',
      primaryKey: 'name',
      endpoints: [
        `${apiBasePath}/v1/regions`,
        `${apiBasePath}/v1/regions/{regionName}`,
      ],
      filterableFields: ['filter.region'],
      sortableFields: ['name', 'count'],
      selectableFields: ['name', 'count'],
      includes: ['items'],
      formats: ['application/json'],
      modes: ['bundle'],
      auth: 'public',
      supportedOperations: ['read'],
    },
    {
      name: 'theme',
      description: 'Theme metadata records, including active and available themes.',
      primaryKey: 'machineName',
      endpoints: [
        `${apiBasePath}/v1/themes`,
        `${apiBasePath}/v1/themes/{themeName}`,
        `${apiBasePath}/v1/themes/active`,
      ],
      filterableFields: ['filter.enabled', 'filter.active'],
      sortableFields: ['machineName', 'name'],
      selectableFields: ['machineName', 'name', 'description', 'enabled', 'active', 'screenshot'],
      includes: [],
      formats: ['application/json'],
      modes: ['bundle'],
      auth: 'public',
      supportedOperations: ['read'],
    },
    {
      name: 'report',
      description: 'Report datasets used by dashboards.',
      primaryKey: 'id',
      endpoints: [
        `${apiBasePath}/v1/reports`,
        `${apiBasePath}/v1/reports/{report}`,
      ],
      filterableFields: ['filter.report', 'filter.parent', 'filter.ancestor'],
      sortableFields: ['id', 'generatedAt'],
      selectableFields: ['id', 'title', 'description', 'generatedAt', 'data'],
      includes: ['items', 'links', 'content', 'media'],
      formats: [
        'application/json',
        'text/markdown',
        'application/yaml',
        'application/xml',
      ],
      modes: ['bundle'],
      auth: 'authenticated-site',
      supportedOperations: ['read'],
    },
    {
      name: 'revision',
      description: 'Git-backed revision history for individual items.',
      primaryKey: 'hash',
      endpoints: [`${apiBasePath}/v1/items/{idOrSlug}/revisions`],
      filterableFields: [],
      sortableFields: ['timestamp'],
      selectableFields: [
        'revisionNumber',
        'hash',
        'shortHash',
        'author',
        'authorEmail',
        'timestamp',
        'date',
        'message',
      ],
      includes: [],
      formats: ['application/json'],
      modes: ['bundle'],
      auth: 'authenticated-site',
      supportedOperations: ['read'],
    },
    {
      name: 'analytics',
      description: 'Analytics capabilities and future xAPI-oriented reporting surface.',
      primaryKey: 'id',
      endpoints: [`${apiBasePath}/v1/analytics`],
      filterableFields: [],
      sortableFields: [],
      selectableFields: ['mode', 'xapi', 'notes'],
      includes: [],
      formats: ['application/json'],
      modes: ['bundle'],
      auth: 'public',
      supportedOperations: ['read'],
      related: [
        {
          rel: 'schema',
          type: 'xapi',
          href: `${apiBasePath}/v1/schemas?filter.kind=xapi`,
        },
      ],
    },
    {
      name: 'view',
      description: 'Saved display/view definitions and resolved results.',
      primaryKey: 'id',
      endpoints: [
        `${apiBasePath}/v1/views`,
        `${apiBasePath}/v1/views/{viewId}`,
        `${apiBasePath}/v1/views/{viewId}/results`,
        `${apiBasePath}/v1/displays`,
        `${apiBasePath}/v1/displays/{viewId}/results`,
      ],
      filterableFields: ['filter.view', 'filter.tags', 'filter.region'],
      sortableFields: ['id', 'title'],
      selectableFields: ['id', 'title', 'description', 'query', 'display'],
      includes: ['results'],
      formats: [
        'application/json',
        'text/markdown',
        'application/yaml',
        'application/xml',
      ],
      modes: ['bundle'],
      auth: 'public',
      supportedOperations: ['read'],
    },
    {
      name: 'user',
      description: 'User identity and operations are reserved for secured APIs and future phases.',
      primaryKey: 'id',
      endpoints: [],
      filterableFields: [],
      sortableFields: [],
      selectableFields: ['id', 'name', 'roles', 'permissions'],
      includes: [],
      formats: ['application/json'],
      modes: [],
      auth: 'authenticated',
      supportedOperations: [],
      enabled: false,
      notes: ['Reserved for future secured routes; not exposed on public site API in read-only phase.'],
    },
  ];
}

async function resolveSiteForRequest(req) {
  const requestPath = getRequestPath(req);
  const siteName = getMultisiteSiteNameFromPath(requestPath);
  if (siteName !== '') {
    return await HAXCMS.loadSite(siteName);
  }
  return await systemStructureContext();
}

async function entities(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/entities',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const descriptors = buildEntityDescriptors(apiBasePath);
  return res.json({
    status: 200,
    data: {
      count: descriptors.length,
      entities: descriptors,
      links: buildDiscoveryLinks(apiBasePath),
    },
  });
}

module.exports = entities;
