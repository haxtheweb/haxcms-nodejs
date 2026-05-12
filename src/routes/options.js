
// Lightweight meta endpoint similar to PHP Operations::options
// Returns a list of available operation keys derived from RoutesMap
function optionsRoute(req, res) {
  // load lazily to avoid circular import timing issues while RoutesMap initializes
  const { RoutesMap } = require('../lib/RoutesMap.js');
  const routeMap = (RoutesMap && typeof RoutesMap === 'object') ? RoutesMap : {};
  const ops = new Set();
  // collect all registered route operation names from both methods
  Object.keys(routeMap).forEach(method => {
    const routes = routeMap[method] || {};
    Object.keys(routes).forEach(op => ops.add(op));
  });
  // also include meta endpoints that are implemented outside RoutesMap
  ops.add('openapi');
  ops.add('openapi/json');
  ops.add('api');
  ops.add('options');
  res.json(Array.from(ops));
}

module.exports = optionsRoute;
