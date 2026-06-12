
// Lightweight meta endpoint similar to PHP Operations::options
// Returns a list of available operation keys derived from RoutesMap
function isSystemV1Request(req) {
  if (!req || !req.route || typeof req.route.path !== 'string') {
    return false;
  }
  return (
    req.route.path === '/system/api/v1' ||
    req.route.path.indexOf('/system/api/v1/') !== -1
  );
}
function optionsRoute(req, res) {
  // load lazily to avoid circular import timing issues while route maps initialize
  const systemV1Request = isSystemV1Request(req);
  let routeMap = {};
  if (systemV1Request) {
    const { SystemRoutesMap } = require('../lib/SystemRoutesMap.js');
    routeMap =
      SystemRoutesMap && typeof SystemRoutesMap === 'object'
        ? SystemRoutesMap
        : {};
  }
  else {
    const { RoutesMap } = require('../lib/RoutesMap.js');
    routeMap = (RoutesMap && typeof RoutesMap === 'object') ? RoutesMap : {};
  }
  const ops = new Set();
  // collect all registered route operation names from both methods
  Object.keys(routeMap).forEach(method => {
    const routes = routeMap[method] || {};
    Object.keys(routes).forEach(op => ops.add(op));
  });
  // also include meta endpoints for the active API surface
  if (systemV1Request) {
    ops.add('');
    ops.add('openapi');
    ops.add('openapi.json');
    ops.add('openapi.yaml');
  }
  else {
    ops.add('openapi');
    ops.add('api');
    ops.add('options');
  }
  res.json(Array.from(ops));
}

module.exports = optionsRoute;
