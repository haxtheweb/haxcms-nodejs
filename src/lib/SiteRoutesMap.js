function toPascalCaseFromKebab(value = '') {
  return String(value || '')
    .split('-')
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.substring(1))
    .join('');
}

function toSingularEntityType(entityType = '') {
  const cleanEntityType = String(entityType || '');
  if (cleanEntityType.length <= 1) {
    return cleanEntityType;
  }
  if (
    cleanEntityType.toLowerCase().endsWith('ies') &&
    cleanEntityType.length > 3
  ) {
    return cleanEntityType.substring(0, cleanEntityType.length - 3) + 'y';
  }
  if (
    cleanEntityType.toLowerCase().endsWith('s') &&
    !cleanEntityType.toLowerCase().endsWith('ss')
  ) {
    return cleanEntityType.substring(0, cleanEntityType.length - 1);
  }
  return cleanEntityType;
}

function lowerFirst(value = '') {
  const cleanValue = String(value || '');
  if (cleanValue === '') {
    return '';
  }
  return cleanValue.charAt(0).toLowerCase() + cleanValue.substring(1);
}

function resolveNamedExportHandler(moduleReference, exportName = '') {
  if (
    !moduleReference ||
    typeof moduleReference !== 'object' ||
    Array.isArray(moduleReference)
  ) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(moduleReference, exportName)) {
    return null;
  }
  const handler = moduleReference[exportName];
  if (typeof handler === 'function') {
    return handler;
  }
  return null;
}

function resolveCollectionHandler(moduleReference, listExportName = '') {
  const listHandler = resolveNamedExportHandler(moduleReference, listExportName);
  if (listHandler) {
    return listHandler;
  }
  if (typeof moduleReference === 'function') {
    return moduleReference;
  }
  return null;
}

function addRouteHandler(routesMap, method = 'get', route = '', handler = null) {
  if (typeof handler !== 'function') {
    return;
  }
  const normalizedMethod = String(method || 'get').toLowerCase();
  if (!routesMap[normalizedMethod]) {
    routesMap[normalizedMethod] = {};
  }
  routesMap[normalizedMethod][route] = handler;
}

const discoveryApiRoute = require('../siteRoutes/discovery/api.js');
const discoveryOpenApiRoute = require('../siteRoutes/discovery/openapi.js');
const v1ExportRoutes = require('../siteRoutes/v1/exports.js');
const v1RevisionRoutes = require('../siteRoutes/v1/revisions.js');
const v1ViewsRoutes = require('../siteRoutes/v1/views.js');
const v1BlocksRoutes = require('../siteRoutes/v1/blocks.js');
const v1ThemesRoutes = require('../siteRoutes/v1/themes.js');

const V1_ENTITY_ROUTE_DEFINITIONS = [
  { route: 'site', file: 'site', detailParam: '' },
  { route: 'entities', file: 'entities', detailParam: '' },
  { route: 'schemas', file: 'schemas', detailParam: '' },
  { route: 'items', file: 'items', detailParam: 'idOrSlug' },
  { route: 'content', file: 'content', detailParam: 'idOrSlug' },
  { route: 'files', file: 'files', detailParam: 'fileUuid' },
  { route: 'tags', file: 'tags', detailParam: '' },
  { route: 'search', file: 'search', detailParam: '' },
  {
    route: 'custom-elements',
    file: 'customElements',
    detailParam: 'webcomponentName',
  },
  { route: 'blocks', file: 'blocks', detailParam: 'webcomponentName' },
  { route: 'regions', file: 'regions', detailParam: 'regionName' },
  { route: 'themes', file: 'themes', detailParam: 'themeName' },
  { route: 'reports', file: 'reports', detailParam: 'report' },
  { route: 'analytics', file: 'analytics', detailParam: '' },
  { route: 'views', file: 'views', detailParam: 'viewId' },
];

const SiteRoutesMap = {
  get: {
    '': discoveryApiRoute,
    openapi: discoveryOpenApiRoute,
    'openapi.json': discoveryOpenApiRoute,
    'openapi.yaml': discoveryOpenApiRoute,
  },
  post: {},
  patch: {},
  delete: {},
};

for (let i = 0; i < V1_ENTITY_ROUTE_DEFINITIONS.length; i++) {
  const definition = V1_ENTITY_ROUTE_DEFINITIONS[i];
  const moduleReference = require(`../siteRoutes/v1/${definition.file}.js`);
  const collectionRoute = `v1/${definition.route}`;
  const entityType = toPascalCaseFromKebab(definition.route);
  const singularEntityType = toSingularEntityType(entityType);
  const singularEntityName = lowerFirst(singularEntityType);
  const listExportName = `list${entityType}`;
  const detailExportName = `${singularEntityName}Detail`;
  const createExportName = `create${singularEntityType}`;
  const updateExportName = `update${singularEntityType}`;
  const deleteExportName = `delete${singularEntityType}`;

  addRouteHandler(
    SiteRoutesMap,
    'get',
    collectionRoute,
    resolveCollectionHandler(moduleReference, listExportName),
  );
  addRouteHandler(
    SiteRoutesMap,
    'post',
    collectionRoute,
    resolveNamedExportHandler(moduleReference, createExportName),
  );
  if (definition.detailParam && definition.route !== 'themes') {
    const detailRoute = `${collectionRoute}/:${definition.detailParam}`;
    addRouteHandler(
      SiteRoutesMap,
      'get',
      detailRoute,
      resolveNamedExportHandler(moduleReference, detailExportName),
    );
    addRouteHandler(
      SiteRoutesMap,
      'patch',
      detailRoute,
      resolveNamedExportHandler(moduleReference, updateExportName),
    );
    addRouteHandler(
      SiteRoutesMap,
      'delete',
      detailRoute,
      resolveNamedExportHandler(moduleReference, deleteExportName),
    );
  }
}

addRouteHandler(
  SiteRoutesMap,
  'get',
  'v1/site/export/:format',
  v1ExportRoutes.siteExport,
);
addRouteHandler(
  SiteRoutesMap,
  'get',
  'v1/items/:idOrSlug/revisions',
  v1RevisionRoutes.listItemRevisions,
);
addRouteHandler(
  SiteRoutesMap,
  'get',
  'v1/items/:idOrSlug/revisions/:revisionId',
  v1RevisionRoutes.itemRevisionDetail,
);
addRouteHandler(
  SiteRoutesMap,
  'post',
  'v1/items/:idOrSlug/revisions/:revisionId/restore',
  v1RevisionRoutes.restoreItemRevision,
);
addRouteHandler(
  SiteRoutesMap,
  'get',
  'v1/items/:idOrSlug/export/:format',
  v1ExportRoutes.itemExport,
);
addRouteHandler(
  SiteRoutesMap,
  'get',
  'v1/themes/active',
  v1ThemesRoutes.activeTheme,
);
addRouteHandler(
  SiteRoutesMap,
  'get',
  'v1/themes/:themeName',
  v1ThemesRoutes.themeDetail,
);
addRouteHandler(
  SiteRoutesMap,
  'get',
  'v1/blocks/:webcomponentName/usage',
  v1BlocksRoutes.blockUsage,
);
addRouteHandler(
  SiteRoutesMap,
  'get',
  'v1/views/:viewId/results',
  v1ViewsRoutes.viewResults,
);
addRouteHandler(
  SiteRoutesMap,
  'get',
  'v1/displays',
  v1ViewsRoutes.listDisplays,
);
addRouteHandler(
  SiteRoutesMap,
  'get',
  'v1/displays/:viewId/results',
  v1ViewsRoutes.displayResults,
);

module.exports = { SiteRoutesMap };