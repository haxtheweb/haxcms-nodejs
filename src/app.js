#!/usr/bin/env node

// lib dependencies
process.env.haxcms_middleware = "node-express";
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const app = express();
const mime = require('mime');
const path = require('path');
const server = require('http').Server(app);
const publicDir = path.join(__dirname, '/public');
// HAXcms core settings
const { HAXCMS } = require('./lib/HAXCMS.js');
/**
 * @todo need a configuration resolver of some kind
 * if we are invoking stand alone, it'll need to install haxcms in place
 * if it's in an existing HAXcms deploy, it should read off that _config / other multi-site directories
 * if it's a HAXSite then it needs to supply config that works relative to that one
 * This also influnces the entry index.html file
 * 
 * On the command running we need to generate the system directory an public as far as where things save.
 * This will allow you to run the  npx command and just start creating sites in the folder you are in
 * which is a bit magic. Might need a template for how the project is to be managed for site creation.
 * 
 * From there we can see if we can easily peal sites off or not. We might need to make individual
 * npx commands based on context but the awesome thing is that the CLI I could pass args to without issue!
 * 
 * This could possibly pick up clark integration and then it asks you what you want to do and that becomes
 * the entry way into working with the system. If that happens it'll have to move the package over to the
 * create repo but this is still early in DX to know.
 */

// routes with all requires
const { RoutesMap, OpenRoutes } = require('./lib/RoutesMap.js');
// app settings
const port = 8000;
const multer = require('multer')
const upload = multer({ dest: path.join(HAXCMS.configDirectory, 'tmp/') })
app.use(express.urlencoded({limit: '50mb',  extended: false, parameterLimit: 50000 }));
app.use(helmet({
  contentSecurityPolicy: false,
  referrerPolicy: {
    policy: ["origin", "unsafe-url"],
  },
}));
app.use(cookieParser());
app.use(express.static(publicDir));
app.use('/', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8080');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept');
  res.setHeader('Content-Type', 'application/json');
  // dynamic step routes in HAXcms site list UI
  if (!req.url.startsWith('/createSite-step-') && req.url !== "/home") {
    next();
  }
  else {
    if (mime.getType(req.url)) {
      res.setHeader('Content-Type', mime.getType(req.url));
    }
    else {
      res.setHeader('Content-Type', 'text/html');
    }
    res.sendFile(req.url.replace(/\/createSite-step-(.*)/, "/").replace(/\/home/, "/"),
    {
      root: publicDir
    });
  }
});
// sites need rewriting to work with PWA routes without failing file location
// similar to htaccess
app.use(`/${HAXCMS.sitesDirectory}/`,(req, res, next) => {
  if (req.url.includes('/system/api/')) {
    next()
  }
  // previous will catch as json, undo that
  else if (
    !req.url.includes('/custom/build/') && 
    (
      req.url.includes('/build/') || 
      req.url.includes('wc-registry.json') ||
      req.url.includes('build.js') ||
      req.url.includes('build-haxcms.js') ||
      req.url.includes('VERSION.txt')
    )
  ) {
    if (mime.getType(req.url.split('?')[0])) {
      res.setHeader('Content-Type', mime.getType(req.url));
    }
    let cleanFilePath = req.url
    .replace(/\/(.*?)\/build\//g, "build/")
    .replace(/\/(.*?)\/wc-registry.json/g, "wc-registry.json")
      .replace(/\/(.*?)\/build.js/g, "build.js")
      .replace(/\/(.*?)\/build-haxcms.js/g, "build-haxcms.js")
      .replace(/\/(.*?)\/VERSION.txt/g, "VERSION.txt");
    res.sendFile(cleanFilePath,
    {
      root: publicDir
    });
  }
  else if (
    req.url.includes('legacy-outline.html') || 
    req.url.includes('custom/build') || 
    req.url.includes('/theme/') || 
    req.url.includes('/assets/') || 
    req.url.includes('/manifest.json') || 
    req.url.includes('/files/') || 
    req.url.includes('/pages/') || 
    req.url.includes('/site.json')
  ) {
    if (mime.getType(req.url.split('?')[0])) {
      res.setHeader('Content-Type', mime.getType(req.url));
    }
    else {
      res.setHeader('Content-Type', 'text/html');
    }
    res.sendFile(req.url.split('?')[0],
    {
      root: process.cwd() + `/${HAXCMS.sitesDirectory}`
    });
  }
  else {
    if (mime.getType(req.url.split('?')[0])) {
      res.setHeader('Content-Type', mime.getType(req.url));
    }
    else {
      res.setHeader('Content-Type', 'text/html');
    }
    // send file for the index even tho route says it's a path not on our file system
    // this way internal routing picks up and loads the correct content while
    // at the same time express has delivered us SOMETHING as the path in the request
    // url doesn't actually exist
    res.sendFile(req.url.replace(/\/(.*?)\/(.*)/, `/${HAXCMS.sitesDirectory}/$1/index.html`),
    {
      root: process.cwd()
    });
  }
});
// published directory route if it exists
app.use(`/${HAXCMS.publishedDirectory}/`,(req, res, next) => {
  if (mime.getType(req.url)) {
    res.setHeader('Content-Type', mime.getType(req.url));
  }
  else {
    res.setHeader('Content-Type', 'text/html');
  }
  res.sendFile(req.url,
  {
    root: `${__dirname}/../${HAXCMS.publishedDirectory}/`
  });
});

//pre-flight requests
app.options('*', function(req, res, next) {
	res.send(200);
});

// loop through methods and apply the route to the file to deliver it
// @todo ensure that we apply the same JWT checking that we do in the PHP side
// instead of a simple array of what to let go through we could put it into our
// RoutesMap object above and apply JWT requirement on paths in a better way
for (var method in RoutesMap) {
  for (var route in RoutesMap[method]) {
    let extra = express.json({
      type: "*/*",
      limit: '50mb'
    });
    if (route === "saveFile") {
      extra = upload.single('file-upload');
    }
    app[method](`${HAXCMS.basePath}${HAXCMS.systemRequestBase}${route}`, extra ,(req, res, next) => {
      const op = req.route.path.replace(`${HAXCMS.basePath}${HAXCMS.systemRequestBase}`, '');
      const rMethod = req.method.toLowerCase();
      if (OpenRoutes.includes(op) || HAXCMS.validateJWT(req, res)) {
        // call the method
        RoutesMap[rMethod][op](req, res, next);
      }
      else {
        res.sendStatus(403);
      }
    });
    app[method](`/${HAXCMS.sitesDirectory}/*${HAXCMS.basePath}${HAXCMS.systemRequestBase}${route}`, extra ,(req, res, next) => {
      const op = req.route.path.replace(`/${HAXCMS.sitesDirectory}/*${HAXCMS.basePath}${HAXCMS.systemRequestBase}`, '');
      const rMethod = req.method.toLowerCase();
      if (OpenRoutes.includes(op) || HAXCMS.validateJWT(req, res)) {
        // call the method
        RoutesMap[rMethod][op](req, res, next);
      }
      else {
        res.sendStatus(403);
      }
    });
  }
}

server.listen(port, async (err) => {
	if (err) {
		throw err;
	}
  const openPkg = await import('open');
  const open = openPkg.default;
  // opens the url in the default browser 
  open('http://localhost:8000');
	/* eslint-disable no-console */
	console.log('open: http://localhost:8000');
});