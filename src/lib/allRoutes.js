const { SiteRoutesMap } = require('./SiteRoutesMap.js');
const {
  SystemRoutesMap,
  SystemV1OpenRoutes,
  SystemV1AdminRoutes,
} = require('./SystemRoutesMap.js');

const allRoutes = {
  site: {
    scope: 'site',
    version: 'v1',
    basePath: 'x/api',
    map: SiteRoutesMap,
  },
  system: {
    scope: 'system',
    version: 'v1',
    basePath: 'system/api/v1',
    map: SystemRoutesMap,
    openRoutes: SystemV1OpenRoutes,
    adminRoutes: SystemV1AdminRoutes,
  },
};

module.exports = {
  allRoutes,
  SiteRoutesMap,
  SystemRoutesMap,
  SystemV1OpenRoutes,
  SystemV1AdminRoutes,
};
