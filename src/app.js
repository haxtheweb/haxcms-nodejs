#!/usr/bin/env node

// lib dependencies
var argv = require('minimist')(process.argv.slice(2));
const express = require('express');
// load config from dot files
require('dotenv').config()
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const app = express();
const mime = require('mime');
const path = require('path');
const fs = require("fs-extra");
const server = require('http').Server(app);
// HAXcms core settings
process.env.haxcms_middleware = "node-express";
const { HAXCMS, systemStructureContext } = require('./lib/HAXCMS.js');
// default helmet policies for CSP
var helmetPolicies = {
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "www.youtube.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "data:", "https:"],
      mediaSrc: ["'self'", "data:", "https:"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:", "ws:"],
      defaultSrc: ["'self'", "data:", "https:"],
      objectSrc: ["'none'"],
      fontSrc: ["'self'", "data:", "fonts.gstatic.com"],
      frameAncestors: ["'self'"],
    },
  },
  referrerPolicy: {
    policy: ["origin", "unsafe-url"],
  },
};

// flag in local development that disables security
// this way you launch from local and don't need a U/P relationship
if (process.env.HAXCMS_DISABLE_JWT_CHECKS || argv._.includes('HAXCMS_DISABLE_JWT_CHECKS')) {
  HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = true;
  // disable security policies that would otherwise block local development
  // also enables webcontainer environments which is what our playground runs
  helmetPolicies.contentSecurityPolicy = false;
  helmetPolicies.crossOriginResourcePolicy = false;
  helmetPolicies.crossOriginEmbedderPolicy = 'require-corp';
  helmetPolicies.crossOriginOpenerPolicy = 'same-origin';
}
// routes with all requires
const { RoutesMap, OpenRoutes } = require('./lib/RoutesMap.js');
// app settings
const multer = require('multer');
const { crossOriginOpenerPolicy } = require('helmet');
const upload = multer({ dest: path.join(HAXCMS.configDirectory, 'tmp/') })
let publicDir = path.join(__dirname, '/public');
// if in development, live reload
if (process.env.NODE_ENV === "development") {
  const child_process = require("child_process");
  const util = require("util");
  const exec = util.promisify(child_process.exec);
  const ws = require("ws");
  const chokidar = require("chokidar");

  console.log("development")
  const wsServer = new ws.Server({server: server});
  wsServer.on("connection", (ws) => {
    chokidar.watch(`${process.cwd()}/custom/src/`).on('change', async (path, stats) => {
      path = path.replace(/.*(?=custom\/src)/, '');
      console.log(`file change: ${path}, rebuilding`)
      await exec("cd custom && npm run build");
      ws.send("theme reload")
    });
  }
  );
}
app.use(express.urlencoded({limit: '50mb',  extended: false, parameterLimit: 50000 }));
app.use(helmet(helmetPolicies));
app.use(cookieParser());
//pre-flight requests
app.options('*', function(req, res, next) {
	res.sendStatus(200);
});
// attempt to establish context of site vs multi-site environment
const port = process.env.PORT || 3000;
systemStructureContext().then((site) => {
  // see if we have a single site context or if we need routes for multisite
  if (site) {
    // we have a site context, need paths to resolve to cwd instead of subsite path
    // in this configuration there is no overworld / 8-bit game to make new sites
    // this assumes a site has already been made or is being navigated to to work on
    // works great w/ CLI in stand alone mode for local developer
    publicDir = site.siteDirectory;
    if (process.env.NODE_ENV === "development") {
      // express.static will only serve the original static index.html file
      // so dev builds need to set this ignore option to inject any edits
      app.use(express.static(publicDir, { index: false }));
    } else {
      app.use(express.static(publicDir));
    }
    app.use('/', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', `http://localhost:${port}`);
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
        req.url.includes('custom/build') || 
        req.url.includes('/theme/') || 
        req.url.includes('/assets/') || 
        req.url.includes('/manifest.json') || 
        req.url.includes('/robots.txt') ||
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
        // injects a websocket for livereload support when developing custom components
        if (process.env.NODE_ENV === "development") {
          let indexFile = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
          const devScript = `
  <script>
    const socket = new WebSocket('ws://localhost:${port}');
    // Connection opened
    socket.addEventListener('open', function (event) {
        socket.send('connected to server successfully')
    });
    socket.addEventListener('message', function (event) {
      if(event.data === 'theme reload') {
        window.location.reload();
      }
    });
  </script>`;

          indexFile = indexFile.replace('</body>', `${devScript}
</body>`);
          res.send(indexFile);
        } else {
          // send file for the index even tho route says it's a path not on our file system
          // this way internal routing picks up and loads the correct content while
          // at the same time express has delivered us SOMETHING as the path in the request
          // url doesn't actually exist
          res.sendFile(`index.html`,
            {
              root: publicDir
            });
        }
      }
    });
  }
  else {
    app.use(express.static(publicDir));
    app.use('/', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', `http://localhost:${port}`);
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
        req.url.includes('custom/build') || 
        req.url.includes('/theme/') || 
        req.url.includes('/assets/') || 
        req.url.includes('/manifest.json') || 
        req.url.includes('/robots.txt') ||
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
        root: process.cwd() + `/${HAXCMS.publishedDirectory}`
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
  // can't do this for a site context
  if (!site) {
    // catch anything called on homepage that doens't match and ensure it still goes through so that it 404s correctly
    app.get('*', function(req, res, next) {
      if (
        req.url !== '/' &&
        !req.url.startsWith('/build') &&
        !req.url.startsWith('/site.json') &&
        !req.url.startsWith('/system') &&
        !req.url.startsWith('/_sites') &&
        !req.url.startsWith('/assets') &&
        !req.url.startsWith('/wc-registry.json') &&
        !req.url.startsWith('/favicon.ico') &&
        !req.url.startsWith('/manifest.json') &&
        !req.url.startsWith('/robots.txt') &&
        !req.url.startsWith('/VERSION.txt')
      ) {
        res.sendFile('/',
        {
          root: `${__dirname}/public/`
        });
      }
      else {
        next();
      }
    });
  }
});
server.listen(port, async (err) => {
  if (err) {
    throw err;
  }
  /* eslint-disable no-console */
  console.log(`open: http://localhost:${port}`);  
});


function handleServerError(e) {
  if (e.syscall !== "listen") throw e;

  switch (e.code) {
    case "EACCES":
      console.error(`${port} requires elevated privileges`);
      process.exit(1);
      break;
    case "EADDRINUSE":
      console.error(`${port} is already in use`);
      process.exit(1);
      break;
    default:
      throw error;
  }
}

server.on("error", handleServerError);