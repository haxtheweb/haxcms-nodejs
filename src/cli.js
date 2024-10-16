#!/usr/bin/env node

// cli bridge which ensures calls just go through without security
process.env.haxcms_middleware = "node-cli";
// HAXcms core settings
const { HAXCMS } = require('./lib/HAXCMS.js');

const RoutesMap = require('./lib/RoutesMap.js');

// process arguments from commandline appropriately
let body = {};
let cliOp = null;
const cli = {
  post: (path, callback) => 
    callback(
    {
      route: {
        path: path
      },
      body: body,
      method: "post"
    },
    {
      query: {},
      send: (data) => console.log(data),
    }
  ),
  get: (path, callback) => callback({
    route: {
      path: path
    },
    body: body,
    method: "get"
  },
  {
    query: {},
    send: (data) => console.log(data),
  }),
};
// loop through methods and apply the route to the file to deliver it
// @todo ensure that we apply the same JWT checking that we do in the PHP side
// instead of a simple array of what to let go through we could put it into our
// routes object above and apply JWT requirement on paths in a better way
for (var method in RoutesMap) {
  for (var route in RoutesMap[method]) {
    if (cliOp === 'listCalls') {
      console.log(route);
    }
    else if (route === cliOp) {
      cli[method](`${HAXCMS.basePath}${HAXCMS.systemRequestBase}${route}`, (req, res) => {
        const op = req.route.path.replace(`${HAXCMS.basePath}${HAXCMS.systemRequestBase}`, '');
        const rMethod = req.method.toLowerCase();
        if (HAXCMS.validateJWT(req, res)) {
          // call the method
          RoutesMap[rMethod][op](req, res);
        }
        else {
          console.error("route connection issue");
        }
      });
    }
  }
}

// method to bridge api calls in similar manner given a site already loaded into scope
export function cliBridge(op, body = {}) {
  let req = {
    route: {
      path: `${HAXCMS.basePath}${HAXCMS.systemRequestBase}${route}`
    },
    body: body,
    method: "post"
  };
  let res = {
    query: {},
    send: (data) => console.log(data),
  };
  const rMethod = req.method.toLowerCase();
  if (HAXCMS.validateJWT(req, res)) {
    // call the method
    RoutesMap.RoutesMap[rMethod][op](req, res);
  }
  else {
    console.error("route connection issue");
  }
}

export { cli };