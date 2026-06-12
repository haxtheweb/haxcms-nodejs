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
  delete: {},
};

addRouteHandler(SystemRoutesMap, 'get', 'sites', lifecycleRoutes.listSites);
addRouteHandler(SystemRoutesMap, 'post', 'sites', lifecycleRoutes.createSite);
addRouteHandler(SystemRoutesMap, 'post', 'sites/clone', lifecycleRoutes.cloneSite);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'sites/archive',
  lifecycleRoutes.archiveSite,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'sites/download',
  lifecycleRoutes.downloadSite,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'sites/download-skeleton',
  lifecycleRoutes.downloadSiteSkeleton,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'sites/save-as-template',
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
  'system/app-store',
  settingsRoutes.generateAppStore,
);
addRouteHandler(SystemRoutesMap, 'get', 'system/status', settingsRoutes.systemStatus);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'system/status',
  settingsRoutes.systemStatus,
);

addRouteHandler(SystemRoutesMap, 'get', 'settings/api-keys', settingsRoutes.getApiKeys);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'settings/api-keys',
  settingsRoutes.saveApiKeys,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'settings/api-keys',
  settingsRoutes.saveApiKeys,
);

addRouteHandler(
  SystemRoutesMap,
  'get',
  'settings/media',
  settingsRoutes.getMediaSettings,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'settings/media',
  settingsRoutes.saveMediaSettings,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'settings/media',
  settingsRoutes.saveMediaSettings,
);

addRouteHandler(
  SystemRoutesMap,
  'post',
  'settings/enabled-skeletons',
  settingsRoutes.saveEnabledSkeletons,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'settings/enabled-skeletons',
  settingsRoutes.saveEnabledSkeletons,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'settings/schema-files/operations',
  settingsRoutes.schemaFileOperation,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'settings/enabled-themes',
  settingsRoutes.saveEnabledThemes,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'settings/enabled-themes',
  settingsRoutes.saveEnabledThemes,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'settings/enabled-blocks',
  settingsRoutes.saveEnabledBlocks,
);
addRouteHandler(
  SystemRoutesMap,
  'patch',
  'settings/enabled-blocks',
  settingsRoutes.saveEnabledBlocks,
);

addRouteHandler(
  SystemRoutesMap,
  'get',
  'system/blocks',
  settingsRoutes.systemBlocksList,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'system/blocks',
  settingsRoutes.systemBlocksList,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'system/skeletons',
  settingsRoutes.skeletonsList,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'system/skeletons',
  settingsRoutes.skeletonsList,
);
addRouteHandler(
  SystemRoutesMap,
  'get',
  'system/skeletons/:name',
  settingsRoutes.getSkeleton,
);
addRouteHandler(
  SystemRoutesMap,
  'post',
  'system/skeletons/:name',
  settingsRoutes.getSkeleton,
);
addRouteHandler(SystemRoutesMap, 'get', 'system/themes', settingsRoutes.themesList);
addRouteHandler(SystemRoutesMap, 'post', 'system/themes', settingsRoutes.themesList);

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
  'system/app-store',
  '',
  'openapi',
  'openapi.json',
  'openapi.yaml',
];

const SystemV1AdminRoutes = [
  'sites',
  'sites/clone',
  'sites/archive',
  'sites/download',
  'sites/download-skeleton',
  'sites/save-as-template',
  'system/status',
  'settings/api-keys',
  'settings/media',
  'settings/enabled-skeletons',
  'settings/schema-files/operations',
  'settings/enabled-themes',
  'settings/enabled-blocks',
  'system/blocks',
  'system/skeletons',
  'system/skeletons/:name',
  'system/themes',
];

module.exports = {
  SystemRoutesMap,
  SystemV1OpenRoutes,
  SystemV1AdminRoutes,
};
