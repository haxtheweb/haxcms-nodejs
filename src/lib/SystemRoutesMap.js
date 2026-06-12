const sessionRoutes = require('../systemRoutes/v1/session.js');
const lifecycleRoutes = require('../systemRoutes/v1/lifecycle.js');
const discoveryRoutes = require('../systemRoutes/v1/discovery.js');
const settingsRoutes = require('../systemRoutes/v1/settings.js');

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

const SystemRoutesMap = {
  get: {},
  post: {},
  patch: {},
  put: {},
  delete: {},
};

addRouteHandler(SystemRoutesMap, 'get', 'sites', lifecycleRoutes.listSites);
addRouteHandler(SystemRoutesMap, 'post', 'sites', lifecycleRoutes.createSite);
addRouteHandler(SystemRoutesMap, 'get', 'sites/:siteName', lifecycleRoutes.siteInfo);
addRouteHandler(SystemRoutesMap, 'post', 'sites/:siteName', lifecycleRoutes.siteInfo);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'sites/:siteName/clone',
  lifecycleRoutes.cloneSite,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'sites/:siteName/archive',
  lifecycleRoutes.archiveSite,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'sites/:siteName/download',
  lifecycleRoutes.downloadSite,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'sites/:siteName/download-skeleton',
  lifecycleRoutes.downloadSiteSkeleton,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'sites/:siteName/save-as-template',
  lifecycleRoutes.saveSiteAsTemplate,
);

addRouteHandler(SystemRoutesMap, 'post', 'session/login', sessionRoutes.login);
addRouteHandler(SystemRoutesMap, 'post', 'session/logout', sessionRoutes.logout);
addRouteHandler(SystemRoutesMap, 'get', 'session', sessionRoutes.session);
addRouteHandler(SystemRoutesMap, 'post', 'session', sessionRoutes.session);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'session/refresh',
  sessionRoutes.refreshAccessToken,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'session/refresh',
  sessionRoutes.refreshAccessToken,
);
addRouteHandler(SystemRoutesMap, 'get', 'session/user', sessionRoutes.getUserData);
addRouteHandler(SystemRoutesMap, 'post', 'session/user', sessionRoutes.getUserData);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'session/connection-settings',
  sessionRoutes.connectionSettings,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'session/connection-settings',
  sessionRoutes.connectionSettings,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'session/connection-test',
  sessionRoutes.connectionTest,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'session/connection-test',
  sessionRoutes.connectionTest,
);

addRouteHandler(
  SystemRoutesMap,
  'get',
  'integrations/app-store',
  settingsRoutes.generateAppStore,
);
addRouteHandler(SystemRoutesMap, 'get', 'system/status', settingsRoutes.systemStatus);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'system/status',
  settingsRoutes.systemStatus,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'system/version',
  settingsRoutes.systemVersion,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'system/version',
  settingsRoutes.systemVersion,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'entities',
  settingsRoutes.systemEntities,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'entities',
  settingsRoutes.systemEntities,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'schemas',
  settingsRoutes.systemSchemas,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'schemas',
  settingsRoutes.systemSchemas,
);

addRouteHandler(
  SystemRoutesMap,
  'get',
  'configuration/api-keys',
  settingsRoutes.configurationApiKeys,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'configuration/api-keys',
  settingsRoutes.configurationApiKeys,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'configuration/api-keys',
  settingsRoutes.configurationApiKeys,
);

addRouteHandler(
  SystemRoutesMap,
  'get',
  'configuration/media',
  settingsRoutes.configurationMedia,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'configuration/media',
  settingsRoutes.configurationMedia,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'configuration/media',
  settingsRoutes.configurationMedia,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'configuration/schema-files/operations',
  settingsRoutes.schemaFileOperation,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'configuration/themes',
  settingsRoutes.configurationThemes,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'configuration/themes',
  settingsRoutes.configurationThemes,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'configuration/themes',
  settingsRoutes.configurationThemes,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'configuration/blocks',
  settingsRoutes.configurationBlocks,
);

addRouteHandler(
  SystemRoutesMap,
  'post',
  'configuration/blocks',
  settingsRoutes.configurationBlocks,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'configuration/blocks',
  settingsRoutes.configurationBlocks,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'configuration/skeletons',
  settingsRoutes.configurationSkeletons,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'configuration/skeletons',
  settingsRoutes.configurationSkeletons,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'configuration/skeletons',
  settingsRoutes.configurationSkeletons,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'configuration/skeletons/:skeletonName',
  settingsRoutes.getSkeleton,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'configuration/skeletons/:skeletonName',
  settingsRoutes.getSkeleton,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'configuration/skeletons/:skeletonName',
  settingsRoutes.schemaFileOperation,
);
addRouteHandler(
  SystemRoutesMap,
  'put',
  'configuration/skeletons/:skeletonName',
  settingsRoutes.schemaFileOperation,
);
addRouteHandler(
  SystemRoutesMap,
  'delete',
  'configuration/skeletons/:skeletonName',
  settingsRoutes.schemaFileOperation,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'skeletons',
  settingsRoutes.configurationSkeletons,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'skeletons',
  settingsRoutes.configurationSkeletons,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'skeletons',
  settingsRoutes.configurationSkeletons,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'skeletons/:skeletonName',
  settingsRoutes.getSkeleton,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'skeletons/:skeletonName',
  settingsRoutes.getSkeleton,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'skeletons/:skeletonName',
  settingsRoutes.schemaFileOperation,
);
addRouteHandler(
  SystemRoutesMap,
  'put',
  'skeletons/:skeletonName',
  settingsRoutes.schemaFileOperation,
);
addRouteHandler(
  SystemRoutesMap,
  'delete',
  'skeletons/:skeletonName',
  settingsRoutes.schemaFileOperation,
);

addRouteHandler(SystemRoutesMap, 'get', '', discoveryRoutes.api);
addRouteHandler(SystemRoutesMap, 'get', 'openapi', discoveryRoutes.openapi);
addRouteHandler(SystemRoutesMap, 'get', 'openapi.json', discoveryRoutes.openapiJson);
addRouteHandler(SystemRoutesMap, 'get', 'openapi.yaml', discoveryRoutes.openapiYaml);

const SystemV1OpenRoutes = [
  'session/login',
  'session/logout',
  'session',
  'session/refresh',
  'session/connection-settings',
  'session/connection-test',
  'integrations/app-store',
  '',
  'openapi',
  'openapi.json',
  'openapi.yaml',
];

const SystemV1AdminRoutes = [
  'sites',
  'sites/:siteName',
  'sites/:siteName/clone',
  'sites/:siteName/archive',
  'sites/:siteName/download',
  'sites/:siteName/download-skeleton',
  'sites/:siteName/save-as-template',
  'system/status',
  'system/version',
  'entities',
  'schemas',
  'configuration/api-keys',
  'configuration/media',
  'configuration/schema-files/operations',
  'configuration/themes',
  'configuration/blocks',
  'configuration/skeletons',
  'configuration/skeletons/:skeletonName',
  'skeletons',
  'skeletons/:skeletonName',
];

module.exports = {
  SystemRoutesMap,
  SystemV1OpenRoutes,
  SystemV1AdminRoutes,
};
