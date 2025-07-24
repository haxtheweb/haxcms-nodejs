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
}

// method to bridge api calls in similar manner given a site already loaded into scope
export async function cliBridge(op, body = {}) {
  // when CLI is detected, we assume the user is authenticated
  // this is just to ensure that backend calls looking for tokens to exist
  // get the data they are expecting
  // this does not get validated bc of being a CLI
  const fakeToken = HAXCMS.getRequestToken(HAXCMS.getActiveUserName());
  let req = {
    route: {
      path: `${HAXCMS.basePath}${HAXCMS.systemRequestBase}${route}`
    },
    body: body,
    query: {
      user_token: fakeToken,
      site_token: fakeToken,
    },
    method: "post"
  };

  let res = new Res();
  const rMethod = req.method.toLowerCase();
  if (HAXCMS.validateJWT(req, res)) {
    // call the method
    await RoutesMap.RoutesMap[rMethod][op](req, res);
    return {req: req, res: res};
  }
  else {
    console.error("route connection issue");
  }
}

export { cli };