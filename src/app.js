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
const YAML = require('yaml');
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
const loginRateLimiter = require('./lib/loginRateLimiter.js');
// trust proxy is config-driven so forwarded client IPs (req.ip) are accurate
// behind a reverse proxy; defaults to false for single-host/local setups.
app.set('trust proxy', HAXCMS.getTrustProxySetting());
// default helmet policies for CSP
var helmetPolicies = {
  contentSecurityPolicy: {
    directives: {
      // NOTE: 'unsafe-eval' is required by HAXcms boot bundles (build.js /
      // build-haxcms.js) and several web components which call new Function()/
      // eval() at runtime (e.g. global detection, the wc-registry "magic"
      // loader chain). Removing it causes a CSP EvalError that aborts build.js,
      // so sites never finish loading. 'wasm-unsafe-eval' does NOT cover JS
      // eval/new Function, so both are kept.
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
    policy: "same-origin",
  },
};

// flag in local development that disables security
// this way you launch from local and don't need a U/P relationship
if (process.env.HAXCMS_DISABLE_JWT_CHECKS || argv._.includes('HAXCMS_DISABLE_JWT_CHECKS')) {
  if (HAXCMS.isProductionRuntime()) {
    // never honor the local-development security bypass in production
    console.error('SECURITY: HAXCMS_DISABLE_JWT_CHECKS is ignored because NODE_ENV=production.');
  }
  else {
    HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = true;
    // disable security policies that would otherwise block local development
    // also enables webcontainer environments which is what our playground runs
    helmetPolicies.contentSecurityPolicy = false;
    helmetPolicies.crossOriginResourcePolicy = false;
    // COEP must be the object form ({ policy }) for helmet to honor the value;
    // a bare string silently falls back to the require-corp default. Use
    // 'credentialless' so we keep cross-origin isolation (SharedArrayBuffer /
    // the webcontainer playground) WITHOUT blocking cross-origin subresources
    // that omit CORP (e.g. CDN module/asset loads via the wc-registry magic
    // loader). 'require-corp' blocked those with
    // ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep.
    helmetPolicies.crossOriginEmbedderPolicy = { policy: 'credentialless' };
    helmetPolicies.crossOriginOpenerPolicy = { policy: 'same-origin' };
  }
}
// routes with all requires
const {
  allRoutes,
  SiteRoutesMap,
  SystemRoutesMap,
  SystemV1OpenRoutes,
  SystemV1AdminRoutes,
} = require('./lib/allRoutes.js');
// app settings
const multer = require('multer');
const { crossOriginOpenerPolicy } = require('helmet');
const upload = multer({ dest: path.join(HAXCMS.configDirectory, 'tmp/') })
const jsonRequestParser = express.json({
  type: ['application/json', 'application/*+json'],
  limit: '10mb'
});
const uploadAnyParser = upload.any();
function parseSchemaFileOperationBody(req, res, next) {
  const contentType = req && req.headers && typeof req.headers['content-type'] === 'string'
    ? req.headers['content-type'].toLowerCase()
    : '';
  if (contentType.indexOf('multipart/form-data') === 0) {
    return uploadAnyParser(req, res, next);
  }
  return jsonRequestParser(req, res, next);
}
function getSiteApiRouteParser(method = 'get', route = '') {
  const normalizedMethod = String(method || 'get').toLowerCase();
  const normalizedRoute = String(route || '');
  if (normalizedMethod === 'post' && normalizedRoute === 'v1/files') {
    return uploadAnyParser;
  }
  if (
    normalizedMethod === 'post' ||
    normalizedMethod === 'put' ||
    normalizedMethod === 'patch' ||
    normalizedMethod === 'delete'
  ) {
    return jsonRequestParser;
  }
  return null;
}
function getSystemV1RouteParser(method = 'get', route = '') {
  const normalizedMethod = String(method || 'get').toLowerCase();
  const normalizedRoute = String(route || '');
  if (
    normalizedMethod === 'post' &&
    (
      normalizedRoute === 'configuration/schema-files/operations' ||
      normalizedRoute === 'configuration/skeletons' ||
      normalizedRoute === 'skeletons'
    )
  ) {
    return parseSchemaFileOperationBody;
  }
  if (
    normalizedMethod === 'post' ||
    normalizedMethod === 'put' ||
    normalizedMethod === 'patch' ||
    normalizedMethod === 'delete'
  ) {
    return jsonRequestParser;
  }
  return null;
}
let publicDir = path.join(__dirname, '/public');
const WEBCOMPONENTS_ROOT_ENV_VAR = 'HAXCMS_WEBCOMPONENTS_ROOT';
const linkedWebcomponentsRoot = getLinkedWebcomponentsRoot();
const linkedWebcomponentsNodeModulesRoot = linkedWebcomponentsRoot
  ? path.join(linkedWebcomponentsRoot, 'node_modules')
  : null;
const linkedDevImportMapMarkup = buildLinkedDevImportMapMarkup();
const SITE_API_OPENAPI_SPEC_PATH = path.join(
  __dirname,
  'openapi',
  'site-spec.yaml',
);
let siteApiAuthPoliciesByMethodAndRoute = null;

function getLinkedWebcomponentsRoot() {
  if (process.env.NODE_ENV !== "development") {
    return null;
  }
  if (
    !process.env[WEBCOMPONENTS_ROOT_ENV_VAR] ||
    String(process.env[WEBCOMPONENTS_ROOT_ENV_VAR]).trim() === ''
  ) {
    return null;
  }
  const resolvedPath = path.resolve(
    String(process.env[WEBCOMPONENTS_ROOT_ENV_VAR]).trim()
  );
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }
  if (!fs.lstatSync(resolvedPath).isDirectory()) {
    return null;
  }
  return resolvedPath;
}

function isPathInsideDirectory(parentPath = '', targetPath = '') {
  const relativePath = path.relative(parentPath, targetPath);
  if (relativePath === '') {
    return true;
  }
  return relativePath.indexOf('..') !== 0 && !path.isAbsolute(relativePath);
}

function getBuildAssetRequestPath(url = '') {
  const requestPath = String(url || '').split('?')[0];
  return requestPath
    .replace(/\/(.*?)\/build\//g, "build/")
    .replace(/\/(.*?)\/wc-registry.json/g, "wc-registry.json")
    .replace(/\/(.*?)\/build.js/g, "build.js")
    .replace(/\/(.*?)\/build-haxcms.js/g, "build-haxcms.js");
}

function isBuildAssetRequest(url = '') {
  const requestPath = String(url || '').split('?')[0];
  return (
    requestPath.indexOf('/build/') !== -1 ||
    requestPath.indexOf('wc-registry.json') !== -1 ||
    requestPath.indexOf('build.js') !== -1 ||
    requestPath.indexOf('build-haxcms.js') !== -1
  );
}

function resolveLinkedNodeModuleAssetPath(modulePath = '') {
  if (!linkedWebcomponentsNodeModulesRoot) {
    return null;
  }
  const normalizedModulePath = String(modulePath || '').replace(/^\/+/, '');
  if (normalizedModulePath === '') {
    return null;
  }
  const baseCandidatePath = path.join(
    linkedWebcomponentsNodeModulesRoot,
    normalizedModulePath
  );
  const candidatePaths = [baseCandidatePath];
  if (path.extname(normalizedModulePath) === '') {
    candidatePaths.push(`${baseCandidatePath}.js`);
    candidatePaths.push(`${baseCandidatePath}.mjs`);
    candidatePaths.push(`${baseCandidatePath}.cjs`);
    candidatePaths.push(path.join(baseCandidatePath, 'index.js'));
    candidatePaths.push(path.join(baseCandidatePath, 'index.mjs'));
    candidatePaths.push(path.join(baseCandidatePath, 'index.cjs'));
    const packageEntryPath = resolvePackageEntryPath(baseCandidatePath);
    if (packageEntryPath) {
      candidatePaths.push(path.join(baseCandidatePath, packageEntryPath));
    }
  }
  for (let i = 0; i < candidatePaths.length; i++) {
    const candidatePath = candidatePaths[i];
    if (
      !isPathInsideDirectory(
        linkedWebcomponentsNodeModulesRoot,
        candidatePath
      )
    ) {
      continue;
    }
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }
  return null;
}

function resolveLinkedDevAssetPath(cleanFilePath = '') {
  if (!linkedWebcomponentsRoot) {
    return null;
  }
  const normalizedPath = String(cleanFilePath || '').replace(/^\/+/, '');
  if (normalizedPath.indexOf('build/es6/node_modules/') === 0) {
    if (!linkedWebcomponentsNodeModulesRoot) {
      return null;
    }
    const modulePath = normalizedPath.replace('build/es6/node_modules/', '');
    const resolvedModulePath = resolveLinkedNodeModuleAssetPath(modulePath);
    if (resolvedModulePath) {
      return resolvedModulePath;
    }
    return null;
  }
  if (
    normalizedPath === 'build.js' ||
    normalizedPath === 'build-haxcms.js' ||
    normalizedPath === 'wc-registry.json'
  ) {
    const candidatePath = path.join(linkedWebcomponentsRoot, normalizedPath);
    if (!isPathInsideDirectory(linkedWebcomponentsRoot, candidatePath)) {
      return null;
    }
    if (fs.existsSync(candidatePath) && fs.lstatSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }
  return null;
}

function serveBuildAssetFile(req, res, fallbackRoot = '') {
  const cleanFilePath = getBuildAssetRequestPath(req.url);
  const linkedAssetPath = resolveLinkedDevAssetPath(cleanFilePath);
  if (linkedAssetPath) {
    res.sendFile(linkedAssetPath);
    return;
  }
  res.sendFile(cleanFilePath, { root: fallbackRoot });
}

function safeReadJsonFile(filePath = '') {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  catch (e) {
    return null;
  }
}

function isDirectoryPath(targetPath = '') {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return false;
  }
  try {
    return fs.statSync(targetPath).isDirectory();
  }
  catch (e) {
    return false;
  }
}

function resolveExportsEntryPath(exportsField = null) {
  if (!exportsField) {
    return null;
  }
  if (typeof exportsField === 'string') {
    return exportsField;
  }
  if (typeof exportsField !== 'object') {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(exportsField, '.')) {
    const rootEntry = resolveExportsEntryPath(exportsField['.']);
    if (rootEntry) {
      return rootEntry;
    }
  }
  const preferredConditions = [
    'import',
    'browser',
    'default',
    'module',
    'development',
    'production',
    'node'
  ];
  for (let i = 0; i < preferredConditions.length; i++) {
    const condition = preferredConditions[i];
    if (Object.prototype.hasOwnProperty.call(exportsField, condition)) {
      const conditionEntry = resolveExportsEntryPath(exportsField[condition]);
      if (conditionEntry) {
        return conditionEntry;
      }
    }
  }
  const exportKeys = Object.keys(exportsField);
  for (let i = 0; i < exportKeys.length; i++) {
    const key = exportKeys[i];
    if (key.indexOf('./') === 0) {
      continue;
    }
    const entry = resolveExportsEntryPath(exportsField[key]);
    if (entry) {
      return entry;
    }
  }
  return null;
}

function normalizePackageEntryPath(entryPath = '') {
  let normalizedPath = String(entryPath || '').replace(/\\/g, '/');
  if (normalizedPath.indexOf('./') === 0) {
    normalizedPath = normalizedPath.substring(2);
  }
  if (normalizedPath.indexOf('/') === 0) {
    normalizedPath = normalizedPath.substring(1);
  }
  if (normalizedPath === '') {
    normalizedPath = 'index.js';
  }
  if (normalizedPath.charAt(normalizedPath.length - 1) === '/') {
    normalizedPath += 'index.js';
  }
  return normalizedPath;
}

function resolvePackageEntryPath(packageDirectory = '') {
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  const packageJson = safeReadJsonFile(packageJsonPath);
  let entryPath = null;
  if (packageJson) {
    entryPath = resolveExportsEntryPath(packageJson.exports);
    if (!entryPath && packageJson.module) {
      entryPath = packageJson.module;
    }
    if (!entryPath && packageJson['jsnext:main']) {
      entryPath = packageJson['jsnext:main'];
    }
    if (!entryPath && typeof packageJson.browser === 'string') {
      entryPath = packageJson.browser;
    }
    if (!entryPath && packageJson.main) {
      entryPath = packageJson.main;
    }
  }
  entryPath = normalizePackageEntryPath(entryPath || 'index.js');
  let absoluteEntryPath = path.join(packageDirectory, entryPath);
  if (fs.existsSync(absoluteEntryPath) && fs.statSync(absoluteEntryPath).isFile()) {
    return entryPath;
  }
  if (path.extname(entryPath) === '') {
    const extensionFallbacks = [
      `${entryPath}.js`,
      `${entryPath}.mjs`,
      `${entryPath}.cjs`,
      path.join(entryPath, 'index.js'),
      path.join(entryPath, 'index.mjs')
    ];
    for (let i = 0; i < extensionFallbacks.length; i++) {
      const candidate = extensionFallbacks[i];
      absoluteEntryPath = path.join(packageDirectory, candidate);
      if (fs.existsSync(absoluteEntryPath) && fs.statSync(absoluteEntryPath).isFile()) {
        return candidate.replace(/\\/g, '/');
      }
    }
  }
  return null;
}

function discoverNodeModulePackages(nodeModulesRoot = '') {
  const packages = [];
  if (!isDirectoryPath(nodeModulesRoot)) {
    return packages;
  }
  const topLevelEntries = fs.readdirSync(nodeModulesRoot);
  for (let i = 0; i < topLevelEntries.length; i++) {
    const entryName = topLevelEntries[i];
    if (!entryName || entryName.charAt(0) === '.') {
      continue;
    }
    const entryPath = path.join(nodeModulesRoot, entryName);
    if (!isDirectoryPath(entryPath)) {
      continue;
    }
    if (entryName.charAt(0) === '@') {
      const scopedEntries = fs.readdirSync(entryPath);
      for (let j = 0; j < scopedEntries.length; j++) {
        const scopedName = scopedEntries[j];
        if (!scopedName || scopedName.charAt(0) === '.') {
          continue;
        }
        const scopedPath = path.join(entryPath, scopedName);
        if (!isDirectoryPath(scopedPath)) {
          continue;
        }
        packages.push({
          packageName: `${entryName}/${scopedName}`,
          packageDirectory: scopedPath
        });
      }
    }
    else {
      packages.push({
        packageName: entryName,
        packageDirectory: entryPath
      });
    }
  }
  return packages;
}

function buildLinkedDevImportMapMarkup() {
  if (!linkedWebcomponentsNodeModulesRoot) {
    return '';
  }
  const imports = {};
  const packages = discoverNodeModulePackages(linkedWebcomponentsNodeModulesRoot);
  for (let i = 0; i < packages.length; i++) {
    const packageName = packages[i].packageName;
    const packageDirectory = packages[i].packageDirectory;
    const packagePrefixPath = `/build/es6/node_modules/${packageName}/`;
    imports[`${packageName}/`] = packagePrefixPath;
    const packageEntryPath = resolvePackageEntryPath(packageDirectory);
    if (packageEntryPath) {
      imports[packageName] = packagePrefixPath + packageEntryPath;
    }
  }
  return `<script type="importmap" data-haxcms-linked-dev-importmap>${JSON.stringify({ imports })}</script>`;
}

function getLinkedDevDedupingFixMarkup() {
  if (!linkedWebcomponentsNodeModulesRoot) {
    return '';
  }
  const dedupingFixPath = path.join(
    linkedWebcomponentsNodeModulesRoot,
    '@haxtheweb',
    'deduping-fix',
    'deduping-fix.js'
  );
  if (!fs.existsSync(dedupingFixPath)) {
    return '';
  }
  return '<script src="./build/es6/node_modules/@haxtheweb/deduping-fix/deduping-fix.js" data-haxcms-linked-dev-deduping-fix></script>';
}

function injectLinkedDevDedupingFix(indexFile = '') {
  let output = String(indexFile || '');
  if (output.indexOf('build-haxcms.js') !== -1) {
    return output;
  }
  const dedupingFixMarkup = getLinkedDevDedupingFixMarkup();
  if (!dedupingFixMarkup) {
    return output;
  }
  if (output.indexOf('data-haxcms-linked-dev-deduping-fix') !== -1) {
    return output;
  }
  const earlyInjectionMarkers = [
    '<script type="importmap"',
    'rel="modulepreload"',
    "rel='modulepreload'",
    'type="module"',
    "type='module'"
  ];
  let markerIndex = -1;
  for (let i = 0; i < earlyInjectionMarkers.length; i++) {
    const currentMarkerIndex = output.indexOf(earlyInjectionMarkers[i]);
    if (
      currentMarkerIndex !== -1 &&
      (markerIndex === -1 || currentMarkerIndex < markerIndex)
    ) {
      markerIndex = currentMarkerIndex;
    }
  }
  if (markerIndex !== -1) {
    const tagStart = output.lastIndexOf('<', markerIndex);
    if (tagStart !== -1) {
      return `${output.substring(0, tagStart)}${dedupingFixMarkup}\n${output.substring(tagStart)}`;
    }
  }
  if (output.indexOf('</head>') !== -1) {
    return output.replace('</head>', `${dedupingFixMarkup}\n</head>`);
  }
  return `${dedupingFixMarkup}\n${output}`;
}

function injectLinkedDevImportMap(indexFile = '') {
  let output = String(indexFile || '');
  if (!linkedDevImportMapMarkup) {
    return output;
  }
  if (output.indexOf('data-haxcms-linked-dev-importmap') !== -1) {
    return output;
  }
  const firstImportMapScriptIndex = output.indexOf('<script type="importmap"');
  if (firstImportMapScriptIndex !== -1) {
    const firstImportMapScriptEndIndex = output.indexOf('</script>', firstImportMapScriptIndex);
    if (firstImportMapScriptEndIndex !== -1) {
      const insertAt = firstImportMapScriptEndIndex + '</script>'.length;
      return `${output.substring(0, insertAt)}\n${linkedDevImportMapMarkup}${output.substring(insertAt)}`;
    }
  }
  const earlyInjectionMarkers = [
    'rel="modulepreload"',
    "rel='modulepreload'",
    'type="module"',
    "type='module'"
  ];
  for (let i = 0; i < earlyInjectionMarkers.length; i++) {
    const marker = earlyInjectionMarkers[i];
    const markerIndex = output.indexOf(marker);
    if (markerIndex !== -1) {
      const tagStart = output.lastIndexOf('<', markerIndex);
      if (tagStart !== -1) {
        return `${output.substring(0, tagStart)}${linkedDevImportMapMarkup}\n${output.substring(tagStart)}`;
      }
    }
  }
  if (output.indexOf('</head>') !== -1) {
    return output.replace('</head>', `${linkedDevImportMapMarkup}\n</head>`);
  }
  return `${linkedDevImportMapMarkup}\n${output}`;
}
// if in development, live reload
if (process.env.NODE_ENV === "development") {
  const child_process = require("child_process");
  const util = require("util");
  const exec = util.promisify(child_process.exec);
  const ws = require("ws");
  const chokidar = require("chokidar");
  const customSrcPath = path.join(process.cwd(), 'custom/src');
  const linkedElementsPath = linkedWebcomponentsRoot
    ? path.join(linkedWebcomponentsRoot, 'elements')
    : null;

  const wsServer = new ws.Server({server: server});
  const connectedClients = new Set();

  function sendReloadToConnectedClients() {
    connectedClients.forEach((client) => {
      if (client.readyState === ws.OPEN) {
        client.send("theme reload");
      }
    });
  }

  async function handleWatchedFileChange(filePath = '') {
    if (isPathInsideDirectory(customSrcPath, filePath)) {
      try {
        await exec("cd custom && npm run build");
      }
      catch (e) {}
    }
    sendReloadToConnectedClients();
  }

  wsServer.on("connection", (socket) => {
    connectedClients.add(socket);
    socket.on('close', () => {
      connectedClients.delete(socket);
    });
  });

  const watchTargets = [customSrcPath];
  if (linkedElementsPath && fs.existsSync(linkedElementsPath)) {
    watchTargets.push(linkedElementsPath);
  }
  const watcher = chokidar.watch(watchTargets, { ignoreInitial: true });
  watcher.on('change', handleWatchedFileChange);
  watcher.on('add', handleWatchedFileChange);
  watcher.on('unlink', handleWatchedFileChange);
}
app.use(express.urlencoded({limit: '50mb',  extended: false, parameterLimit: 50000 }));
app.use(helmet(helmetPolicies));
app.use(cookieParser());
app.use(compression());
app.use((req, res, next) => {
  if (
    isSystemAdminApiRequest(req) ||
    shouldDisableResponseCache(req)
  ) {
    setNoStoreResponseHeaders(res);
  }
  next();
});

// Security: Force download of HTML files in sites' files directories to prevent XSS
app.use((req, res, next) => {
  if (req.url.includes('/files/') && /\.html?$/i.test(req.url.split('?')[0])) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  next();
});

// Security: never web-serve HAXcms secret/config files. In single-site mode the
// served root can be a site directory that also contains the _config dir, so a
// raw static request could otherwise reach keys/credentials. Resolve the request
// to its path segments and 404 anything targeting the config dir or a sensitive
// file (mirrors the .htaccess protections used by the PHP backend).
const SENSITIVE_STATIC_BASENAMES = [
  '.pk',
  '.rpk',
  'salt.txt',
  '.user',
  'config.php',
  'config.json',
  '.htaccess',
  '.ishaxcmsconfig',
];
function isSensitiveStaticPath(url = '') {
  let decodedPath = String(url || '').split('?')[0];
  try {
    decodedPath = decodeURIComponent(decodedPath);
  }
  catch (e) {
    // fall back to the raw path if it cannot be decoded
  }
  const segments = decodedPath
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '') {
      continue;
    }
    // the HAXcms config directory itself must never be web-served
    if (segment === '_config') {
      return true;
    }
    if (SENSITIVE_STATIC_BASENAMES.indexOf(segment) !== -1) {
      return true;
    }
  }
  return false;
}
app.use((req, res, next) => {
  if (isSensitiveStaticPath(req.url)) {
    // respond as if the path does not exist; never disclose secret material
    res.status(404).end();
    return;
  }
  next();
});
//pre-flight requests
app.options('*', function(req, res, next) {
	res.sendStatus(200);
});
if (linkedWebcomponentsRoot) {
  app.use((req, res, next) => {
    if (
      !req.url.includes('/custom/build/') &&
      isBuildAssetRequest(req.url)
    ) {
      if (mime.getType(req.url.split('?')[0])) {
        res.setHeader('Content-Type', mime.getType(req.url.split('?')[0]));
      }
      serveBuildAssetFile(req, res, path.join(__dirname, '/public'));
      return;
    }
    next();
  });
}
// attempt to establish context of site vs multi-site environment
const DEFAULT_PORT = 3000
const MAX_PORT = 65535
let currentPort = Number.parseInt(process.env.PORT, 10)
if (Number.isNaN(currentPort)) {
  currentPort = DEFAULT_PORT
}
let resolveServerReady
const serverReady = new Promise((resolve) => {
  resolveServerReady = resolve
})
let serverReadyResolved = false
function getRuntimePort() {
  const address = server.address()
  if (
    address &&
    typeof address === 'object' &&
    typeof address.port === 'number'
  ) {
    return address.port
  }
  return currentPort
}
systemStructureContext().then((site) => {
  // see if we have a single site context or if we need routes for multisite
  if (site) {
    // we have a site context, need paths to resolve to cwd instead of subsite path
    // in this configuration there is no overworld / 8-bit game to make new sites
    // this assumes a site has already been made or is being navigated to to work on
    // works great w/ CLI in stand alone mode for local developer
    publicDir = site.siteDirectory;
    HAXCMS.runtimeServerMode = 'single-site';
    if (process.env.NODE_ENV === "development") {
      // express.static will only serve the original static index.html file
      // so dev builds need to set this ignore option to inject any edits
      app.use(express.static(publicDir, { index: false }));
    } else {
      app.use(express.static(publicDir));
    }
    app.use('/', async (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', HAXCMS.getCorsAllowedOrigin(`http://localhost:${currentPort}`));
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept');
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/system/api/') || isSiteApiRequestPath(req.url)) {
        next()
      }
      // previous will catch as json, undo that
      else if (
        !req.url.includes('/custom/build/') && 
        (
          req.url.includes('/build/') || 
          req.url.includes('wc-registry.json') ||
          req.url.includes('build.js') ||
          req.url.includes('build-haxcms.js')
        )
      ) {
        if (mime.getType(req.url.split('?')[0])) {
          res.setHeader('Content-Type', mime.getType(req.url));
        }
        serveBuildAssetFile(req, res, path.join(__dirname, '/public'));
      }
      else if (
        !req.url.includes('/x/') && (
          req.url.includes('custom/build') || 
          req.url.includes('/theme/') || 
          req.url.includes('/assets/') || 
          req.url.includes('/manifest.json') || 
          req.url.includes('/robots.txt') ||
          req.url.includes('/llms.txt') ||
          req.url.includes('/rss.xml') ||
          req.url.includes('/atom.xml') ||
          req.url.includes('/sitemap.xml') ||
          req.url.includes('/sitemap-index.xml') ||
          req.url.includes('/.well-known/') ||
          req.url.includes('/files/') || 
          req.url.includes('/pages/') || 
          req.url.includes('/site.json')
        )
      ) {
        if (!setWellKnownContentType(res, req.url)) {
          if (mime.getType(req.url.split('?')[0])) {
            res.setHeader('Content-Type', mime.getType(req.url));
          }
          else {
            res.setHeader('Content-Type', 'text/html');
          }
        }
        res.sendFile(
          req.url.split('?')[0],
          getStaticSendFileOptions(publicDir, req.url)
        );
      }
      else {
        const requestPath = getRequestPathWithoutQuery(req.url);
        let variantResponse = {
          served: false,
          item: null,
          canonicalPath: null,
          notFound: false,
        };
        if (requestPath.indexOf('/x/') !== 0) {
          variantResponse = await tryServePageVariantRequest(
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
        const pageMiss = variantResponse.notFound === true;
        if (pageMiss) {
          res.status(404);
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
            pageMiss,
            path.join(publicDir, 'index.html')
          );
          // injects a websocket for livereload support when developing custom components
          if (process.env.NODE_ENV === "development") {
            indexFile = injectLinkedDevDedupingFix(indexFile);
            indexFile = injectLinkedDevImportMap(indexFile);
            indexFile = injectDevReloadScript(indexFile, currentPort);
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
    HAXCMS.runtimeServerMode = 'multisite';
    if (process.env.NODE_ENV === "development") {
      app.use(express.static(publicDir, { index: false }));
    }
    else {
      app.use(express.static(publicDir));
    }
    app.use('/', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', HAXCMS.getCorsAllowedOrigin(`http://localhost:${currentPort}`));
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept');
      res.setHeader('Content-Type', 'application/json');
      // dynamic step routes in HAXcms site list UI
      const requestPath = getRequestPathWithoutQuery(req.url);
      const isDashboardIndexRequest = (
        requestPath === '/' ||
        requestPath === '/home' ||
        requestPath === '/index.html' ||
        requestPath.indexOf('/createSite-step-') === 0
      );
      if (!isDashboardIndexRequest) {
        next();
      }
      else {
        if (mime.getType(requestPath)) {
          res.setHeader('Content-Type', mime.getType(requestPath));
        }
        else {
          res.setHeader('Content-Type', 'text/html');
        }
        if (process.env.NODE_ENV === "development") {
          try {
            let indexFile = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
            indexFile = injectLinkedDevDedupingFix(indexFile);
            indexFile = injectLinkedDevImportMap(indexFile);
            indexFile = injectDevReloadScript(indexFile, currentPort);
            res.send(indexFile);
            return;
          }
          catch (e) {}
        }
        res.sendFile(requestPath.replace(/\/createSite-step-(.*)/, '/').replace(/\/home/, '/'), {
          root: publicDir
        });
      }
    });
    // sites need rewriting to work with PWA routes without failing file location
    // similar to htaccess
    app.use(`/${HAXCMS.sitesDirectory}/`, async (req, res, next) => {
      const multisiteRequestPath = getRequestPathWithoutQuery(req.url);
      if (multisiteRequestPath === '/' || multisiteRequestPath === '') {
        const queryIndex = req.url.indexOf('?');
        const querySuffix = queryIndex !== -1 ? req.url.substring(queryIndex) : '';
        res.redirect(302, `/${querySuffix}`);
        return;
      }
      if (/^\/[^/]+$/.test(multisiteRequestPath)) {
        const queryIndex = req.url.indexOf('?');
        const querySuffix = queryIndex !== -1 ? req.url.substring(queryIndex) : '';
        res.redirect(301, `${req.baseUrl}${multisiteRequestPath}/${querySuffix}`);
        return;
      }
      if (req.url.includes('/system/api/') || isSiteApiRequestPath(req.url)) {
        next()
      }
      // previous will catch as json, undo that
      else if (
        !req.url.includes('/custom/build/') && 
        (
          req.url.includes('/build/') || 
          req.url.includes('wc-registry.json') ||
          req.url.includes('build.js') ||
          req.url.includes('build-haxcms.js')
        )
      ) {
        if (mime.getType(req.url.split('?')[0])) {
          res.setHeader('Content-Type', mime.getType(req.url));
        }
        serveBuildAssetFile(req, res, publicDir);
      }
      else if (
        !req.url.includes('/x/') && (
          req.url.includes('custom/build') || 
          req.url.includes('/theme/') || 
          req.url.includes('/assets/') || 
          req.url.includes('/manifest.json') || 
          req.url.includes('/robots.txt') ||
          req.url.includes('/llms.txt') ||
          req.url.includes('/rss.xml') ||
          req.url.includes('/atom.xml') ||
          req.url.includes('/sitemap.xml') ||
          req.url.includes('/sitemap-index.xml') ||
          req.url.includes('/.well-known/') ||
          req.url.includes('/files/') || 
          req.url.includes('/pages/') || 
          req.url.includes('/site.json')
        )
      ) {
        if (!setWellKnownContentType(res, req.url)) {
          if (mime.getType(req.url.split('?')[0])) {
            res.setHeader('Content-Type', mime.getType(req.url));
          }
          else {
            res.setHeader('Content-Type', 'text/html');
          }
        }
        res.sendFile(
          req.url.split('?')[0],
          getStaticSendFileOptions(
            process.cwd() + `/${HAXCMS.sitesDirectory}`,
            req.url
          )
        );
      }
      else {
        const siteName = getMultisiteSiteName(multisiteRequestPath);
        let siteContext = null;
        let variantResponse = {
          served: false,
          item: null,
          canonicalPath: null,
          notFound: false,
        };
        if (siteName) {
          siteContext = await HAXCMS.loadSite(siteName);
          const siteSubPath = getMultisiteSiteSubPath(multisiteRequestPath);
          if (siteContext && siteSubPath.indexOf('/x/') !== 0) {
              variantResponse = await tryServePageVariantRequest(
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
        const pageMiss = variantResponse.notFound === true;
        if (pageMiss) {
          res.status(404);
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
              pageMiss,
              path.join(siteContext.siteDirectory, 'index.html')
            );
            if (process.env.NODE_ENV === "development") {
              indexFile = injectLinkedDevDedupingFix(indexFile);
              indexFile = injectLinkedDevImportMap(indexFile);
              indexFile = injectDevReloadScript(indexFile, currentPort);
            }
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
  const siteRouteRegistry =
    allRoutes &&
    allRoutes.site &&
    allRoutes.site.map &&
    typeof allRoutes.site.map === 'object'
      ? allRoutes.site.map
      : SiteRoutesMap;
  const systemRouteRegistry =
    allRoutes &&
    allRoutes.system &&
    allRoutes.system.map &&
    typeof allRoutes.system.map === 'object'
      ? allRoutes.system.map
      : SystemRoutesMap;
  const systemV1OpenRouteRegistry =
    allRoutes &&
    allRoutes.system &&
    Array.isArray(allRoutes.system.openRoutes)
      ? allRoutes.system.openRoutes
      : SystemV1OpenRoutes;
  // loop through scoped system API routes and register under /system/api/v1
  const systemApiV1BasePath = `${HAXCMS.basePath}${HAXCMS.systemRequestBase}v1/`;
  for (let systemMethod in systemRouteRegistry) {
    for (let systemRoute in systemRouteRegistry[systemMethod]) {
      const systemRoutePath = `${systemApiV1BasePath}${systemRoute}`;
      const systemRouteParser = getSystemV1RouteParser(systemMethod, systemRoute);
      const systemRouteHandler = (req, res, next) => {
        const op = req.route.path.replace(systemApiV1BasePath, '');
        const rMethod = req.method.toLowerCase();
        if (!validateSystemV1RouteAccess(req, op)) {
          return res.status(403).json({
            status: 403,
            message: 'system admin route requires system dashboard access',
          });
        }
        if (systemV1OpenRouteRegistry.includes(op) || HAXCMS.validateJWT(req, res)) {
          return systemRouteRegistry[rMethod][op](req, res, next);
        }
        return res.sendStatus(403);
      };
      const siteScopedSystemRouteHandler = (req, res, next) => {
        const op = req.route.path.replace(
          `/${HAXCMS.sitesDirectory}/*${systemApiV1BasePath}`,
          '',
        );
        const rMethod = req.method.toLowerCase();
        if (!validateSystemV1RouteAccess(req, op)) {
          return res.status(403).json({
            status: 403,
            message: 'system admin route requires system dashboard access',
          });
        }
        if (systemV1OpenRouteRegistry.includes(op) || HAXCMS.validateJWT(req, res)) {
          return systemRouteRegistry[rMethod][op](req, res, next);
        }
        return res.sendStatus(403);
      };
      if (systemRouteParser) {
        app[systemMethod](
          systemRoutePath,
          systemRouteParser,
          systemRouteHandler,
        );
        app[systemMethod](
          `/${HAXCMS.sitesDirectory}/*${systemRoutePath}`,
          systemRouteParser,
          siteScopedSystemRouteHandler,
        );
      }
      else {
        app[systemMethod](systemRoutePath, systemRouteHandler);
        app[systemMethod](
          `/${HAXCMS.sitesDirectory}/*${systemRoutePath}`,
          siteScopedSystemRouteHandler,
        );
      }
    }
  }
  // loop through site API routes and register discovery/read paths under x/api
  const siteApiBasePath = getSiteApiBasePath();
  for (let siteMethod in siteRouteRegistry) {
    for (let siteRoute in siteRouteRegistry[siteMethod]) {
      const routeSuffix = siteRoute === '' ? '' : '/' + siteRoute;
      const siteRoutePath = `${siteApiBasePath}${routeSuffix}`;
      const siteRouteParser = getSiteApiRouteParser(siteMethod, siteRoute);
      const siteRouteHandler = async (req, res, next) => {
        try {
          const access = await validateSiteApiRouteAccess(req, siteRoute, siteMethod);
          if (!access.allowed) {
            if (access.retryAfterSeconds && access.retryAfterSeconds > 0) {
              res.set('Retry-After', String(access.retryAfterSeconds));
            }
            return res.status(access.status).json({
              status: access.status,
              message: access.message,
            });
          }
          siteRouteRegistry[siteMethod][siteRoute](req, res, next);
        } catch (e) {
          return res.status(500).json({
            status: 500,
            message: 'Unable to evaluate site API access policy',
          });
        }
      };
      if (siteRouteParser) {
        app[siteMethod](siteRoutePath, siteRouteParser, siteRouteHandler);
        app[siteMethod](
          `/${HAXCMS.sitesDirectory}/*${siteRoutePath}`,
          siteRouteParser,
          siteRouteHandler,
        );
      } else {
        app[siteMethod](siteRoutePath, siteRouteHandler);
        app[siteMethod](
          `/${HAXCMS.sitesDirectory}/*${siteRoutePath}`,
          siteRouteHandler,
        );
      }
    }
  }
  assertSiteApiMutationRoutesAreSecured(siteRouteRegistry);
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
        !req.url.startsWith('/llms.txt')
      ) {
        if (process.env.NODE_ENV === "development") {
          try {
            let indexFile = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
            indexFile = injectLinkedDevDedupingFix(indexFile);
            indexFile = injectLinkedDevImportMap(indexFile);
            indexFile = injectDevReloadScript(indexFile, currentPort);
            res.send(indexFile);
            return;
          }
          catch (e) {}
        }
        res.sendFile('/', {
          root: `${__dirname}/public/`
        });
      }
      else {
        next();
      }
    });
  }
});
server.on('listening', onServerListening);
server.on('error', handleServerError);
startServer(currentPort);

function startServer(portToTry) {
  currentPort = Number(portToTry)
  server.listen(currentPort)
}
function onServerListening() {
  const runtimePort = getRuntimePort()
  currentPort = runtimePort
  process.env.PORT = `${runtimePort}`
  if (!serverReadyResolved) {
    resolveServerReady(runtimePort)
    serverReadyResolved = true
  }
  /* eslint-disable no-console */
  console.log(`open: http://localhost:${runtimePort}`);
}

function handleServerError(e) {
  if (e.syscall !== "listen") throw e;

  switch (e.code) {
    case "EACCES":
      console.error(`${currentPort} requires elevated privileges`);
      process.exit(1);
      break;
    case "EADDRINUSE": {
      if (currentPort >= MAX_PORT) {
        console.error(`No available port found after trying ${currentPort}`);
        process.exit(1);
        break;
      }
      const nextPort = currentPort + 1;
      console.warn(`${currentPort} is already in use, trying ${nextPort}`);
      setTimeout(() => {
        startServer(nextPort);
      }, 50);
      break;
    }
    default:
      throw e;
  }
}
module.exports = {
  app,
  server,
  serverReady
};
function isSiteScopedSystemApiRoutePattern(req) {
  if (!req || !req.route || typeof req.route.path !== 'string') {
    return false;
  }
  return req.route.path.indexOf(`/${HAXCMS.sitesDirectory}/`) === 0;
}
function isDashboardRefererRequest(req) {
  if (!req || !req.headers || typeof req.headers.referer !== 'string') {
    return false;
  }
  return req.headers.referer.indexOf(`/${HAXCMS.sitesDirectory}/`) === -1;
}
function setNoStoreResponseHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') {
    return;
  }
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}
function normalizePathForCacheMatching(value = '') {
  let normalized = String(value || '');
  if (normalized === '') {
    return '/';
  }
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.charAt(0) !== '/') {
    normalized = '/' + normalized;
  }
  if (normalized.length > 1 && normalized.charAt(normalized.length - 1) === '/') {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}
function hasQueryParameter(req, key) {
  if (!req || !req.query || typeof req.query !== 'object') {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(req.query, key);
}
function isSystemAdminApiRequest(req) {
  if (!req) {
    return false;
  }
  const requestPath = normalizePathForCacheMatching(
    getRequestPathWithoutQuery(req.originalUrl || req.url),
  );
  const systemRequestBasePath = normalizePathForCacheMatching(
    '/' + String(HAXCMS.systemRequestBase || '').replace(/^\/+/, ''),
  );
  if (systemRequestBasePath === '/') {
    return false;
  }
  if (requestPath === systemRequestBasePath) {
    return true;
  }
  return requestPath.indexOf(systemRequestBasePath + '/') !== -1;
}
function shouldDisableResponseCache(req) {
  if (!req) {
    return false;
  }
  return hasQueryParameter(req, 'cb') || hasQueryParameter(req, 't');
}


function validateSystemV1RouteAccess(req, op = '') {
  if (SystemV1AdminRoutes.indexOf(op) === -1) {
    return true;
  }
  if (
    isSiteScopedSystemApiRoutePattern(req) &&
    !isDashboardRefererRequest(req)
  ) {
    return false;
  }
  return true;
}
function convertOpenApiPathToSiteRoute(openApiPath = '') {
  let route = String(openApiPath || '');
  if (route.indexOf('/x/api') !== 0) {
    return '';
  }
  route = route.replace(/^\/x\/api\/?/, '');
  route = route.replace(/^\//, '');
  route = route.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
  return route;
}
function normalizeSiteApiSecurityPolicy(securityConfig = null) {
  if (!Array.isArray(securityConfig)) {
    return 'public';
  }
  if (securityConfig.length === 0) {
    return 'public';
  }
  let requiresBearer = false;
  let requiresUserToken = false;
  for (let i = 0; i < securityConfig.length; i++) {
    const requirement = securityConfig[i];
    if (!requirement || typeof requirement !== 'object') {
      continue;
    }
    const keys = Object.keys(requirement);
    if (keys.length === 0) {
      return 'public';
    }
    if (Object.prototype.hasOwnProperty.call(requirement, 'siteTokenHeader')) {
      return 'authenticated-site';
    }
    if (Object.prototype.hasOwnProperty.call(requirement, 'userTokenHeader')) {
      requiresUserToken = true;
    }
    if (Object.prototype.hasOwnProperty.call(requirement, 'bearerAuth')) {
      requiresBearer = true;
    }
  }
  if (requiresUserToken) {
    return 'authenticated-user';
  }
  if (requiresBearer) {
    return 'authenticated';
  }
  return 'public';
}
function readSiteApiAuthPoliciesFromOpenApiSpec() {
  const policies = {};
  if (!fs.existsSync(SITE_API_OPENAPI_SPEC_PATH)) {
    return policies;
  }
  try {
    const openApiSpec = YAML.parse(
      fs.readFileSync(SITE_API_OPENAPI_SPEC_PATH, 'utf8'),
    );
    if (
      !openApiSpec ||
      typeof openApiSpec !== 'object' ||
      !openApiSpec.paths ||
      typeof openApiSpec.paths !== 'object'
    ) {
      return policies;
    }
    const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
    const pathKeys = Object.keys(openApiSpec.paths);
    for (let p = 0; p < pathKeys.length; p++) {
      const openApiPath = pathKeys[p];
      if (String(openApiPath).indexOf('/x/api') !== 0) {
        continue;
      }
      const routeKey = convertOpenApiPathToSiteRoute(openApiPath);
      const pathConfig = openApiSpec.paths[openApiPath];
      if (!pathConfig || typeof pathConfig !== 'object') {
        continue;
      }
      const pathLevelPolicy = normalizeSiteApiSecurityPolicy(pathConfig.security);
      for (let m = 0; m < methods.length; m++) {
        const method = methods[m];
        if (!Object.prototype.hasOwnProperty.call(pathConfig, method)) {
          continue;
        }
        const operation = pathConfig[method];
        if (!operation || typeof operation !== 'object') {
          continue;
        }
        let policy = pathLevelPolicy;
        if (Object.prototype.hasOwnProperty.call(operation, 'security')) {
          policy = normalizeSiteApiSecurityPolicy(operation.security);
        }
        policies[`${method}:${routeKey}`] = policy;
      }
    }
  } catch (e) {
    console.warn('Unable to parse site OpenAPI auth policy map', e);
  }
  return policies;
}
function getSiteApiRouteAuthPolicy(route = '', method = 'get') {
  if (!siteApiAuthPoliciesByMethodAndRoute) {
    siteApiAuthPoliciesByMethodAndRoute = readSiteApiAuthPoliciesFromOpenApiSpec();
  }
  const lookupKey = `${String(method || 'get').toLowerCase()}:${String(route || '')}`;
  if (
    siteApiAuthPoliciesByMethodAndRoute &&
    Object.prototype.hasOwnProperty.call(siteApiAuthPoliciesByMethodAndRoute, lookupKey)
  ) {
    return siteApiAuthPoliciesByMethodAndRoute[lookupKey];
  }
  // Fail closed: any site API route not explicitly declared in the OpenAPI
  // spec requires authentication rather than falling open to public access.
  return 'authenticated';
}
function assertSiteApiMutationRoutesAreSecured(routeRegistry = null) {
  const registry =
    routeRegistry && typeof routeRegistry === 'object' ? routeRegistry : {};
  const offendingRoutes = [];
  const registryMethods = Object.keys(registry);
  for (let m = 0; m < registryMethods.length; m++) {
    const method = String(registryMethods[m] || '').toLowerCase();
    if (method === 'get' || method === 'head' || method === 'options') {
      continue;
    }
    const routeMap =
      registry[registryMethods[m]] &&
      typeof registry[registryMethods[m]] === 'object'
        ? registry[registryMethods[m]]
        : {};
    const routeKeys = Object.keys(routeMap);
    for (let r = 0; r < routeKeys.length; r++) {
      const route = routeKeys[r];
      if (getSiteApiRouteAuthPolicy(route, method) === 'public') {
        offendingRoutes.push(`${method.toUpperCase()} ${route}`);
      }
    }
  }
  if (offendingRoutes.length > 0) {
    console.error(
      `SECURITY: site API mutation routes resolve to a public auth policy and must declare security in site-spec.yaml: ${offendingRoutes.join(', ')}`,
    );
  }
  return offendingRoutes;
}
function getRequestHeaderValue(req, headerName = '') {
  if (!req || !req.headers || typeof req.headers !== 'object') {
    return '';
  }
  const normalizedHeaderName = String(headerName || '').toLowerCase().trim();
  if (normalizedHeaderName === '') {
    return '';
  }
  const value = req.headers[normalizedHeaderName];
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[0] || '').trim() : '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}
function getBearerJwtFromRequest(req) {
  const authorizationHeader = getRequestHeaderValue(req, 'authorization');
  if (authorizationHeader === '') {
    return '';
  }
  if (authorizationHeader.toLowerCase().indexOf('bearer ') !== 0) {
    return '';
  }
  return authorizationHeader.substring(7).trim();
}
function decodeBasicAuthCredentials(authorizationHeader = '') {
  const cleanHeader = String(authorizationHeader || '').trim();
  if (cleanHeader.toLowerCase().indexOf('basic ') !== 0) {
    return null;
  }
  const encodedCredentials = cleanHeader.substring(6).trim();
  if (encodedCredentials === '') {
    return null;
  }
  let decodedCredentials = '';
  try {
    decodedCredentials = Buffer.from(encodedCredentials, 'base64').toString(
      'utf8',
    );
  } catch (e) {
    return null;
  }
  const separatorIndex = decodedCredentials.indexOf(':');
  if (separatorIndex === -1) {
    return null;
  }
  return {
    userName: decodedCredentials.substring(0, separatorIndex),
    password: decodedCredentials.substring(separatorIndex + 1),
  };
}
function authenticateBasicAuthorizationRequest(req) {
  const authorizationHeader = getRequestHeaderValue(req, 'authorization');
  const basicAuthCredentials = decodeBasicAuthCredentials(authorizationHeader);
  if (!basicAuthCredentials) {
    return {
      attempted: false,
      authenticated: false,
      userName: '',
    };
  }
  const userName = String(basicAuthCredentials.userName || '').trim();
  const password = String(basicAuthCredentials.password || '');
  if (userName === '' || password === '') {
    return {
      attempted: true,
      authenticated: false,
      userName: '',
    };
  }
  // brute-force throttle shared with the username/password login route
  const rateLimitSettings = HAXCMS.getLoginRateLimitSettings();
  const now = Date.now();
  const attemptKey = loginRateLimiter.getAttemptKey(req, userName);
  const attemptEntry = loginRateLimiter.getTrackerEntry(
    attemptKey,
    now,
    rateLimitSettings,
  );
  if (
    rateLimitSettings.enabled &&
    loginRateLimiter.isBlocked(attemptEntry, now)
  ) {
    const retryAfterSeconds = Math.ceil((attemptEntry.blockedUntil - now) / 1000);
    return {
      attempted: true,
      authenticated: false,
      userName: '',
      blocked: true,
      retryAfterSeconds: retryAfterSeconds > 0 ? retryAfterSeconds : 0,
    };
  }
  if (
    HAXCMS.testLogin(userName, password, true) &&
    HAXCMS.validateUser(userName)
  ) {
    if (rateLimitSettings.enabled) {
      loginRateLimiter.clearTrackerEntry(attemptKey);
    }
    return {
      attempted: true,
      authenticated: true,
      userName: userName,
    };
  }
  if (rateLimitSettings.enabled) {
    loginRateLimiter.registerFailedAttempt(attemptEntry, now, rateLimitSettings);
  }
  return {
    attempted: true,
    authenticated: false,
    userName: '',
  };
}
function getDecodedBearerJwtPayload(jwt = '') {
  const token = String(jwt || '').trim();
  if (token === '') {
    return null;
  }
  const decoded = HAXCMS.decodeJWT(token);
  if (!decoded || typeof decoded !== 'object') {
    return null;
  }
  return decoded;
}
function getAuthenticatedUserNameFromBearerJwt(jwt = '') {
  const decoded = getDecodedBearerJwtPayload(jwt);
  if (!decoded || !decoded.user) {
    return '';
  }
  return String(decoded.user);
}
function setSiteApiAuthContext(req, authContext = {}) {
  if (!req || typeof req !== 'object') {
    return;
  }
  req.haxcmsSiteApiAuth = {
    policy:
      authContext && authContext.policy
        ? String(authContext.policy)
        : 'public',
    authenticated:
      authContext && authContext.authenticated === true,
    userName:
      authContext && authContext.userName
        ? String(authContext.userName)
        : '',
    siteName:
      authContext && authContext.siteName
        ? String(authContext.siteName)
        : '',
    securityLevel:
      authContext && authContext.securityLevel
        ? String(authContext.securityLevel)
        : 'public',
  };
}
function normalizeSiteNameCandidate(siteName = '') {
  const cleanSiteName = String(siteName || '').trim();
  if (cleanSiteName === '') {
    return '';
  }
  try {
    return decodeURIComponent(cleanSiteName);
  } catch (e) {
    return cleanSiteName;
  }
}
function getSiteNameFromSiteApiRequestPath(url = '') {
  const parts = String(getRequestPathWithoutQuery(url) || '')
    .split('/')
    .filter((part) => part !== '');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === HAXCMS.sitesDirectory && parts[i + 1]) {
      return normalizeSiteNameCandidate(parts[i + 1]);
    }
  }
  return '';
}
function getSiteNameFromSiteApiRequestPayload(req) {
  if (!req || typeof req !== 'object') {
    return '';
  }
  const sources = [];
  if (req.params && typeof req.params === 'object') {
    sources.push(req.params);
  }
  if (req.query && typeof req.query === 'object') {
    sources.push(req.query);
  }
  if (req.body && typeof req.body === 'object') {
    sources.push(req.body);
  }
  const candidateKeys = [
    'siteName',
    'site',
    'sitename',
    'site_name',
  ];
  for (let s = 0; s < sources.length; s++) {
    const source = sources[s];
    for (let k = 0; k < candidateKeys.length; k++) {
      const key = candidateKeys[k];
      if (
        Object.prototype.hasOwnProperty.call(source, key) &&
        String(source[key] || '').trim() !== ''
      ) {
        return normalizeSiteNameCandidate(source[key]);
      }
    }
  }
  return '';
}
function getSiteNameFromSiteApiRequestReferer(req) {
  const referer = getRequestHeaderValue(req, 'referer');
  if (referer === '') {
    return '';
  }
  try {
    const parsed = new URL(referer);
    const refererPathSiteName = getSiteNameFromSiteApiRequestPath(parsed.pathname);
    if (refererPathSiteName !== '') {
      return refererPathSiteName;
    }
  } catch (e) {}
  return getSiteNameFromSiteApiRequestPath(referer);
}
async function resolveSiteApiRequestSiteName(req, authContext = {}) {
  const pathBasedSiteName = getSiteNameFromSiteApiRequestPath(
    req && req.originalUrl ? req.originalUrl : req && req.url ? req.url : '',
  );
  if (pathBasedSiteName !== '') {
    return pathBasedSiteName;
  }
  const payloadSiteName = getSiteNameFromSiteApiRequestPayload(req);
  if (payloadSiteName !== '') {
    return payloadSiteName;
  }
  const refererSiteName = getSiteNameFromSiteApiRequestReferer(req);
  if (refererSiteName !== '') {
    return refererSiteName;
  }
  try {
    const site = await systemStructureContext();
    if (
      site &&
      site.manifest &&
      site.manifest.metadata &&
      site.manifest.metadata.site &&
      site.manifest.metadata.site.name
    ) {
      return String(site.manifest.metadata.site.name);
    }
  } catch (e) {}
  return '';
}
function normalizeIamAuthorizationResult(iamAuthorization = null) {
  if (typeof iamAuthorization === 'boolean') {
    if (iamAuthorization) {
      return {
        allowed: true,
        status: 200,
        message: '',
      };
    }
    return {
      allowed: false,
      status: 403,
      message: 'Access denied',
    };
  }
  if (!iamAuthorization || typeof iamAuthorization !== 'object') {
    return {
      allowed: true,
      status: 200,
      message: '',
    };
  }
  if (iamAuthorization.allowed === false) {
    return {
      allowed: false,
      status: iamAuthorization.status || 403,
      message: iamAuthorization.message || 'Access denied',
    };
  }
  return {
    allowed: true,
    status: 200,
    message: '',
  };
}
function validateHaxiamManagedUserIdentityForRequest() {
  if (
    typeof HAXCMS.getDeploymentProfile !== 'function' ||
    HAXCMS.getDeploymentProfile() !== 'haxiam-managed'
  ) {
    return {
      allowed: true,
      status: 200,
      message: '',
    };
  }
  if (typeof HAXCMS.validateIAMRouteAuthorization !== 'function') {
    return {
      allowed: true,
      status: 200,
      message: '',
    };
  }
  try {
    return normalizeIamAuthorizationResult(
      HAXCMS.validateIAMRouteAuthorization(true),
    );
  } catch (e) {
    return {
      allowed: false,
      status: 403,
      message: 'Tenant identity validation failed',
    };
  }
}
async function validateSiteApiRouteAccess(req, route = '', method = 'get') {
  const policy = getSiteApiRouteAuthPolicy(route, method);
  const authContext = {
    policy,
    authenticated: false,
    userName: '',
    securityLevel: 'public',
  };
  if (HAXCMS.isCLI() || HAXCMS.HAXCMS_DISABLE_JWT_CHECKS) {
    authContext.authenticated = true;
    authContext.securityLevel = policy === 'public' ? 'authenticated' : policy;
    setSiteApiAuthContext(req, authContext);
    return {
      allowed: true,
      status: 200,
      message: '',
    };
  }
  const bearerJwt = getBearerJwtFromRequest(req);
  const hasBearerJwt = bearerJwt !== '';
  let invalidBearerJwt = false;
  if (hasBearerJwt) {
    const validBearer = HAXCMS.validateJWT(req, null);
    if (!validBearer) {
      invalidBearerJwt = true;
    } else {
      const authenticatedUserName = getAuthenticatedUserNameFromBearerJwt(
        bearerJwt,
      );
      if (authenticatedUserName !== '') {
        authContext.authenticated = true;
        authContext.userName = authenticatedUserName;
        authContext.securityLevel = 'authenticated';
      }
    }
  }
  const basicAuth = authenticateBasicAuthorizationRequest(req);
  if (basicAuth.authenticated && !authContext.authenticated) {
    authContext.authenticated = true;
    authContext.userName = basicAuth.userName;
    authContext.securityLevel = 'authenticated';
  }
  if (policy === 'public') {
    setSiteApiAuthContext(req, authContext);
    return {
      allowed: true,
      status: 200,
      message: '',
    };
  }
  if (basicAuth.blocked && !authContext.authenticated) {
    return {
      allowed: false,
      status: 429,
      message: 'Too many failed login attempts. Please try again later.',
      retryAfterSeconds: basicAuth.retryAfterSeconds,
    };
  }
  if (!hasBearerJwt && !basicAuth.attempted) {
    return {
      allowed: false,
      status: 401,
      message: 'Authorization bearer token or basic credentials are required for this endpoint',
    };
  }
  if (!authContext.authenticated) {
    if (basicAuth.attempted) {
      return {
        allowed: false,
        status: 401,
        message: 'Invalid basic authorization credentials',
      };
    }
    if (hasBearerJwt || invalidBearerJwt) {
      return {
        allowed: false,
        status: 401,
        message: 'Invalid bearer token',
      };
    }
    return {
      allowed: false,
      status: 401,
      message: 'Unable to authenticate request',
    };
  }
  if (authContext.userName === '') {
    return {
      allowed: false,
      status: 403,
      message: 'Unable to resolve authenticated user context',
    };
  }
  if (policy === 'authenticated') {
    authContext.securityLevel = 'authenticated';
  }
  if (policy === 'authenticated-site') {
    // Require and validate the site token even under Basic Auth so that
    // authentication alone (JWT or Basic) never grants site-scoped access.
    const siteToken = getRequestHeaderValue(req, 'x-haxcms-site-token');
    if (siteToken === '') {
      return {
        allowed: false,
        status: 403,
        message: 'X-HAXCMS-Site-Token header is required for this endpoint',
      };
    }
    const siteName = await resolveSiteApiRequestSiteName(req, {
      userName: authContext.userName,
      siteToken: siteToken,
    });
    if (!authContext.userName || !siteName) {
      return {
        allowed: false,
        status: 403,
        message: 'Unable to resolve site token context',
      };
    }
    if (
      !HAXCMS.validateRequestToken(
        siteToken,
        `${authContext.userName}:${siteName}`,
      )
    ) {
      return {
        allowed: false,
        status: 403,
        message: 'Invalid X-HAXCMS-Site-Token header',
      };
    }
    const iamAuthorization = validateHaxiamManagedUserIdentityForRequest();
    if (!iamAuthorization.allowed) {
      return {
        allowed: false,
        status: iamAuthorization.status || 403,
        message: iamAuthorization.message || 'Access denied',
      };
    }
    authContext.siteName = siteName;
    authContext.securityLevel = 'authenticated-site';
  }
  if (policy === 'authenticated-user') {
    // Require and validate the user token even under Basic Auth.
    const userToken = getRequestHeaderValue(req, 'x-haxcms-user-token');
    if (userToken === '') {
      return {
        allowed: false,
        status: 403,
        message: 'X-HAXCMS-User-Token header is required for this endpoint',
      };
    }
    if (!HAXCMS.validateRequestToken(userToken, authContext.userName)) {
      return {
        allowed: false,
        status: 403,
        message: 'Invalid X-HAXCMS-User-Token header',
      };
    }
    const iamAuthorization = validateHaxiamManagedUserIdentityForRequest();
    if (!iamAuthorization.allowed) {
      return {
        allowed: false,
        status: iamAuthorization.status || 403,
        message: iamAuthorization.message || 'Access denied',
      };
    }
    authContext.securityLevel = 'authenticated-user';
  }
  setSiteApiAuthContext(req, authContext);
  return {
    allowed: true,
    status: 200,
    message: '',
  };
}
function getNormalizedBasePath() {
  let basePath = String(HAXCMS.basePath || '/');
  if (basePath.charAt(0) !== '/') {
    basePath = '/' + basePath;
  }
  if (basePath.charAt(basePath.length - 1) !== '/') {
    basePath += '/';
  }
  return basePath;
}
function getSiteApiBasePath() {
  return getNormalizedBasePath() + 'x/api';
}
function getRequestPathWithoutQuery(url = '') {
  return String(url || '').split('?')[0];
}
function isSiteApiRequestPath(url = '') {
  return /\/x\/api(?:\/|$)/.test(getRequestPathWithoutQuery(url));
}
function setWellKnownContentType(res, requestPath = '') {
  const cleanRequestPath = getRequestPathWithoutQuery(requestPath);
  if (/\/\.well-known\/api-catalog$/.test(cleanRequestPath)) {
    res.setHeader(
      'Content-Type',
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'
    );
    return true;
  }
  if (/\/\.well-known\/security\.txt$/.test(cleanRequestPath)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return true;
  }
  return false;
}
function shouldAllowWellKnownDotfiles(requestPath = '') {
  const cleanRequestPath = getRequestPathWithoutQuery(requestPath);
  return /\/\.well-known(?:\/|$)/.test(cleanRequestPath);
}
function getStaticSendFileOptions(rootPath = '', requestPath = '') {
  const options = {
    root: rootPath,
  };
  if (shouldAllowWellKnownDotfiles(requestPath)) {
    options.dotfiles = 'allow';
  }
  return options;
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
async function ensurePageVariantFile(site, item, format = 'json') {
  let variantFilePath = resolveVariantFilePath(site, item, format);
  if (variantFilePath) {
    return variantFilePath;
  }
  if (
    site &&
    item &&
    typeof site.writePageAlternateFormats === 'function'
  ) {
    try {
      await site.writePageAlternateFormats(item);
    }
    catch (e) {}
    variantFilePath = resolveVariantFilePath(site, item, format);
    if (variantFilePath) {
      return variantFilePath;
    }
  }
  return null;
}

async function servePageVariantFile(res, site, item, format, canonicalPath, negotiated = false) {
  const variantFilePath = await ensurePageVariantFile(site, item, format);
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
async function tryServePageVariantRequest(req, res, site, requestPath = '', routePrefix = '') {
  const explicitInfo = getExplicitVariantInfo(requestPath);
  const slug = normalizeSlugFromPath(explicitInfo.basePath);
  if (slug === '') {
    return {
      served: false,
      item: null,
      canonicalPath: null,
      notFound: false,
    };
  }
  const item = resolvePageBySlug(site, slug);
  if (!item) {
    const missingCanonicalPath = buildCanonicalPagePath(routePrefix, slug);
    if (explicitInfo.format) {
      res.status(404);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send('Not found');
      return {
        served: true,
        item: null,
        canonicalPath: missingCanonicalPath,
        notFound: true,
      };
    }
    return {
      served: false,
      item: null,
      canonicalPath: missingCanonicalPath,
      notFound: true,
    };
  }
  const canonicalPath = buildCanonicalPagePath(routePrefix, slug);
  if (explicitInfo.format) {
    const servedExplicit = await servePageVariantFile(
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
      notFound: false,
    };
  }
  const negotiatedFormat = getNegotiatedVariantFormat(req.headers.accept);
  if (negotiatedFormat) {
    const servedNegotiated = await servePageVariantFile(
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
        notFound: false,
      };
    }
  }
  return {
    served: false,
    item,
    canonicalPath,
    notFound: false,
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
  let output = String(indexFile || '');
  if (output.indexOf('data-haxcms-dev-reload') !== -1) {
    return output;
  }
  const devScript = `
  <script data-haxcms-dev-reload>
    const socketProtocol = globalThis.location.protocol === 'https:' ? 'wss' : 'ws';
    const socketHost = globalThis.location.host || 'localhost:${port}';
    const socket = new WebSocket(socketProtocol + '://' + socketHost);
    socket.addEventListener('open', function () {
      socket.send('connected to server successfully');
    });
    socket.addEventListener('message', function (event) {
      if (event.data === 'theme reload') {
        const nextLocation = new URL(globalThis.location.href);
        nextLocation.searchParams.set('cb', String(Date.now()));
        globalThis.location.href = nextLocation.toString();
      }
    });
  </script>`;
  if (output.indexOf('</body>') !== -1) {
    return output.replace('</body>', `${devScript}
</body>`);
  }
  return `${output}
${devScript}`;
}

async function renderDynamicSiteIndexResponse(req, site, item, canonicalPath = '', pageMiss = false, indexFilePath = '') {
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
  else if (pageMiss) {
    pageContent = getPageMissShellMarkup();
  }
  indexFile = replaceSiteBuilderContent(indexFile, pageContent);
  return indexFile;
}
function getPageMissShellMarkup() {
  return `<style>
  .haxcms-page-miss {
    min-height: 60vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 12px;
    padding: 24px;
    font-family: "Press Start 2P", "Courier New", monospace;
  }
  .haxcms-page-miss__fire {
    font-size: 64px;
    line-height: 1;
    margin: 0;
  }
  .haxcms-page-miss__pixel {
    margin: 0;
    white-space: pre;
    line-height: 1.1;
    font-size: 16px;
  }
  .haxcms-page-miss__text {
    margin: 0;
    font-size: 15px;
    line-height: 1.4;
  }
</style>
<section class="haxcms-page-miss" role="alert" aria-live="polite">
  <p class="haxcms-page-miss__fire" aria-hidden="true">🔥</p>
  <pre class="haxcms-page-miss__pixel" aria-hidden="true">  ▗▄▖
 ▐█▀█▌
 ▐█▄█▌
  ▜█▛
  ▐▌▐▌</pre>
  <p class="haxcms-page-miss__text">The page miss, it burns!</p>
</section>`;
}
