#!/usr/bin/env node

// cli bridge which ensures calls just go through without security
process.env.haxcms_middleware = "node-cli";
// HAXcms core settings
const { HAXCMS } = require('./lib/HAXCMS.js');
const { allRoutes } = require('./lib/allRoutes.js');
const systemRouteRegistry =
  allRoutes && allRoutes.system && allRoutes.system.map
    ? allRoutes.system.map
    : { get: {}, post: {}, patch: {}, put: {}, delete: {} };
const siteRouteRegistry =
  allRoutes && allRoutes.site && allRoutes.site.map
    ? allRoutes.site.map
    : { get: {}, post: {}, patch: {}, put: {}, delete: {} };
const systemApiBasePath = `${HAXCMS.basePath}${HAXCMS.systemRequestBase}v1/`;
const basePath = String(HAXCMS.basePath || '/').replace(/\/+$/, '');
const siteApiBasePath = basePath === '' || basePath === '/' ? '/x/api' : `${basePath}/x/api`;

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
for (var method in systemRouteRegistry) {
  for (var route in systemRouteRegistry[method]) {
    if (cliOp === 'listCalls') {
      console.log(route);
    }
    else if (route === cliOp) {
      cli[method](`${systemApiBasePath}${route}`, (req, res) => {
        const op = req.route.path.replace(systemApiBasePath, '');
        const rMethod = req.method.toLowerCase();
        if (HAXCMS.validateJWT(req, res)) {
          // call the method
          systemRouteRegistry[rMethod][op](req, res);
        }
        else {
          console.error("route connection issue");
        }
      });
    }
  }
}

// fake response clas so we can capture the response from the headless route as opposed to print to console
class Res {
  constructor() {
    this.query = {};
    this.data = null;
    this.statusCode = null;
  }
  send(data) {
    this.data = data;
    return this;
  }
  status(status) {
    this.statusCode = status;
    return this;
  }
  setHeader() {
    return this;
  }
  json(data) {
    this.data = JSON.parse(JSON.stringify(data));
    return this;
  }
  sendStatus(status) {
    this.statusCode = status;
    this.data = status;
    return this;
  }
}

// method to bridge api calls in similar manner given a site already loaded into scope
export async function cliBridge(op, body = {}, method = 'post', file = null) {
  // when CLI is detected, we assume the user is authenticated
  // this is just to ensure that backend calls looking for tokens to exist
  // get the data they are expecting
  // this does not get validated bc of being a CLI
  const fakeToken = HAXCMS.getRequestToken(HAXCMS.getActiveUserName());
  const rMethod = method.toLowerCase();

  let handler = null;
  let routePath = '';
  let routeParams = {};
  let isSiteRoute = false;

  // Try system routes first
  if (systemRouteRegistry[rMethod] && systemRouteRegistry[rMethod][op]) {
    handler = systemRouteRegistry[rMethod][op];
    routePath = `${systemApiBasePath}${op}`;
  }
  // Try site routes with exact match
  else if (siteRouteRegistry[rMethod] && siteRouteRegistry[rMethod][op]) {
    handler = siteRouteRegistry[rMethod][op];
    routePath = `${siteApiBasePath}${op === '' ? '' : '/' + op}`;
    isSiteRoute = true;
  }
  // Try site routes with pattern matching for parameterized routes
  else if (siteRouteRegistry[rMethod]) {
    for (const pattern in siteRouteRegistry[rMethod]) {
      const regexPattern = pattern.replace(/:([^/]+)/g, '([^/]+)');
      const regex = new RegExp(`^${regexPattern}$`);
      const match = op.match(regex);
      if (match) {
        handler = siteRouteRegistry[rMethod][pattern];
        routePath = `${siteApiBasePath}${pattern === '' ? '' : '/' + pattern}`;
        isSiteRoute = true;
        const paramNames = [];
        pattern.replace(/:([^/]+)/g, (m, name) => paramNames.push(name));
        for (let i = 0; i < paramNames.length; i++) {
          routeParams[paramNames[i]] = match[i + 1];
        }
        break;
      }
    }
  }

  if (!handler) {
    console.error(`Route not found: ${method} ${op}`);
    return;
  }

  let req = {
    route: {
      path: routePath
    },
    body: body,
    params: routeParams,
    query: {
      user_token: fakeToken,
      site_token: fakeToken,
    },
    headers: {
      'x-haxcms-site-token': fakeToken,
    },
    file: file,
    method: method
  };

  // For site routes, set auth context to help site resolution
  if (isSiteRoute) {
    let siteName = '';
    if (body && body.site) {
      if (typeof body.site === 'object' && body.site.name) {
        siteName = body.site.name;
      } else if (typeof body.site === 'string') {
        siteName = body.site;
      }
    }
    if (siteName !== '') {
      req.haxcmsSiteApiAuth = { siteName: siteName };
    }
  }

  let res = new Res();
  if (HAXCMS.validateJWT(req, res)) {
    await handler(req, res);
    return {req: req, res: res};
  }
  else {
    console.error("route connection issue");
  }
}

export { cli };