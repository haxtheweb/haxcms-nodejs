#!/usr/bin/env node

// lib dependencies
process.env.haxcms_middleware = "node-express";
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const app = express();
const mime = require('mime');
const path = require('path');
const fs = require("fs-extra");
const server = require('http').Server(app);
// HAXcms core settings
const { HAXCMS } = require('./lib/HAXCMS.js');
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
let publicDir = path.join(__dirname, '/public');
//pre-flight requests
app.options('*', function(req, res, next) {
	res.send(200);
});
// attempt to establish context of site vs multi-site environment
const SITE_FILE_NAME = 'site.json';
searchForSiteJson().then((site) => {
  if (site) {
    // we have a site context, need paths to resolve to cwd instead of subsite path
    // in this configuration there is no overworld / 8-bit game to make new sites
    // this assumes a site has already been made or is being navigated to to work on
    // works great w/ CLI in stand alone mode for local developer
    publicDir = site.directoryRoot;
    app.use(express.static(publicDir));
    app.use('/', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8080');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept');
      res.setHeader('Content-Type', 'application/json');
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
          root: path.join(__dirname, '/public')
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
          root: publicDir
        });
      }
      else {
        // all page calls just go to the index and the front end will render them
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
        res.sendFile(`index.html`,
        {
          root: publicDir
        });
      }
    });
  }
  else {
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
  }
  // loop through methods and apply the route to the file to deliver it
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
});
// recursively look backwards for site.json until we find one or have none (null)
async function searchForSiteJson(dir = null) {
  if (!dir) {
    dir = process.cwd();
  }
  if (fs.pathExistsSync(path.join(dir, SITE_FILE_NAME))) {
    try {
      let response = await JSON.parse(fs.readFileSync(path.join(dir, SITE_FILE_NAME), 'utf8'));
      response.file = path.join(dir, SITE_FILE_NAME);
      response.directoryRoot = path.dirname(path.join(dir, SITE_FILE_NAME));
      return response;
    }
    catch(e) {
      // error parsing, so we don't have a site context
    }
  }
  return null;
}