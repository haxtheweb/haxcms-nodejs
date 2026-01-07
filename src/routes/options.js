const { RoutesMap } = require('../lib/RoutesMap.js');

// Lightweight meta endpoint similar to PHP Operations::options
// Returns a list of available operation keys derived from RoutesMap
function optionsRoute(req, res) {
  const ops = new Set();
  // collect all registered route operation names from both methods
  Object.keys(RoutesMap).forEach(method => {
    const routes = RoutesMap[method] || {};
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
