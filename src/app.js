#!/usr/bin/env node

// lib dependencies
var argv = require('minimist')(process.argv.slice(2));
const express = require('express');
// load config from dot files
require('dotenv').config()
const cookieParser = require('cookie-parser');
const compression = require('compression');
const helmet = require('helmet');
const app = express();
const mime = require('mime');
const path = require('path');
const fs = require("fs-extra");
const server = require('http').Server(app);
const PAGE_VARIANT_CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
};
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
      imgSrc: ["'self'", "data:", "https:", "http:", "blob:"],
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

  const wsServer = new ws.Server({server: server});
  wsServer.on("connection", (ws) => {
    chokidar.watch(`${process.cwd()}/custom/src/`).on('change', async (path, stats) => {
      path = path.replace(/.*(?=custom\/src)/, '');
      await exec("cd custom && npm run build");
      ws.send("theme reload")
    });
  }
  );
}
app.use(express.urlencoded({limit: '50mb',  extended: false, parameterLimit: 50000 }));
app.use(helmet(helmetPolicies));
app.use(cookieParser());
app.use(compression());

// Security: Force download of HTML files in sites' files directories to prevent XSS
app.use((req, res, next) => {
  if (req.url.includes('/files/') && /\.html?$/i.test(req.url.split('?')[0])) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  next();
});
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
    app.use('/', async (req, res, next) => {
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
        !req.url.includes('/x/') && (
          req.url.includes('custom/build') || 
          req.url.includes('/theme/') || 
          req.url.includes('/assets/') || 
          req.url.includes('/manifest.json') || 
          req.url.includes('/robots.txt') ||
          req.url.includes('/llms.txt') ||
          req.url.includes('/files/') || 
          req.url.includes('/pages/') || 
          req.url.includes('/site.json')
        )
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
        const requestPath = getRequestPathWithoutQuery(req.url);
        let variantResponse = {
          served: false,
          item: null,
          canonicalPath: null,
        };
        if (requestPath.indexOf('/x/') !== 0) {
          variantResponse = tryServePageVariantRequest(
            req,
            res,
            site,
            requestPath,
            ''
          );
          if (variantResponse.served) {
            return;
          }
          if (variantResponse.item && variantResponse.canonicalPath) {
            setPageAlternateHeaders(
              res,
              site,
              variantResponse.item,
              variantResponse.canonicalPath
            );
          }
        }
        // all page calls just go to the index and the front end will render them
        if (mime.getType(req.url.split('?')[0])) {
          res.setHeader('Content-Type', mime.getType(req.url));
        }
        else {
          res.setHeader('Content-Type', 'text/html');
        }
        try {
          let indexFile = await renderDynamicSiteIndexResponse(
            req,
            site,
            variantResponse.item,
            variantResponse.canonicalPath,
            path.join(publicDir, 'index.html')
          );
          // injects a websocket for livereload support when developing custom components
          if (process.env.NODE_ENV === "development") {
            indexFile = injectDevReloadScript(indexFile, port);
          }
          res.send(indexFile);
        }
        catch (e) {
          // fallback to static index delivery if runtime injection fails
          res.sendFile(`index.html`, {
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
    app.use(`/${HAXCMS.sitesDirectory}/`, async (req, res, next) => {
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
        !req.url.includes('/x/') && (
          req.url.includes('custom/build') || 
          req.url.includes('/theme/') || 
          req.url.includes('/assets/') || 
          req.url.includes('/manifest.json') || 
          req.url.includes('/robots.txt') ||
          req.url.includes('/llms.txt') ||
          req.url.includes('/files/') || 
          req.url.includes('/pages/') || 
          req.url.includes('/site.json')
        )
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
        const multisiteRequestPath = getRequestPathWithoutQuery(req.url);
        const siteName = getMultisiteSiteName(multisiteRequestPath);
        let siteContext = null;
        let variantResponse = {
          served: false,
          item: null,
          canonicalPath: null,
        };
        if (siteName) {
          siteContext = await HAXCMS.loadSite(siteName);
          const siteSubPath = getMultisiteSiteSubPath(multisiteRequestPath);
          if (siteContext && siteSubPath.indexOf('/x/') !== 0) {
              variantResponse = tryServePageVariantRequest(
                req,
                res,
                siteContext,
                siteSubPath,
                `/${HAXCMS.sitesDirectory}/${siteName}`
              );
              if (variantResponse.served) {
                return;
              }
              if (variantResponse.item && variantResponse.canonicalPath) {
                setPageAlternateHeaders(
                  res,
                  siteContext,
                  variantResponse.item,
                  variantResponse.canonicalPath
                );
              }
          }
        }
        if (mime.getType(req.url.split('?')[0])) {
          res.setHeader('Content-Type', mime.getType(req.url));
        }
        else {
          res.setHeader('Content-Type', 'text/html');
        }
        if (siteContext && siteContext.siteDirectory) {
          try {
            let indexFile = await renderDynamicSiteIndexResponse(
              req,
              siteContext,
              variantResponse.item,
              variantResponse.canonicalPath,
              path.join(siteContext.siteDirectory, 'index.html')
            );
            res.send(indexFile);
            return;
          }
          catch (e) {}
        }
        // send static index fallback even if route points to a non-file path
        res.sendFile(req.url.replace(/\/(.*?)\/(.*)/, `/${HAXCMS.sitesDirectory}/$1/index.html`), {
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
        extra = upload.any();
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
        !req.url.startsWith('/llms.txt') &&
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
function getRequestPathWithoutQuery(url = '') {
  return String(url || '').split('?')[0];
}

function getExplicitVariantInfo(pathname = '') {
  const matched = String(pathname || '').match(/^(.*)\.(html|md|json|ya?ml|xml)$/i);
  if (!matched) {
    return {
      format: null,
      basePath: pathname,
    };
  }
  let format = matched[2].toLowerCase();
  if (format === 'yml') {
    format = 'yaml';
  }
  return {
    format,
    basePath: matched[1] || '',
  };
}

function getNegotiatedVariantFormat(acceptHeader = '') {
  const accept = String(acceptHeader || '').toLowerCase();
  const acceptsHtml =
    accept.indexOf('text/html') !== -1 ||
    accept.indexOf('application/xhtml+xml') !== -1;
  if (acceptsHtml) {
    return null;
  }
  if (accept.indexOf('text/markdown') !== -1) {
    return 'md';
  }
  if (
    accept.indexOf('application/yaml') !== -1 ||
    accept.indexOf('application/x-yaml') !== -1 ||
    accept.indexOf('text/yaml') !== -1
  ) {
    return 'yaml';
  }
  if (
    accept.indexOf('application/xml') !== -1 ||
    accept.indexOf('text/xml') !== -1
  ) {
    return 'xml';
  }
  if (
    accept.indexOf('application/json') !== -1 &&
    accept.indexOf('text/html') === -1
  ) {
    return 'json';
  }
  return null;
}

function normalizeSlugFromPath(pathname = '') {
  let slugPath = String(pathname || '').replace(/^\/+/, '');
  slugPath = slugPath.replace(/\/+$/, '');
  return slugPath;
}

function resolvePageBySlug(site, slug = '') {
  if (
    !site ||
    !site.manifest ||
    !Array.isArray(site.manifest.items) ||
    slug === ''
  ) {
    return null;
  }
  if (site.manifest.getItemByProperty) {
    const matched = site.manifest.getItemByProperty('slug', slug);
    if (matched) {
      return matched;
    }
  }
  for (let i = 0; i < site.manifest.items.length; i++) {
    const item = site.manifest.items[i];
    if (item && item.slug === slug) {
      return item;
    }
  }
  return null;
}

function buildCanonicalPagePath(routePrefix = '', slug = '') {
  const cleanPrefix = String(routePrefix || '').replace(/\/+$/, '');
  const cleanSlug = String(slug || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (cleanSlug === '') {
    if (cleanPrefix === '') {
      return '/';
    }
    return cleanPrefix;
  }
  if (cleanPrefix === '') {
    return '/' + cleanSlug;
  }
  return cleanPrefix + '/' + cleanSlug;
}

function appendVaryHeader(res, value = 'Accept') {
  const currentHeader = res.getHeader('Vary');
  if (!currentHeader) {
    res.setHeader('Vary', value);
    return;
  }
  const current = String(currentHeader);
  const entries = current.split(',').map((entry) => entry.trim().toLowerCase());
  if (entries.indexOf(value.toLowerCase()) === -1) {
    res.setHeader('Vary', current + ', ' + value);
  }
}

function getPageVariantLocation(site, item, format = 'json') {
  if (!site || !item || !item.location) {
    return null;
  }
  if (site.getPageAlternateLocation) {
    return site.getPageAlternateLocation(item.location, format);
  }
  if (/\.html?$/i.test(item.location)) {
    return item.location.replace(/\.html?$/i, '.' + format);
  }
  return item.location + '.' + format;
}

function resolveVariantFilePath(site, item, format = 'json') {
  const variantLocation = getPageVariantLocation(site, item, format);
  if (!variantLocation || !site || !site.siteDirectory) {
    return null;
  }
  const absolutePath = path.join(site.siteDirectory, variantLocation);
  if (fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isFile()) {
    return absolutePath;
  }
  return null;
}

function servePageVariantFile(res, site, item, format, canonicalPath, negotiated = false) {
  const variantFilePath = resolveVariantFilePath(site, item, format);
  if (!variantFilePath) {
    return false;
  }
  const contentType = PAGE_VARIANT_CONTENT_TYPES[format] || 'text/plain; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  if (canonicalPath) {
    res.setHeader('Content-Location', canonicalPath + '.' + format);
  }
  if (negotiated) {
    appendVaryHeader(res, 'Accept');
  }
  res.sendFile(variantFilePath);
  return true;
}

function setPageAlternateHeaders(res, site, item, canonicalPath = '') {
  if (!site || !item || !canonicalPath) {
    return;
  }
  const links = [];
  const formats = Object.keys(PAGE_VARIANT_CONTENT_TYPES);
  for (let i = 0; i < formats.length; i++) {
    const format = formats[i];
    const variantFilePath = resolveVariantFilePath(site, item, format);
    if (variantFilePath) {
      links.push(
        '<' + canonicalPath + '.' + format + '>; rel="alternate"; type="' +
        PAGE_VARIANT_CONTENT_TYPES[format].replace('; charset=utf-8', '') + '"'
      );
    }
  }
  if (links.length > 0) {
    res.setHeader('Link', links.join(', '));
    appendVaryHeader(res, 'Accept');
  }
}

function tryServePageVariantRequest(req, res, site, requestPath = '', routePrefix = '') {
  const explicitInfo = getExplicitVariantInfo(requestPath);
  const slug = normalizeSlugFromPath(explicitInfo.basePath);
  if (slug === '') {
    return {
      served: false,
      item: null,
      canonicalPath: null,
    };
  }
  const item = resolvePageBySlug(site, slug);
  if (!item) {
    if (explicitInfo.format) {
      res.status(404);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send('Not found');
      return {
        served: true,
        item: null,
        canonicalPath: null,
      };
    }
    return {
      served: false,
      item: null,
      canonicalPath: null,
    };
  }
  const canonicalPath = buildCanonicalPagePath(routePrefix, slug);
  if (explicitInfo.format) {
    const servedExplicit = servePageVariantFile(
      res,
      site,
      item,
      explicitInfo.format,
      canonicalPath
    );
    if (!servedExplicit) {
      res.status(404);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send('Not found');
    }
    return {
      served: true,
      item,
      canonicalPath,
    };
  }
  const negotiatedFormat = getNegotiatedVariantFormat(req.headers.accept);
  if (negotiatedFormat) {
    const servedNegotiated = servePageVariantFile(
      res,
      site,
      item,
      negotiatedFormat,
      canonicalPath,
      true
    );
    if (servedNegotiated) {
      return {
        served: true,
        item,
        canonicalPath,
      };
    }
  }
  return {
    served: false,
    item,
    canonicalPath,
  };
}

function getMultisiteSiteName(requestPath = '') {
  const pathParts = String(requestPath || '').replace(/^\/+/, '').split('/');
  if (pathParts.length === 0 || pathParts[0] === '') {
    return null;
  }
  return pathParts[0];
}

function getMultisiteSiteSubPath(requestPath = '') {
  const pathParts = String(requestPath || '').replace(/^\/+/, '').split('/');
  if (pathParts.length <= 1) {
    return '/';
  }
  return '/' + pathParts.slice(1).join('/');
}

function getRequestAbsoluteUrl(req, fallbackPath = '/') {
  let protocol = 'http';
  if (req && req.headers && typeof req.headers['x-forwarded-proto'] === 'string' && req.headers['x-forwarded-proto'] !== '') {
    protocol = req.headers['x-forwarded-proto'].split(',')[0].trim();
  }
  else if (req && req.protocol) {
    protocol = req.protocol;
  }
  let host = '';
  if (req && req.headers && typeof req.headers['x-forwarded-host'] === 'string' && req.headers['x-forwarded-host'] !== '') {
    host = req.headers['x-forwarded-host'].split(',')[0].trim();
  }
  else if (req && req.headers && typeof req.headers.host === 'string') {
    host = req.headers.host;
  }
  let requestPath = fallbackPath;
  if (req && (req.originalUrl || req.url)) {
    requestPath = getRequestPathWithoutQuery(req.originalUrl || req.url);
  }
  if (!requestPath || typeof requestPath !== 'string') {
    requestPath = '/';
  }
  if (requestPath.substring(0, 1) !== '/') {
    requestPath = '/' + requestPath;
  }
  if (host === '') {
    return requestPath;
  }
  return protocol + '://' + host + requestPath;
}

function sanitizeManagedHeadMarkup(markup = '') {
  return String(markup || '').replace(/\\"/g, '"');
}

function replaceManagedHeadMarkup(indexFile = '', metadata = '', serviceWorkerScript = '') {
  const cleanMetadata = sanitizeManagedHeadMarkup(metadata);
  const cleanServiceWorkerScript = sanitizeManagedHeadMarkup(serviceWorkerScript);
  let managedHeadMarkup = cleanMetadata;
  if (cleanServiceWorkerScript !== '') {
    managedHeadMarkup += '\n' + cleanServiceWorkerScript + '\n';
  }
  let output = String(indexFile || '');
  const managedHeadPattern = /<meta charset[\s\S]*?(?=\s*<style[\s>])/i;
  if (managedHeadPattern.test(output)) {
    output = output.replace(managedHeadPattern, managedHeadMarkup + '\n');
    return output;
  }
  if (output.indexOf('</head>') !== -1) {
    output = output.replace('</head>', managedHeadMarkup + '\n</head>');
  }
  return output;
}

function replaceSiteBuilderContent(indexFile = '', pageContent = '') {
  const builderPattern = /<haxcms-site-builder([^>]*)>[\s\S]*?<\/haxcms-site-builder>/i;
  if (!builderPattern.test(indexFile)) {
    return indexFile;
  }
  return String(indexFile || '').replace(
    builderPattern,
    '<haxcms-site-builder$1>' + String(pageContent || '') + '</haxcms-site-builder>'
  );
}

function injectDevReloadScript(indexFile = '', port = 3000) {
  const devScript = `
  <script>
    const socket = new WebSocket('ws://localhost:${port}');
    socket.addEventListener('open', function () {
      socket.send('connected to server successfully');
    });
    socket.addEventListener('message', function (event) {
      if (event.data === 'theme reload') {
        globalThis.location.reload();
      }
    });
  </script>`;
  return String(indexFile || '').replace('</body>', `${devScript}
</body>`);
}

async function renderDynamicSiteIndexResponse(req, site, item, canonicalPath = '', indexFilePath = '') {
  let indexFile = fs.readFileSync(indexFilePath, 'utf8');
  const absoluteUrl = getRequestAbsoluteUrl(req, canonicalPath || '/');
  const metadata = await site.getSiteMetadata(item || null, absoluteUrl, '', canonicalPath || '');
  const serviceWorkerScript = site.getServiceWorkerScript(null, false, site.getServiceWorkerStatus());
  indexFile = replaceManagedHeadMarkup(indexFile, metadata, serviceWorkerScript);
  let pageContent = '';
  if (item) {
    try {
      pageContent = await site.getPageContent(item);
    }
    catch (e) {
      pageContent = '';
    }
  }
  indexFile = replaceSiteBuilderContent(indexFile, pageContent);
  return indexFile;
}
