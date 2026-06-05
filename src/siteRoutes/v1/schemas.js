const {
  getApiBasePath,
  getQueryValue,
  sendFormattedResponse,
  resolveSiteForRequest,
} = require('./siteRouteUtils.js');

function buildSchemaDescriptors(apiBasePath = '/x/api', webcomponentName = '') {
  const webcomponentTag = String(webcomponentName || '').trim() || '*';
  return [
    {
      id: 'json-outline-schema',
      title: 'JSON Outline Schema',
      version: '1.0.0',
      kind: 'jsonOutlineSchema',
      mediaType: 'application/json',
      appliesTo: ['site', 'item', 'content'],
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
      appliesTo: ['item', 'content'],
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
      id: 'hax-properties',
      title: 'HAX Properties',
      version: '1.0.0',
      kind: 'haxProperties',
      mediaType: 'application/json',
      appliesTo: ['block', 'customElement'],
      links: {
        spec: 'https://github.com/haxtheweb/hax-schema',
      },
      schema: {
        tag: webcomponentTag,
        type: 'object',
        properties: {
          gizmo: { type: 'object' },
          settings: {
            type: 'object',
            properties: {
              configure: { type: 'array' },
              advanced: { type: 'array' },
              developer: { type: 'array' },
            },
          },
        },
      },
    },
    {
      id: 'hax-element-schema',
      title: 'HAX Element Schema',
      version: '1.0.0',
      kind: 'haxElementSchema',
      mediaType: 'application/json',
      appliesTo: ['block', 'customElement'],
      schema: {
        tag: webcomponentTag,
        type: 'object',
        properties: {
          tag: { type: 'string' },
          properties: { type: 'array' },
          slots: { type: 'array' },
        },
      },
    },
    {
      id: 'hax-schema',
      title: 'HAX Schema',
      version: '1.0.0',
      kind: 'haxSchema',
      mediaType: 'application/json',
      appliesTo: ['block', 'customElement'],
      links: {
        spec: 'https://github.com/haxtheweb/hax-schema',
      },
      schema: {
        tag: webcomponentTag,
        type: 'object',
        properties: {
          api: { type: 'string' },
          canScale: { type: 'boolean' },
          canPosition: { type: 'boolean' },
          canEditSource: { type: 'boolean' },
        },
      },
    },
    {
      id: 'app-store-schema',
      title: 'HAX App Store Schema',
      version: '1.0.0',
      kind: 'appStoreSchema',
      mediaType: 'application/json',
      appliesTo: ['customElement', 'block'],
      schema: {
        type: 'object',
        properties: {
          details: { type: 'object' },
          connection: { type: 'object' },
        },
      },
    },
    {
      id: 'view-display-schema',
      title: 'View/Display Schema',
      version: '1.0.0',
      kind: 'viewSchema',
      mediaType: 'application/json',
      appliesTo: ['view'],
      links: {
        views: `${apiBasePath}/v1/views`,
      },
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          query: { type: 'object' },
          display: { type: 'object' },
        },
      },
    },
    {
      id: 'query-contract-schema',
      title: 'Site API Query Contract',
      version: '1.0.0',
      kind: 'queryContract',
      mediaType: 'application/json',
      appliesTo: ['items', 'content', 'files', 'search', 'reports', 'views'],
      schema: {
        type: 'object',
        properties: {
          'filter.*': { type: 'object' },
          'page.limit': { type: 'number' },
          'page.offset': { type: 'number' },
          sort: { type: 'string' },
          fields: { type: 'string' },
          include: { type: 'string' },
          format: {
            type: 'string',
            enum: ['json', 'md', 'yaml', 'xml', 'html'],
          },
          mode: {
            type: 'string',
            enum: ['bundle', 'concat'],
          },
        },
      },
    },
  ];
}

async function schemas(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/schemas',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const filterKind = String(getQueryValue(req, 'filter.kind', '') || '').trim();
  const filterWebcomponentName = String(
    getQueryValue(req, 'filter.webcomponentName', '') || '',
  ).trim();
  let schemasList = buildSchemaDescriptors(apiBasePath, filterWebcomponentName);
  if (filterKind !== '') {
    schemasList = schemasList.filter(
      (schema) => String(schema.kind || '') === filterKind,
    );
  }
  return sendFormattedResponse(
    req,
    res,
    {
      count: schemasList.length,
      schemas: schemasList,
      links: {
        self: `${apiBasePath}/v1/schemas`,
        entities: `${apiBasePath}/v1/entities`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

module.exports = schemas;
