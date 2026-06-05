// object containing site API routes and required handlers
// this is intentionally separate from RoutesMap (system/admin APIs)
const SiteRoutesMap = {
  get: {
    '': require('../siteRoutes/discovery/api.js'),
    openapi: require('../siteRoutes/discovery/openapi.js'),
    'openapi.json': require('../siteRoutes/discovery/openapi.js'),
    'openapi.yaml': require('../siteRoutes/discovery/openapi.js'),
  },
};

module.exports = { SiteRoutesMap };
