#!/usr/bin/env node
// lib dependencies
var argv = require("minimist")(process.argv.slice(2));
const express = require("express");
// load config from dot files
require("dotenv").config();
const cookieParser = require("cookie-parser");
const compression = require("compression");
const helmet = require("helmet");
const app = express();
// Security (EXPRESS-FINGERPRINT-001 / I3): disable X-Powered-By explicitly
// at the Express layer so the header is never set, independent of helmet's
// default middleware. Defense-in-depth that survives any future helmet config.
app.disable("x-powered-by");
const mime = require("mime");
const path = require("path");
const fs = require("fs-extra");
const crypto = require("crypto");
const YAML = require("yaml");
const sslServer = require("./lib/sslServer.js");
const server = sslServer.createServer(app);
const serverProtocol = sslServer.getServerProtocol();
// Security (SEC-DEPLOY): interface selection for server.listen (loopback when
// the no-login bypass is active, HAXCMS_HOST always wins).
const {
  selectListenHost,
  getBypassExposureWarning,
  getBrowserHost,
  isLoopbackHostHeader,
  shouldEnforceLoopbackHostHeader,
} = require("./lib/listenHost.js");
const {
  requestUrlGuard,
  getBuildAssetRequestPath,
} = require("./lib/requestUrlGuards.js");
const PAGE_VARIANT_CONTENT_TYPES = {
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  yaml: "application/yaml; charset=utf-8",
  xml: "application/xml; charset=utf-8",
};
// HAXcms core settings
process.env.haxcms_middleware = "node-express";
const { HAXCMS, systemStructureContext } = require("./lib/HAXCMS.js");
const { resolveContainedPath } = require("./lib/pathConfinement.js");
const loginRateLimiter = require("./lib/loginRateLimiter.js");
const { createRequestRateLimiter } = require("./lib/requestRateLimiter.js");
const { haxcmsErrorHandler } = require("./lib/requestErrorHandler.js");
const { apiMessageCodesMiddleware } = require("./lib/apiMessageCodes.js");
// Shared CLI theme: replaces the bare `open: <url>` line with a unified,
// colorized "server is up" banner (issue haxtheweb/issues#2973). Falls back to
// the plain `open: <url>` line when color is disabled (CI / non-TTY / NO_COLOR).
const cliTheme = require("./lib/cliTheme.js");
// trust proxy is config-driven so forwarded client IPs (req.ip) are accurate
// behind a reverse proxy; defaults to false for single-host/local setups.
app.set("trust proxy", HAXCMS.getTrustProxySetting());
// default helmet policies for CSP. CSP is handled per-request (see the
// cspNonceMiddleware below) so each served HTML response gets a unique
// nonce in script-src, allowing 'unsafe-inline' to be dropped for scripts
// on the backend-served path. The static CSP directives object is kept as
// the base that the nonce middleware extends.
var helmetPolicies = {
  // contentSecurityPolicy is set per-request via cspNonceMiddleware, not via
  // helmet's global middleware, so the nonce can vary per response.
  contentSecurityPolicy: false,
  referrerPolicy: {
    policy: "same-origin",
  },
};
// Base CSP directives used by the per-request nonce middleware. 'unsafe-eval'
// is still required because several third-party libs bundled into the build
// (mobx, lunr, monaco, model-viewer, pouch-db, moment, openseadragon, mammoth,
// html-midi-player, latex2html5) call eval()/new Function() at runtime.
// 'wasm-unsafe-eval' does NOT cover JS eval/new Function, so both are kept.
// 'unsafe-inline' for scripts is dropped on the backend-served path in favor
// of per-response nonces (cspNonceMiddleware). 'unsafe-inline' stays for
// styleSrc because inline <style> blocks and the DDD design system rely on it.
// The YouTube IFrame API (loaded from www.youtube.com by a11y-media-youtube
// when video-player embeds a YouTube video) injects a small inline script
// into the page at runtime that we cannot nonce (it is Google's code, not
// ours). The sha256 hash below allowlists that specific inline script so
// YouTube playback works under the nonce CSP without re-adding
// 'unsafe-inline'. If YouTube rotates that script the hash will need updating
// (the browser reports the new hash in the CSP violation console message).
var cspBaseDirectives = {
  scriptSrc: [
    "'self'",
    "'unsafe-eval'",
    "'wasm-unsafe-eval'",
    "www.youtube.com",
    "'sha256-8eohedfRaQoWnH7igD20HvjedM7lPcYbqukJ7DEpMOk='",
  ],
  styleSrc: ["'self'", "'unsafe-inline'", "data:", "https:"],
  mediaSrc: ["'self'", "data:", "https:"],
  imgSrc: ["'self'", "data:", "https:", "http:", "blob:"],
  connectSrc: ["'self'", "https:", "ws:", "wss:"],
  defaultSrc: ["'self'", "data:", "https:"],
  objectSrc: ["'none'"],
  fontSrc: ["'self'", "data:", "fonts.gstatic.com"],
  frameAncestors: ["'self'"],
};
// Security (EXPRESS-HEADERS-001 / M2): mint a per-request nonce and set a
// Content-Security-Policy header with script-src 'nonce-<n>' (no
// 'unsafe-inline' for scripts) so inline <script> blocks in the served
// index.html can only execute when the server stamped them with the same
// nonce. This closes the simplest inline-script XSS primitive on the
// backend-served path. Stored on req.haxcmsCspNonce for injectNonce().
// Non-CSP helmet policies (referrerPolicy, x-content-type-options, etc.) are
// still applied globally via helmet(helmetPolicies) below; only CSP is split
// out here so the nonce can vary per response.
var cspNonceEnabled = true;
function cspNonceMiddleware(req, res, next) {
  // Security (M2): when the local-dev/webcontainer bypass disabled CSP
  // (HAXCMS_DISABLE_JWT_CHECKS, non-production), skip the nonce header so the
  // playground/CDN module loads are not blocked. Otherwise mint a per-request
  // nonce and set script-src 'nonce-<n>' (no 'unsafe-inline' for scripts).
  if (!cspNonceEnabled) {
    next();
    return;
  }
  var nonce = crypto.randomBytes(16).toString("base64");
  req.haxcmsCspNonce = nonce;
  var directives = {};
  var directiveKeys = Object.keys(cspBaseDirectives);
  for (var i = 0; i < directiveKeys.length; i++) {
    var key = directiveKeys[i];
    var baseValue = cspBaseDirectives[key];
    if (key === "scriptSrc") {
      directives[key] = baseValue.concat(["'nonce-" + nonce + "'"]);
    } else {
      directives[key] = baseValue.slice();
    }
  }
  res.setHeader("Content-Security-Policy", formatCspDirectives(directives));
  next();
}

// Security (M2): format a CSP directives object into the header string shape
// "directive-a v1 v2; directive-b v1; ...". Replaces helmet's
// contentSecurityPolicy.formatDirectives, which is not exposed in helmet 7.x.
// Directive keys are camelCase here; CSP header keys are kebab-case, so
// scriptSrc -> script-src, frameAncestors -> frame-ancestors, etc.
function formatCspDirectives(directives) {
  var parts = [];
  var keys = Object.keys(directives || {});
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var headerName = key.replace(/([A-Z])/g, function (_, ch) {
      return "-" + ch.toLowerCase();
    });
    var value = directives[key];
    if (!Array.isArray(value)) {
      value = value === undefined || value === null ? [] : [String(value)];
    }
    parts.push(headerName + " " + value.join(" "));
  }
  return parts.join("; ");
}

// flag in local development that disables security
// this way you launch from local and don't need a U/P relationship
if (
  process.env.HAXCMS_DISABLE_JWT_CHECKS ||
  argv._.includes("HAXCMS_DISABLE_JWT_CHECKS")
) {
  if (HAXCMS.isProductionRuntime()) {
    // never honor the local-development security bypass in production
    console.error(
      "SECURITY: HAXCMS_DISABLE_JWT_CHECKS is ignored because NODE_ENV=production.",
    );
  } else {
    HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = true;
    // disable security policies that would otherwise block local development
    // also enables webcontainer environments which is what our playground runs
    helmetPolicies.contentSecurityPolicy = false;
    // Security (M2): skip the per-request CSP nonce middleware in local dev /
    // webcontainer mode so the playground and CDN module loads (which omit
    // nonces) are not blocked. CSP is re-enabled for production automatically
    // because this branch only runs when not isProductionRuntime().
    cspNonceEnabled = false;
    helmetPolicies.crossOriginResourcePolicy = false;
    // COEP must be the object form ({ policy }) for helmet to honor the value;
    // a bare string silently falls back to the require-corp default. Use
    // 'credentialless' so we keep cross-origin isolation (SharedArrayBuffer /
    // the webcontainer playground) WITHOUT blocking cross-origin subresources
    // that omit CORP (e.g. CDN module/asset loads via the wc-registry magic
    // loader). 'require-corp' blocked those with
    // ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep.
    helmetPolicies.crossOriginEmbedderPolicy = { policy: "credentialless" };
    helmetPolicies.crossOriginOpenerPolicy = { policy: "same-origin" };
  }
}
// routes with all requires
const {
  allRoutes,
  SiteRoutesMap,
  SystemRoutesMap,
  SystemV1OpenRoutes,
  SystemV1AdminRoutes,
} = require("./lib/allRoutes.js");
// app settings
const multer = require("multer");
// Security (HAX-SEC-004): hard cap on upload size (1 GB per file, max 10
// files) prevents unbounded DoS uploads. The site's configured
// maxUploadSizeMb (if smaller) is additionally enforced at the app layer in
// HAXCMSFile.save(). Parity with PHP php.ini upload_max_filesize as a safety
// net; the reverse proxy should also cap client_max_body_size.
const MAX_UPLOAD_FILE_SIZE_BYTES = 1024 * 1024 * 1024;
const MAX_UPLOAD_FILE_COUNT = 10;
const UPLOAD_TEMP_DIRECTORY = path.join(HAXCMS.configDirectory, "tmp/");
const upload = multer({
  dest: UPLOAD_TEMP_DIRECTORY,
  limits: {
    fileSize: MAX_UPLOAD_FILE_SIZE_BYTES,
    files: MAX_UPLOAD_FILE_COUNT,
  },
});
// Security (SEC-UPLOAD): upload temp-file lifecycle helpers (per-request
// cleanup, stale temp sweeper, conversion cap, files/ force-download guard).
const uploadSecurity = require("./lib/uploadSecurity.js");
const uploadTempCleanup = uploadSecurity.createUploadTempCleanupMiddleware(
  UPLOAD_TEMP_DIRECTORY,
);
// Security (SEC-UPLOAD): conversion actions/* routes accept a single document,
// so they use a lower per-file cap (default 50 MB, config.json
// security.conversionMaxUploadMb or HAXCMS_CONVERSION_MAX_UPLOAD_MB). Built
// lazily so the value is read after config.json has been loaded.
let conversionUploadAnyParser = null;
function getConversionUploadAnyParser() {
  if (!conversionUploadAnyParser) {
    conversionUploadAnyParser = multer({
      dest: UPLOAD_TEMP_DIRECTORY,
      limits: {
        fileSize: uploadSecurity.getConversionUploadMaxBytes(HAXCMS.config),
        files: MAX_UPLOAD_FILE_COUNT,
      },
    }).any();
  }
  return conversionUploadAnyParser;
}
function isMultipartRequest(req) {
  const contentType =
    req && req.headers && typeof req.headers["content-type"] === "string"
      ? req.headers["content-type"].toLowerCase()
      : "";
  return contentType.indexOf("multipart/form-data") === 0;
}
const jsonRequestParser = express.json({
  type: ["application/json", "application/*+json"],
  limit: "10mb",
});
// Security (HAX-SEC-012): urlencoded parser is scoped to routes that need it
// (via formBodyParser below) rather than running globally on every request
// including static/GET. Lower limit/parameterLimit than the previous global
// 50mb/50000 to reduce the DoS surface.
const urlencodedParser = express.urlencoded({
  limit: "10mb",
  extended: false,
  parameterLimit: 1000,
});
// Combined body parser: runs json then urlencoded so both content types are
// handled for POST/PUT/PATCH/DELETE routes. Each parser only processes its
// matching content-type and calls next() for others, so stacking is safe.
function formBodyParser(req, res, next) {
  jsonRequestParser(req, res, (err) => {
    if (err) return next(err);
    urlencodedParser(req, res, next);
  });
}
const multerUploadAnyParser = upload.any();
// Security (SEC-UPLOAD): every multipart parse registers temp-file cleanup
// first, so files multer writes to <config>/tmp are unlinked when the
// response finishes or the connection closes, whatever the outcome.
function uploadAnyParser(req, res, next) {
  uploadTempCleanup(req, res, () => multerUploadAnyParser(req, res, next));
}
function conversionUploadParser(req, res, next) {
  uploadTempCleanup(req, res, () =>
    getConversionUploadAnyParser()(req, res, next),
  );
}
function parseSchemaFileOperationBody(req, res, next) {
  if (isMultipartRequest(req)) {
    return uploadAnyParser(req, res, next);
  }
  return formBodyParser(req, res, next);
}
function parseConversionActionBody(req, res, next) {
  if (isMultipartRequest(req)) {
    return conversionUploadParser(req, res, next);
  }
  return formBodyParser(req, res, next);
}
function getSiteApiRouteParser(method = "get", route = "") {
  const normalizedMethod = String(method || "get").toLowerCase();
  const normalizedRoute = String(route || "");
  if (normalizedMethod === "post" && normalizedRoute === "v1/files") {
    return uploadAnyParser;
  }
  if (
    normalizedMethod === "post" ||
    normalizedMethod === "put" ||
    normalizedMethod === "patch" ||
    normalizedMethod === "delete"
  ) {
    return formBodyParser;
  }
  return null;
}
function getSystemV1RouteParser(method = "get", route = "") {
  const normalizedMethod = String(method || "get").toLowerCase();
  const normalizedRoute = String(route || "");
  // Security (SEC-UPLOAD): single-document conversion/import actions get the
  // lower conversion upload cap.
  if (
    normalizedMethod === "post" &&
    (normalizedRoute === "actions/docx-to-html" ||
      normalizedRoute === "actions/html-to-docx" ||
      normalizedRoute === "actions/html-to-pdf" ||
      normalizedRoute === "actions/import-docx" ||
      normalizedRoute === "actions/import-pptx" ||
      normalizedRoute === "actions/import-html" ||
      normalizedRoute === "actions/import-xlsx" ||
      normalizedRoute === "actions/import-pdf" ||
      normalizedRoute === "actions/xlsx-to-csv" ||
      normalizedRoute === "actions/pdf-to-html" ||
      normalizedRoute === "actions/pptx-to-html" ||
      normalizedRoute === "actions/docx-to-pdf")
  ) {
    return parseConversionActionBody;
  }
  if (
    normalizedMethod === "post" &&
    (normalizedRoute === "configuration/schema-files/operations" ||
      normalizedRoute === "configuration/skeletons" ||
      normalizedRoute === "skeletons" ||
      normalizedRoute === "site/import/:platform")
  ) {
    return parseSchemaFileOperationBody;
  }
  if (
    normalizedMethod === "post" ||
    normalizedMethod === "put" ||
    normalizedMethod === "patch" ||
    normalizedMethod === "delete"
  ) {
    return formBodyParser;
  }
  return null;
}
let publicDir = path.join(__dirname, "/public");
const WEBCOMPONENTS_ROOT_ENV_VAR = "HAXCMS_WEBCOMPONENTS_ROOT";
const linkedWebcomponentsRoot = getLinkedWebcomponentsRoot();
const linkedWebcomponentsNodeModulesRoot = linkedWebcomponentsRoot
  ? path.join(linkedWebcomponentsRoot, "node_modules")
  : null;
const linkedDevImportMapMarkup = buildLinkedDevImportMapMarkup();
const SITE_API_OPENAPI_SPEC_PATH = path.join(
  __dirname,
  "openapi",
  "site-spec.yaml",
);
const SYSTEM_API_OPENAPI_SPEC_PATH = path.join(
  __dirname,
  "openapi",
  "system-spec.yaml",
);
let siteApiAuthPoliciesByMethodAndRoute = null;
let systemApiAuthPoliciesByMethodAndRoute = null;

function getLinkedWebcomponentsRoot() {
  if (process.env.NODE_ENV !== "development") {
    return null;
  }
  if (
    !process.env[WEBCOMPONENTS_ROOT_ENV_VAR] ||
    String(process.env[WEBCOMPONENTS_ROOT_ENV_VAR]).trim() === ""
  ) {
    return null;
  }
  const resolvedPath = path.resolve(
    String(process.env[WEBCOMPONENTS_ROOT_ENV_VAR]).trim(),
  );
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }
  if (!fs.lstatSync(resolvedPath).isDirectory()) {
    return null;
  }
  return resolvedPath;
}

function isPathInsideDirectory(parentPath = "", targetPath = "") {
  const relativePath = path.relative(parentPath, targetPath);
  if (relativePath === "") {
    return true;
  }
  return relativePath.indexOf("..") !== 0 && !path.isAbsolute(relativePath);
}

function isBuildAssetRequest(url = "") {
  const requestPath = String(url || "").split("?")[0];
  return (
    requestPath.indexOf("/build/") !== -1 ||
    requestPath.indexOf("wc-registry.json") !== -1 ||
    requestPath.indexOf("build.js") !== -1 ||
    requestPath.indexOf("build-haxcms.js") !== -1
  );
}

function resolveLinkedNodeModuleAssetPath(modulePath = "") {
  if (!linkedWebcomponentsNodeModulesRoot) {
    return null;
  }
  const normalizedModulePath = String(modulePath || "").replace(/^\/+/, "");
  if (normalizedModulePath === "") {
    return null;
  }
  const baseCandidatePath = path.join(
    linkedWebcomponentsNodeModulesRoot,
    normalizedModulePath,
  );
  const candidatePaths = [baseCandidatePath];
  if (path.extname(normalizedModulePath) === "") {
    candidatePaths.push(`${baseCandidatePath}.js`);
    candidatePaths.push(`${baseCandidatePath}.mjs`);
    candidatePaths.push(`${baseCandidatePath}.cjs`);
    candidatePaths.push(path.join(baseCandidatePath, "index.js"));
    candidatePaths.push(path.join(baseCandidatePath, "index.mjs"));
    candidatePaths.push(path.join(baseCandidatePath, "index.cjs"));
    const packageEntryPath = resolvePackageEntryPath(baseCandidatePath);
    if (packageEntryPath) {
      candidatePaths.push(path.join(baseCandidatePath, packageEntryPath));
    }
  }
  for (let i = 0; i < candidatePaths.length; i++) {
    const candidatePath = candidatePaths[i];
    if (
      !isPathInsideDirectory(linkedWebcomponentsNodeModulesRoot, candidatePath)
    ) {
      continue;
    }
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }
  return null;
}

function resolveLinkedDevAssetPath(cleanFilePath = "") {
  if (!linkedWebcomponentsRoot) {
    return null;
  }
  const normalizedPath = String(cleanFilePath || "").replace(/^\/+/, "");
  if (normalizedPath.indexOf("build/es6/node_modules/") === 0) {
    if (!linkedWebcomponentsNodeModulesRoot) {
      return null;
    }
    const modulePath = normalizedPath.replace("build/es6/node_modules/", "");
    const resolvedModulePath = resolveLinkedNodeModuleAssetPath(modulePath);
    if (resolvedModulePath) {
      return resolvedModulePath;
    }
    return null;
  }
  if (
    normalizedPath === "build.js" ||
    normalizedPath === "build-haxcms.js" ||
    normalizedPath === "wc-registry.json"
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

function serveBuildAssetFile(req, res, fallbackRoot = "") {
  const cleanFilePath = getBuildAssetRequestPath(req.url);
  const linkedAssetPath = resolveLinkedDevAssetPath(cleanFilePath);
  if (linkedAssetPath) {
    res.sendFile(linkedAssetPath);
    return;
  }
  res.sendFile(cleanFilePath, { root: fallbackRoot });
}

function safeReadJsonFile(filePath = "") {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isDirectoryPath(targetPath = "") {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return false;
  }
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveExportsEntryPath(exportsField = null) {
  if (!exportsField) {
    return null;
  }
  if (typeof exportsField === "string") {
    return exportsField;
  }
  if (typeof exportsField !== "object") {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(exportsField, ".")) {
    const rootEntry = resolveExportsEntryPath(exportsField["."]);
    if (rootEntry) {
      return rootEntry;
    }
  }
  const preferredConditions = [
    "import",
    "browser",
    "default",
    "module",
    "development",
    "production",
    "node",
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
    if (key.indexOf("./") === 0) {
      continue;
    }
    const entry = resolveExportsEntryPath(exportsField[key]);
    if (entry) {
      return entry;
    }
  }
  return null;
}

function normalizePackageEntryPath(entryPath = "") {
  let normalizedPath = String(entryPath || "").replace(/\\/g, "/");
  if (normalizedPath.indexOf("./") === 0) {
    normalizedPath = normalizedPath.substring(2);
  }
  if (normalizedPath.indexOf("/") === 0) {
    normalizedPath = normalizedPath.substring(1);
  }
  if (normalizedPath === "") {
    normalizedPath = "index.js";
  }
  if (normalizedPath.charAt(normalizedPath.length - 1) === "/") {
    normalizedPath += "index.js";
  }
  return normalizedPath;
}

function resolvePackageEntryPath(packageDirectory = "") {
  const packageJsonPath = path.join(packageDirectory, "package.json");
  const packageJson = safeReadJsonFile(packageJsonPath);
  let entryPath = null;
  if (packageJson) {
    entryPath = resolveExportsEntryPath(packageJson.exports);
    if (!entryPath && packageJson.module) {
      entryPath = packageJson.module;
    }
    if (!entryPath && packageJson["jsnext:main"]) {
      entryPath = packageJson["jsnext:main"];
    }
    if (!entryPath && typeof packageJson.browser === "string") {
      entryPath = packageJson.browser;
    }
    if (!entryPath && packageJson.main) {
      entryPath = packageJson.main;
    }
  }
  entryPath = normalizePackageEntryPath(entryPath || "index.js");
  let absoluteEntryPath = path.join(packageDirectory, entryPath);
  if (
    fs.existsSync(absoluteEntryPath) &&
    fs.statSync(absoluteEntryPath).isFile()
  ) {
    return entryPath;
  }
  if (path.extname(entryPath) === "") {
    const extensionFallbacks = [
      `${entryPath}.js`,
      `${entryPath}.mjs`,
      `${entryPath}.cjs`,
      path.join(entryPath, "index.js"),
      path.join(entryPath, "index.mjs"),
    ];
    for (let i = 0; i < extensionFallbacks.length; i++) {
      const candidate = extensionFallbacks[i];
      absoluteEntryPath = path.join(packageDirectory, candidate);
      if (
        fs.existsSync(absoluteEntryPath) &&
        fs.statSync(absoluteEntryPath).isFile()
      ) {
        return candidate.replace(/\\/g, "/");
      }
    }
  }
  return null;
}

function discoverNodeModulePackages(nodeModulesRoot = "") {
  const packages = [];
  if (!isDirectoryPath(nodeModulesRoot)) {
    return packages;
  }
  const topLevelEntries = fs.readdirSync(nodeModulesRoot);
  for (let i = 0; i < topLevelEntries.length; i++) {
    const entryName = topLevelEntries[i];
    if (!entryName || entryName.charAt(0) === ".") {
      continue;
    }
    const entryPath = path.join(nodeModulesRoot, entryName);
    if (!isDirectoryPath(entryPath)) {
      continue;
    }
    if (entryName.charAt(0) === "@") {
      const scopedEntries = fs.readdirSync(entryPath);
      for (let j = 0; j < scopedEntries.length; j++) {
        const scopedName = scopedEntries[j];
        if (!scopedName || scopedName.charAt(0) === ".") {
          continue;
        }
        const scopedPath = path.join(entryPath, scopedName);
        if (!isDirectoryPath(scopedPath)) {
          continue;
        }
        packages.push({
          packageName: `${entryName}/${scopedName}`,
          packageDirectory: scopedPath,
        });
      }
    } else {
      packages.push({
        packageName: entryName,
        packageDirectory: entryPath,
      });
    }
  }
  return packages;
}

function buildLinkedDevImportMapMarkup() {
  if (!linkedWebcomponentsNodeModulesRoot) {
    return "";
  }
  const imports = {};
  const packages = discoverNodeModulePackages(
    linkedWebcomponentsNodeModulesRoot,
  );
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
    return "";
  }
  const dedupingFixPath = path.join(
    linkedWebcomponentsNodeModulesRoot,
    "@haxtheweb",
    "deduping-fix",
    "deduping-fix.js",
  );
  if (!fs.existsSync(dedupingFixPath)) {
    return "";
  }
  return '<script src="./build/es6/node_modules/@haxtheweb/deduping-fix/deduping-fix.js" data-haxcms-linked-dev-deduping-fix></script>';
}

function injectLinkedDevDedupingFix(indexFile = "") {
  let output = String(indexFile || "");
  if (output.indexOf("build-haxcms.js") !== -1) {
    return output;
  }
  const dedupingFixMarkup = getLinkedDevDedupingFixMarkup();
  if (!dedupingFixMarkup) {
    return output;
  }
  if (output.indexOf("data-haxcms-linked-dev-deduping-fix") !== -1) {
    return output;
  }
  const earlyInjectionMarkers = [
    '<script type="importmap"',
    'rel="modulepreload"',
    "rel='modulepreload'",
    'type="module"',
    "type='module'",
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
    const tagStart = output.lastIndexOf("<", markerIndex);
    if (tagStart !== -1) {
      return `${output.substring(0, tagStart)}${dedupingFixMarkup}\n${output.substring(tagStart)}`;
    }
  }
  if (output.indexOf("</head>") !== -1) {
    return output.replace("</head>", `${dedupingFixMarkup}\n</head>`);
  }
  return `${dedupingFixMarkup}\n${output}`;
}

function extractImportMapJson(markup = "") {
  const startIndex = markup.indexOf(">");
  const endIndex = markup.lastIndexOf("</script>");
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }
  try {
    return JSON.parse(markup.substring(startIndex + 1, endIndex).trim());
  } catch {
    return null;
  }
}

function mergeImportMapMarkup(existingMarkup = "", linkedDevMarkup = "") {
  const existingJson = extractImportMapJson(existingMarkup);
  const linkedDevJson = extractImportMapJson(linkedDevMarkup);
  if (!existingJson || !linkedDevJson) {
    return null;
  }
  const merged = {
    imports: {
      ...(existingJson.imports || {}),
      ...(linkedDevJson.imports || {}),
    },
    scopes: {
      ...(existingJson.scopes || {}),
      ...(linkedDevJson.scopes || {}),
    },
  };
  return `<script type="importmap" data-haxcms-linked-dev-importmap>${JSON.stringify(merged)}</script>`;
}

// Security (M1, 2026-10-19 audit): the ONE pattern used both to stamp the
// per-request nonce (injectNonce) and to pre-mark untrusted page-content
// scripts (neutralizeUntrustedScriptNonces). Sharing it guarantees every tag
// injectNonce could stamp was already marked when it came from page content.
var INLINE_SCRIPT_OPEN_TAG_PATTERN = /<script((?:\s[^>]*)?)>/gi;

// Security (M1, 2026-10-19 audit): page HTML is read from disk and spliced
// into the served index BEFORE injectNonce runs. Without this, any literal
// <script> in a page file (legacy content, git/filesystem-synced sites,
// another backend's writes) would receive the real nonce and execute, so the
// nonce CSP would give no stored-XSS protection. Mark every script open tag
// in untrusted content with an empty nonce: it can never match the real
// nonce, and injectNonce skips tags that already carry a nonce attribute.
function neutralizeUntrustedScriptNonces(html = "") {
  return String(html || "").replace(
    INLINE_SCRIPT_OPEN_TAG_PATTERN,
    function (match, attrs) {
      var attrsStr = String(attrs || "");
      if (/\snonce\s*=/i.test(attrsStr)) {
        return match;
      }
      return "<script" + attrsStr + ' nonce="">';
    },
  );
}

// Security (EXPRESS-HEADERS-001 / M2): stamp every inline <script> (and
// inline <script type="importmap">) in the served index.html with nonce="<n>"
// so the per-request CSP (cspNonceMiddleware) allows them to execute while
// 'unsafe-inline' is dropped from script-src. Only inline scripts need a
// nonce; external <script src> tags are covered by 'self'. A no-op when the
// nonce is empty (e.g. CSP disabled in local dev) or a tag already has a
// nonce attribute. Run this LAST, after all inline-script injectors, so it
// catches every inline script including the injected ones.
//
// Also injects <meta name="csp-nonce" content="<n>"> into <head> so same-
// origin frontend JS can read the per-request nonce and stamp it onto
// inline scripts it creates dynamically at runtime (e.g. the speculation-
// rules <script type="speculationrules"> injected by haxcms-site-store).
// The meta tag is used instead of reading an existing script's nonce
// attribute because browsers hide the nonce content attribute from
// getAttribute/CSS selectors for security; a <meta> tag is not subject to
// that hiding and is reliably readable by same-origin script.
function injectNonce(indexFile = "", nonce = "") {
  var cleanNonce = String(nonce || "").trim();
  if (cleanNonce === "") {
    return String(indexFile || "");
  }
  var output = String(indexFile || "");
  // Stamp nonce="<n>" on inline <script> tags (including importmap). External
  // scripts (with src) are covered by script-src 'self' and skipped. Tags that
  // already have a nonce are left alone (this includes page-content scripts
  // pre-marked by neutralizeUntrustedScriptNonces).
  output = output.replace(
    INLINE_SCRIPT_OPEN_TAG_PATTERN,
    function (match, attrs) {
      var attrsStr = String(attrs || "");
      if (/\snonce\s*=/i.test(attrsStr)) {
        return match;
      }
      if (/\ssrc\s*=/i.test(attrsStr)) {
        return match;
      }
      return "<script" + attrsStr + ' nonce="' + cleanNonce + '">';
    },
  );
  // Expose the nonce to frontend JS via a <meta> tag so dynamically-created
  // inline scripts (e.g. speculation rules) can pick it up. Idempotent: if the
  // meta is already present, don't add a second one.
  var nonceMetaTag = '<meta name="csp-nonce" content="' + cleanNonce + '">';
  // Security (M1): only look for an existing meta in the document head so
  // page content in the body cannot suppress (or pre-empt) the real one.
  var headEndIndex = output.search(/<\/head>/i);
  var headRegion =
    headEndIndex === -1 ? output : output.substring(0, headEndIndex);
  if (headRegion.indexOf('name="csp-nonce"') === -1) {
    if (output.indexOf("<head") !== -1) {
      // inject immediately after the <head ...> opening tag
      output = output.replace(/<head([^>]*)>/i, function (m, attrs) {
        return "<head" + attrs + ">" + nonceMetaTag;
      });
    } else {
      // no <head> — prepend
      output = nonceMetaTag + output;
    }
  }
  return output;
}

// Security (M2): read an index.html from disk, stamp its inline scripts
// with the per-request CSP nonce, and send it. Used for the static index
// fallback paths (single-site catch, multisite dashboard non-dev, multisite
// site catch) so their inline <script> blocks are authorized under the nonce
// CSP now that 'unsafe-inline' is dropped from script-src. Falls back to a
// plain res.sendFile if the file cannot be read (preserving prior behavior).
function sendNonceIndex(res, req, absoluteFilePath) {
  try {
    var indexFile = fs.readFileSync(absoluteFilePath, "utf8");
    indexFile = injectNonce(indexFile, req && req.haxcmsCspNonce);
    setNoStoreResponseHeaders(res);
    res.send(indexFile);
  } catch {
    setNoStoreResponseHeaders(res);
    res.sendFile(path.basename(absoluteFilePath), {
      root: path.dirname(absoluteFilePath),
    });
  }
}

function injectLinkedDevImportMap(indexFile = "") {
  let output = String(indexFile || "");
  if (!linkedDevImportMapMarkup) {
    return output;
  }
  if (output.indexOf("data-haxcms-linked-dev-importmap") !== -1) {
    return output;
  }
  const firstImportMapScriptIndex = output.indexOf('<script type="importmap"');
  if (firstImportMapScriptIndex !== -1) {
    const firstImportMapScriptEndIndex = output.indexOf(
      "</script>",
      firstImportMapScriptIndex,
    );
    if (firstImportMapScriptEndIndex !== -1) {
      const existingImportMap = output.substring(
        firstImportMapScriptIndex,
        firstImportMapScriptEndIndex + "</script>".length,
      );
      const mergedMarkup = mergeImportMapMarkup(
        existingImportMap,
        linkedDevImportMapMarkup,
      );
      if (mergedMarkup) {
        return (
          output.substring(0, firstImportMapScriptIndex) +
          mergedMarkup +
          output.substring(firstImportMapScriptEndIndex + "</script>".length)
        );
      }
      // fallback: prepend linked dev import map before the existing one
      return (
        output.substring(0, firstImportMapScriptIndex) +
        linkedDevImportMapMarkup +
        "\n" +
        output.substring(firstImportMapScriptIndex)
      );
    }
  }
  const earlyInjectionMarkers = [
    'rel="modulepreload"',
    "rel='modulepreload'",
    'type="module"',
    "type='module'",
  ];
  for (let i = 0; i < earlyInjectionMarkers.length; i++) {
    const marker = earlyInjectionMarkers[i];
    const markerIndex = output.indexOf(marker);
    if (markerIndex !== -1) {
      const tagStart = output.lastIndexOf("<", markerIndex);
      if (tagStart !== -1) {
        return `${output.substring(0, tagStart)}${linkedDevImportMapMarkup}\n${output.substring(tagStart)}`;
      }
    }
  }
  if (output.indexOf("</head>") !== -1) {
    return output.replace("</head>", `${linkedDevImportMapMarkup}\n</head>`);
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
  const customSrcPath = path.join(process.cwd(), "custom/src");
  const linkedElementsPath = linkedWebcomponentsRoot
    ? path.join(linkedWebcomponentsRoot, "elements")
    : null;

  const wsServer = new ws.Server({ server: server });
  const connectedClients = new Set();

  function sendReloadToConnectedClients() {
    connectedClients.forEach((client) => {
      if (client.readyState === ws.OPEN) {
        client.send("theme reload");
      }
    });
  }

  async function handleWatchedFileChange(filePath = "") {
    if (isPathInsideDirectory(customSrcPath, filePath)) {
      try {
        await exec("cd custom && npm run build");
      } catch {
        // intentionally ignored
      }
    }
    sendReloadToConnectedClients();
  }

  wsServer.on("connection", (socket) => {
    connectedClients.add(socket);
    socket.on("close", () => {
      connectedClients.delete(socket);
    });
  });

  const watchTargets = [customSrcPath];
  if (linkedElementsPath && fs.existsSync(linkedElementsPath)) {
    watchTargets.push(linkedElementsPath);
  }
  const watcher = chokidar.watch(watchTargets, { ignoreInitial: true });
  watcher.on("change", handleWatchedFileChange);
  watcher.on("add", handleWatchedFileChange);
  watcher.on("unlink", handleWatchedFileChange);
}
// Security (HAX-SEC-012): express.urlencoded was previously applied globally
// (including to static/GET requests). It is now scoped to POST/PUT/PATCH/
// DELETE routes via formBodyParser in the per-route parser selectors above.
// Security (ReDoS, CodeQL #23/#39): oversized request URLs are rejected with
// 414 before any static/asset/route handling (cap documented in
// src/lib/requestUrlGuards.js).
app.use(requestUrlGuard);
// Security (SEC-DEPLOY / DNS rebinding): the no-login bypass binds loopback,
// but a hostile web page can still reach it via DNS rebinding. Reject any
// request whose Host header is not a loopback name in that mode. Runs first so
// nothing else (static files, API routes) is reachable with a foreign Host.
app.use((req, res, next) => {
  if (
    shouldEnforceLoopbackHostHeader(
      listenHost,
      HAXCMS.HAXCMS_DISABLE_JWT_CHECKS,
    ) &&
    !isLoopbackHostHeader(req.headers.host)
  ) {
    res.status(403).send("Forbidden: invalid Host header");
    return;
  }
  next();
});
app.use(helmet(helmetPolicies));
// Security (M2): per-request CSP nonce middleware. Runs after helmet so the
// nonce header is set on every response (alongside helmet's other headers).
// When cspNonceEnabled is false (local-dev/webcontainer bypass) it is a no-op.
app.use(cspNonceMiddleware);
// Security (CodeQL js/missing-rate-limiting): generous per-IP ceiling over every
// route below (static files, site assets, catch-alls) so filesystem-backed
// handlers cannot be hammered. Tunable / disableable via
// config.security.requestRateLimit; keyed on req.ip (honors `trust proxy`).
const requestRateLimiter = createRequestRateLimiter(
  HAXCMS.getRequestRateLimitSettings(),
);
app.use(requestRateLimiter);
app.use(cookieParser());
app.use(compression());
// translatable API messages: add a `code` next to response messages (issues#3157)
app.use(apiMessageCodesMiddleware);
app.use((req, res, next) => {
  if (isSystemAdminApiRequest(req) || shouldDisableResponseCache(req)) {
    setNoStoreResponseHeaders(res);
  }
  next();
});

// Security: Force download of HTML files in sites' files directories to prevent XSS
// Security (SEC-UPLOAD): decided on the DECODED path (the raw req.url let
// /files/x%2ehtml through, since send decodes it before reading the disk) and
// extended to every active-content type in the PHP parity contract:
// html, htm, xhtml, xml, svg (uploadSecurity.FORCE_DOWNLOAD_FILES_EXTENSIONS).
// X-Content-Type-Options: nosniff is set on every response by helmet.
app.use((req, res, next) => {
  if (uploadSecurity.shouldForceDownloadFilesRequest(req.url)) {
    res.setHeader("Content-Disposition", "attachment");
  }
  next();
});

// Security: never web-serve HAXcms secret/config files. In single-site mode the
// served root can be a site directory that also contains the _config dir, so a
// raw static request could otherwise reach keys/credentials. Resolve the request
// to its path segments and 404 anything targeting the config dir or a sensitive
// file (mirrors the .htaccess protections used by the PHP backend).
const SENSITIVE_STATIC_BASENAMES = [
  ".pk",
  ".rpk",
  "salt.txt",
  ".user",
  "config.php",
  "config.json",
  ".htaccess",
  ".ishaxcmsconfig",
  // Security (HAX-SEC / PHP [C1] parity): explicit defense-in-depth for
  // sensitive config files. These are also covered by the _config segment
  // rule below, but listing them explicitly protects against any future path
  // where they might be served from outside _config.
  "userdata.json",
  "apikeys.json",
  // Security (SEC-DEPLOY): one-time seeded admin password file
  ".initial-admin-password",
];
function isSensitiveStaticPath(url = "") {
  let decodedPath = String(url || "").split("?")[0];
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    // fall back to the raw path if it cannot be decoded
  }
  const segments = decodedPath.replace(/\\/g, "/").toLowerCase().split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "") {
      continue;
    }
    // the HAXcms config directory itself must never be web-served
    if (segment === "_config") {
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
app.options("*", function (req, res, _next) {
  res.sendStatus(200);
});
if (linkedWebcomponentsRoot) {
  app.use((req, res, next) => {
    if (!req.url.includes("/custom/build/") && isBuildAssetRequest(req.url)) {
      setStaticContentTypeWithCharset(res, req.url.split("?")[0], null);
      serveBuildAssetFile(req, res, path.join(__dirname, "/public"));
      return;
    }
    next();
  });
}
// Serve wc-registry-graph.json (server-side build artifact emitted by the
// ubiquity gulp task). Intercept before the site routes so it works in both
// single-site and multisite mode. When the artifact is absent (older CDN
// builds / ubiquity not yet run), return an empty JSON stub instead of a 404
// so the frontend editor-warmup no-ops cleanly without console noise.
app.use((req, res, next) => {
  if (req.url.indexOf("wc-registry-graph.json") === -1) {
    return next();
  }
  const candidates = [];
  if (linkedWebcomponentsRoot) {
    candidates.push(
      path.join(linkedWebcomponentsRoot, "wc-registry-graph.json"),
    );
  }
  candidates.push(path.join(__dirname, "public", "wc-registry-graph.json"));
  for (let i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i]) && fs.lstatSync(candidates[i]).isFile()) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.sendFile(candidates[i]);
      return;
    }
  }
  // graceful degradation: empty graph so the frontend warmup finds no editor
  // tags and no-ops without a 404 in the console
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.json({ paths: [], adj: {}, tags: {} });
});
// attempt to establish context of site vs multi-site environment
const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;
let currentPort = Number.parseInt(process.env.PORT, 10);
if (Number.isNaN(currentPort)) {
  currentPort = DEFAULT_PORT;
}
let resolveServerReady;
const serverReady = new Promise((resolve) => {
  resolveServerReady = resolve;
});
let serverReadyResolved = false;
// Captured from systemStructureContext().then((site) => so the top-level
// onServerListening() can include site name/theme in the banner.
let activeSite = null;
// Best-effort one-time version read (sync) for the server banner.
let HAXCMS_VERSION = null;
try {
  const _versionPaths = [
    path.join(__dirname, "/../.version"),
    path.join(__dirname, "/../public", "VERSION.txt"),
  ];
  for (let _i = 0; _i < _versionPaths.length; _i++) {
    if (fs.existsSync(_versionPaths[_i])) {
      HAXCMS_VERSION = fs.readFileSync(_versionPaths[_i], "utf8").trim();
      break;
    }
  }
} catch {
  // intentionally ignored
}
function getRuntimePort() {
  const address = server.address();
  if (
    address &&
    typeof address === "object" &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return currentPort;
}
systemStructureContext().then((site) => {
  // see if we have a single site context or if we need routes for multisite
  if (site) {
    // we have a site context, need paths to resolve to cwd instead of subsite path
    // in this configuration there is no overworld / 8-bit game to make new sites
    // this assumes a site has already been made or is being navigated to to work on
    // works great w/ CLI in stand alone mode for local developer
    publicDir = site.siteDirectory;
    HAXCMS.runtimeServerMode = "single-site";
    activeSite = site;
    if (process.env.NODE_ENV === "development") {
      // express.static will only serve the original static index.html file
      // so dev builds need to set this ignore option to inject any edits
      app.use(
        express.static(publicDir, {
          index: false,
          setHeaders: setManagedStaticHeaders,
        }),
      );
    } else {
      app.use(
        express.static(publicDir, { setHeaders: setManagedStaticHeaders }),
      );
    }
    if (process.env.NODE_ENV === "development") {
      app.get(
        "/.well-known/appspecific/com.chrome.devtools.json",
        requestRateLimiter,
        (req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.json({
            workspace: {
              root: publicDir,
              uuid: "a1b2c3d4-e5f6-47a7-8c9d-0e1f2a3b4c5d",
            },
          });
        },
      );
    }
    app.use("/", requestRateLimiter, async (req, res, next) => {
      res.setHeader(
        "Access-Control-Allow-Origin",
        HAXCMS.getCorsAllowedOrigin(
          `${serverProtocol}://localhost:${currentPort}`,
        ),
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS, PUT, PATCH, DELETE",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "X-Requested-With, Content-Type, Accept",
      );
      res.setHeader("Content-Type", "application/json");
      if (req.url.includes("/system/api/") || isSiteApiRequestPath(req.url)) {
        next();
      }
      // previous will catch as json, undo that
      else if (
        !req.url.includes("/custom/build/") &&
        (req.url.includes("/build/") ||
          req.url.includes("wc-registry.json") ||
          req.url.includes("build.js") ||
          req.url.includes("build-haxcms.js"))
      ) {
        setStaticContentTypeWithCharset(res, req.url.split("?")[0], null);
        serveBuildAssetFile(req, res, path.join(__dirname, "/public"));
      } else if (
        !req.url.includes("/x/") &&
        (req.url.includes("custom/build") ||
          req.url.includes("/theme/") ||
          req.url.includes("/assets/") ||
          req.url.includes("/manifest.json") ||
          req.url.includes("/robots.txt") ||
          req.url.includes("/llms.txt") ||
          req.url.includes("/rss.xml") ||
          req.url.includes("/atom.xml") ||
          req.url.includes("/sitemap.xml") ||
          req.url.includes("/sitemap-index.xml") ||
          req.url.includes("/.well-known/") ||
          req.url.includes("/files/") ||
          req.url.includes("/pages/") ||
          req.url.includes("/site.json") ||
          req.url.includes("/lunrSearchIndex.json") ||
          req.url.includes("/service-worker.js") ||
          req.url.includes("/offline.html") ||
          req.url.includes("/browserconfig.xml") ||
          req.url.includes("/push-manifest.json"))
      ) {
        if (!setWellKnownContentType(res, req.url)) {
          setStaticContentTypeWithCharset(res, req.url.split("?")[0]);
        }
        res.sendFile(
          decodeStaticRequestPath(req.url.split("?")[0]),
          getStaticSendFileOptions(publicDir, req.url),
        );
      } else {
        const requestPath = getRequestPathWithoutQuery(req.url);
        let variantResponse = {
          served: false,
          item: null,
          canonicalPath: null,
          notFound: false,
        };
        if (requestPath.indexOf("/x/") !== 0) {
          variantResponse = await tryServePageVariantRequest(
            req,
            res,
            site,
            requestPath,
            "",
          );
          if (variantResponse.served) {
            return;
          }
          if (variantResponse.item && variantResponse.canonicalPath) {
            setPageAlternateHeaders(
              res,
              site,
              variantResponse.item,
              variantResponse.canonicalPath,
            );
          }
        }
        const pageMiss = variantResponse.notFound === true;
        if (pageMiss) {
          res.status(404);
        }
        // all page calls just go to the index and the front end will render them
        setStaticContentTypeWithCharset(res, req.url.split("?")[0]);
        try {
          let indexFile = await renderDynamicSiteIndexResponse(
            req,
            site,
            variantResponse.item,
            variantResponse.canonicalPath,
            pageMiss,
            path.join(publicDir, "index.html"),
          );
          // injects a websocket for livereload support when developing custom components
          indexFile = injectLinkedDevDedupingFix(indexFile);
          indexFile = injectLinkedDevImportMap(indexFile);
          indexFile = injectDevReloadScript(indexFile, currentPort);
          // Security (M2): stamp inline scripts with the per-request CSP nonce
          // (last so it covers all injected inline scripts too).
          indexFile = injectNonce(indexFile, req.haxcmsCspNonce);
          setNoStoreResponseHeaders(res);
          res.send(indexFile);
        } catch (e) {
          console.warn(
            "Runtime injection failed for single-site index, falling back to static delivery:",
            e,
          );
          // Security (M2): stamp the static fallback with the nonce too so its
          // inline scripts still execute under the nonce CSP.
          sendNonceIndex(res, req, path.join(publicDir, "index.html"));
        }
      }
    });
  } else {
    HAXCMS.runtimeServerMode = "multisite";
    if (process.env.NODE_ENV === "development") {
      app.use(
        express.static(publicDir, {
          index: false,
          setHeaders: setManagedStaticHeaders,
        }),
      );
    } else {
      // Security (M2): index:false so the dashboard index.html is served by
      // the app.use('/') handler below (which stamps inline scripts with the
      // per-request CSP nonce) rather than by express.static streaming the
      // raw file (which would bypass the nonce and break under the nonce CSP).
      // Non-index assets are still served by express.static.
      app.use(
        express.static(publicDir, {
          index: false,
          setHeaders: setManagedStaticHeaders,
        }),
      );
    }
    // Deployment-root agent skills discovery (agentskills.io v0.2.0).
    // Serves the system-tier skill set from the project root .well-known/agent-skills/
    // so an agent discovering the HAXcms deployment itself can interface with the CMS.
    // Per-site agent-skills are served by the site .well-known route below; this is
    // only the deployment root. CORS open so browser-based agents can fetch it.
    app.use(
      "/.well-known/agent-skills",
      requestRateLimiter,
      (req, res, next) => {
        const asRoot = path.join(process.cwd(), ".well-known", "agent-skills");
        const reqPath = getRequestPathWithoutQuery(req.url).replace(/^\/+/, "");
        // Security: contain the joined path before any filesystem access
        const targetFile = reqPath
          ? resolveContainedPath(asRoot, reqPath)
          : false;
        if (
          !reqPath ||
          targetFile === false ||
          !fs.existsSync(targetFile) ||
          fs.statSync(targetFile).isDirectory()
        ) {
          next();
          return;
        }
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Vary", "Origin");
        setStaticContentTypeWithCharset(
          res,
          reqPath,
          "text/plain; charset=utf-8",
        );
        res.sendFile(reqPath, { root: asRoot });
      },
    );
    app.use("/", requestRateLimiter, (req, res, next) => {
      res.setHeader(
        "Access-Control-Allow-Origin",
        HAXCMS.getCorsAllowedOrigin(
          `${serverProtocol}://localhost:${currentPort}`,
        ),
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS, PUT, PATCH, DELETE",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "X-Requested-With, Content-Type, Accept",
      );
      res.setHeader("Content-Type", "application/json");
      // advertise the deployment-root agent skills index to header-parsing agents
      res.setHeader(
        "Link",
        '</.well-known/agent-skills/index.json>; rel="https://agentskills.io/rels/skills-index"; type="application/json"',
      );
      // dynamic step routes in HAXcms site list UI
      const requestPath = getRequestPathWithoutQuery(req.url);
      const isDashboardIndexRequest =
        requestPath === "/" ||
        requestPath === "/home" ||
        requestPath === "/index.html" ||
        requestPath.indexOf("/createSite-step-") === 0;
      if (!isDashboardIndexRequest) {
        next();
      } else {
        setStaticContentTypeWithCharset(res, requestPath);
        if (process.env.NODE_ENV === "development") {
          try {
            let indexFile = fs.readFileSync(
              path.join(publicDir, "index.html"),
              "utf8",
            );
            indexFile = injectLinkedDevDedupingFix(indexFile);
            indexFile = injectLinkedDevImportMap(indexFile);
            indexFile = injectDevReloadScript(indexFile, currentPort);
            // Security (M2): stamp inline scripts with the per-request CSP nonce
            // (last so it covers all injected inline scripts too).
            indexFile = injectNonce(indexFile, req.haxcmsCspNonce);
            setNoStoreResponseHeaders(res);
            res.send(indexFile);
            return;
          } catch (e) {
            console.warn(
              "Runtime injection failed for dashboard index, falling back to static delivery:",
              e,
            );
          }
        }
        // Security (M2): non-dev dashboard index. Read+nonce+send so inline
        // scripts are authorized under the nonce CSP (no 'unsafe-inline').
        sendNonceIndex(res, req, path.join(publicDir, "index.html"));
      }
    });
    if (process.env.NODE_ENV === "development") {
      app.get(
        `/${HAXCMS.sitesDirectory}/:site/.well-known/appspecific/com.chrome.devtools.json`,
        requestRateLimiter,
        async (req, res) => {
          const siteContext = await HAXCMS.loadSite(req.params.site);
          if (siteContext && siteContext.siteDirectory) {
            res.setHeader("Content-Type", "application/json");
            res.json({
              workspace: {
                root: siteContext.siteDirectory,
                uuid: "a1b2c3d4-e5f6-47a7-8c9d-0e1f2a3b4c5d",
              },
            });
          } else {
            res.status(404).end();
          }
        },
      );
    }
    // sites need rewriting to work with PWA routes without failing file location
    // similar to htaccess
    app.use(
      `/${HAXCMS.sitesDirectory}/`,
      requestRateLimiter,
      async (req, res, next) => {
        const multisiteRequestPath = getRequestPathWithoutQuery(req.url);
        if (multisiteRequestPath === "/" || multisiteRequestPath === "") {
          const queryIndex = req.url.indexOf("?");
          const querySuffix =
            queryIndex !== -1 ? req.url.substring(queryIndex) : "";
          res.redirect(302, `/${querySuffix}`);
          return;
        }
        if (/^\/[^/]+$/.test(multisiteRequestPath)) {
          const queryIndex = req.url.indexOf("?");
          const querySuffix =
            queryIndex !== -1 ? req.url.substring(queryIndex) : "";
          res.redirect(
            301,
            `${req.baseUrl}${multisiteRequestPath}/${querySuffix}`,
          );
          return;
        }
        if (req.url.includes("/system/api/") || isSiteApiRequestPath(req.url)) {
          next();
        }
        // previous will catch as json, undo that
        else if (
          !req.url.includes("/custom/build/") &&
          (req.url.includes("/build/") ||
            req.url.includes("wc-registry.json") ||
            req.url.includes("build.js") ||
            req.url.includes("build-haxcms.js"))
        ) {
          setStaticContentTypeWithCharset(res, req.url.split("?")[0], null);
          serveBuildAssetFile(req, res, publicDir);
        } else if (
          !req.url.includes("/x/") &&
          (req.url.includes("custom/build") ||
            req.url.includes("/theme/") ||
            req.url.includes("/assets/") ||
            req.url.includes("/manifest.json") ||
            req.url.includes("/robots.txt") ||
            req.url.includes("/llms.txt") ||
            req.url.includes("/rss.xml") ||
            req.url.includes("/atom.xml") ||
            req.url.includes("/sitemap.xml") ||
            req.url.includes("/sitemap-index.xml") ||
            req.url.includes("/.well-known/") ||
            req.url.includes("/files/") ||
            req.url.includes("/pages/") ||
            req.url.includes("/site.json") ||
            req.url.includes("/lunrSearchIndex.json") ||
            req.url.includes("/service-worker.js") ||
            req.url.includes("/offline.html") ||
            req.url.includes("/browserconfig.xml") ||
            req.url.includes("/push-manifest.json"))
        ) {
          if (!setWellKnownContentType(res, req.url)) {
            setStaticContentTypeWithCharset(res, req.url.split("?")[0]);
          }
          res.sendFile(
            decodeStaticRequestPath(req.url.split("?")[0]),
            getStaticSendFileOptions(
              process.cwd() + `/${HAXCMS.sitesDirectory}`,
              req.url,
            ),
          );
        } else {
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
            if (siteContext && siteSubPath.indexOf("/x/") !== 0) {
              variantResponse = await tryServePageVariantRequest(
                req,
                res,
                siteContext,
                siteSubPath,
                `/${HAXCMS.sitesDirectory}/${siteName}`,
              );
              if (variantResponse.served) {
                return;
              }
              if (variantResponse.item && variantResponse.canonicalPath) {
                setPageAlternateHeaders(
                  res,
                  siteContext,
                  variantResponse.item,
                  variantResponse.canonicalPath,
                );
              }
            }
          }
          const pageMiss = variantResponse.notFound === true;
          if (pageMiss) {
            res.status(404);
          }
          setStaticContentTypeWithCharset(res, req.url.split("?")[0]);
          if (siteContext && siteContext.siteDirectory) {
            try {
              let indexFile = await renderDynamicSiteIndexResponse(
                req,
                siteContext,
                variantResponse.item,
                variantResponse.canonicalPath,
                pageMiss,
                path.join(siteContext.siteDirectory, "index.html"),
              );
              indexFile = injectLinkedDevDedupingFix(indexFile);
              indexFile = injectLinkedDevImportMap(indexFile);
              indexFile = injectDevReloadScript(indexFile, currentPort);
              // Security (M2): stamp inline scripts with the per-request CSP nonce
              // (last so it covers all injected inline scripts too).
              indexFile = injectNonce(indexFile, req.haxcmsCspNonce);
              setNoStoreResponseHeaders(res);
              res.send(indexFile);
              return;
            } catch (e) {
              console.warn(
                "Runtime injection failed for site index, falling back to static delivery:",
                e,
              );
            }
          }
          // Security (M2): static index fallback — read+nonce+send so inline
          // scripts are authorized under the nonce CSP (no 'unsafe-inline').
          // Mirrors the prior res.sendFile path resolution.
          // Security: derive the site segment via cleanTitle and confine the
          // resulting index.html to the sites directory.
          const fallbackIndexPath = HAXCMS.resolveSiteIndexPath(
            path.join(process.cwd(), HAXCMS.sitesDirectory),
            siteName,
          );
          if (fallbackIndexPath === false) {
            setNoStoreResponseHeaders(res);
            res.status(404).send("Not found");
            return;
          }
          sendNonceIndex(res, req, fallbackIndexPath);
        }
      },
    );
    // published directory route if it exists
    app.use(
      `/${HAXCMS.publishedDirectory}/`,
      requestRateLimiter,
      (req, res, _next) => {
        setStaticContentTypeWithCharset(res, req.url);
        res.sendFile(decodeStaticRequestPath(req.url.split("?")[0]), {
          root: process.cwd() + `/${HAXCMS.publishedDirectory}`,
        });
      },
    );
  }
  const siteRouteRegistry =
    allRoutes &&
    allRoutes.site &&
    allRoutes.site.map &&
    typeof allRoutes.site.map === "object"
      ? allRoutes.site.map
      : SiteRoutesMap;
  const systemRouteRegistry =
    allRoutes &&
    allRoutes.system &&
    allRoutes.system.map &&
    typeof allRoutes.system.map === "object"
      ? allRoutes.system.map
      : SystemRoutesMap;
  const systemV1OpenRouteRegistry =
    allRoutes && allRoutes.system && Array.isArray(allRoutes.system.openRoutes)
      ? allRoutes.system.openRoutes
      : SystemV1OpenRoutes;
  // loop through scoped system API routes and register under /system/api/v1
  const systemApiV1BasePath = `${HAXCMS.basePath}${HAXCMS.systemRequestBase}v1/`;
  for (let systemMethod in systemRouteRegistry) {
    for (let systemRoute in systemRouteRegistry[systemMethod]) {
      const systemRoutePath = `${systemApiV1BasePath}${systemRoute}`;
      const systemRouteParser = getSystemV1RouteParser(
        systemMethod,
        systemRoute,
      );
      const systemRouteHandler = async (req, res, next) => {
        const op = req.route.path.replace(systemApiV1BasePath, "");
        const rMethod = req.method.toLowerCase();
        // Security (SEC-UPLOAD): auth decision shared with the multipart
        // pre-auth middleware (evaluateSystemV1RouteAuthentication); reuse its
        // result when it already ran for this request so basic credentials
        // are only checked once.
        const auth =
          getSystemV1PreAuthResult(req, op) ||
          evaluateSystemV1RouteAuthentication(
            req,
            res,
            op,
            systemV1OpenRouteRegistry,
          );
        if (auth.authenticated) {
          const basicAuth = auth.basicAuth;
          if (
            !enforceSystemApiUserTokenPolicy(req, res, op, rMethod, basicAuth)
          ) {
            return;
          }
          // F2/Q14+F3: enforce site-token policy for 'authenticated-site'
          // system routes (e.g. provider-search) so the router returns a
          // consistent 403 envelope instead of the handler doing the check.
          if (
            !(await enforceSystemApiSiteTokenPolicy(
              req,
              res,
              op,
              rMethod,
              basicAuth,
            ))
          ) {
            return;
          }
          return systemRouteRegistry[rMethod][op](req, res, next);
        }
        return sendSystemV1AuthFailure(res, auth);
      };
      const siteScopedSystemRouteHandler = async (req, res, next) => {
        const op = req.route.path.replace(
          `/${HAXCMS.sitesDirectory}/*${systemApiV1BasePath}`,
          "",
        );
        const rMethod = req.method.toLowerCase();
        // Security (SEC-UPLOAD): auth decision shared with the multipart
        // pre-auth middleware (evaluateSystemV1RouteAuthentication); reuse its
        // result when it already ran for this request so basic credentials
        // are only checked once.
        const auth =
          getSystemV1PreAuthResult(req, op) ||
          evaluateSystemV1RouteAuthentication(
            req,
            res,
            op,
            systemV1OpenRouteRegistry,
          );
        if (auth.authenticated) {
          const basicAuth = auth.basicAuth;
          if (
            !enforceSystemApiUserTokenPolicy(req, res, op, rMethod, basicAuth)
          ) {
            return;
          }
          // F2/Q14+F3: enforce site-token policy for 'authenticated-site'
          // system routes (e.g. provider-search) so the router returns a
          // consistent 403 envelope instead of the handler doing the check.
          if (
            !(await enforceSystemApiSiteTokenPolicy(
              req,
              res,
              op,
              rMethod,
              basicAuth,
            ))
          ) {
            return;
          }
          return systemRouteRegistry[rMethod][op](req, res, next);
        }
        return sendSystemV1AuthFailure(res, auth);
      };
      if (
        systemRouteParser &&
        isMultipartCapableSystemRouteParser(systemRouteParser)
      ) {
        // Security (SEC-UPLOAD): multipart routes authenticate BEFORE multer
        // writes anything to <config>/tmp; failures short-circuit with the
        // exact status/envelope the handler would have returned.
        const systemUploadPreAuth = createSystemV1UploadPreAuthMiddleware(
          systemRoute,
          systemV1OpenRouteRegistry,
        );
        app[systemMethod](
          systemRoutePath,
          systemUploadPreAuth,
          systemRouteParser,
          systemRouteHandler,
        );
        app[systemMethod](
          `/${HAXCMS.sitesDirectory}/*${systemRoutePath}`,
          systemUploadPreAuth,
          systemRouteParser,
          siteScopedSystemRouteHandler,
        );
      } else if (systemRouteParser) {
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
      } else {
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
      const routeSuffix = siteRoute === "" ? "" : "/" + siteRoute;
      const siteRoutePath = `${siteApiBasePath}${routeSuffix}`;
      const siteRouteParser = getSiteApiRouteParser(siteMethod, siteRoute);
      const siteRouteHandler = async (req, res, next) => {
        try {
          const access = await validateSiteApiRouteAccess(
            req,
            siteRoute,
            siteMethod,
          );
          if (!access.allowed) {
            if (access.retryAfterSeconds && access.retryAfterSeconds > 0) {
              res.set("Retry-After", String(access.retryAfterSeconds));
            }
            return res.status(access.status).json({
              status: access.status,
              data: { message: access.message },
            });
          }
          siteRouteRegistry[siteMethod][siteRoute](req, res, next);
        } catch {
          return res.status(500).json({
            status: 500,
            data: { message: "Unable to evaluate site API access policy" },
          });
        }
      };
      if (siteRouteParser && siteRouteParser === uploadAnyParser) {
        // Security (SEC-UPLOAD): authenticate before multer writes the upload
        // to <config>/tmp (see createSiteApiUploadPreAuthMiddleware).
        const siteUploadPreAuth = createSiteApiUploadPreAuthMiddleware(
          siteRoute,
          siteMethod,
        );
        app[siteMethod](
          siteRoutePath,
          siteUploadPreAuth,
          siteRouteParser,
          siteRouteHandler,
        );
        app[siteMethod](
          `/${HAXCMS.sitesDirectory}/*${siteRoutePath}`,
          siteUploadPreAuth,
          siteRouteParser,
          siteRouteHandler,
        );
      } else if (siteRouteParser) {
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
  // D60: 405+Allow dispatch for system and site API routes. After all routes
  // are registered, add a catch-all that checks if the request path matches a
  // registered route for a different method and returns 405 + Allow header.
  // Mirrors PHP SystemApiRouter/SiteApiRouter 405+Allow dispatch. If no
  // method matches, the request falls through to the existing catch-all / 404.
  app.use((req, res, next) => {
    const requestPath = getRequestPathWithoutQuery(req.originalUrl || req.url);
    const upperReqMethod = String(req.method || "GET").toUpperCase();
    // Check system API paths
    if (requestPath.indexOf("/system/api/") !== -1) {
      const systemSuffix = extractSystemApiRouteSuffixFromPath(requestPath);
      if (systemSuffix !== null) {
        const allowedMethods = findAllowedMethodsForRouteSuffix(
          systemSuffix,
          systemRouteRegistry,
        );
        if (
          allowedMethods.length > 0 &&
          allowedMethods.indexOf(upperReqMethod) === -1
        ) {
          return sendMethodNotAllowedResponse(
            res,
            systemSuffix,
            allowedMethods,
          );
        }
      }
    }
    // Check site API paths
    if (isSiteApiRequestPath(requestPath)) {
      const siteSuffix = extractSiteApiRouteSuffixFromPath(requestPath);
      if (siteSuffix !== null) {
        const allowedMethods = findAllowedMethodsForRouteSuffix(
          siteSuffix,
          siteRouteRegistry,
        );
        if (
          allowedMethods.length > 0 &&
          allowedMethods.indexOf(upperReqMethod) === -1
        ) {
          return sendMethodNotAllowedResponse(res, siteSuffix, allowedMethods);
        }
      }
    }
    next();
  });
  // can't do this for a site context
  if (!site) {
    // catch anything called on homepage that doens't match and ensure it still goes through so that it 404s correctly
    app.get("*", requestRateLimiter, function (req, res, next) {
      if (
        req.url !== "/" &&
        !req.url.startsWith("/build") &&
        !req.url.startsWith("/site.json") &&
        !req.url.startsWith("/system") &&
        !req.url.startsWith("/_sites") &&
        !req.url.startsWith("/assets") &&
        !req.url.startsWith("/wc-registry.json") &&
        !req.url.startsWith("/favicon.ico") &&
        !req.url.startsWith("/manifest.json") &&
        !req.url.startsWith("/robots.txt") &&
        !req.url.startsWith("/llms.txt")
      ) {
        if (process.env.NODE_ENV === "development") {
          try {
            let indexFile = fs.readFileSync(
              path.join(__dirname, "public", "index.html"),
              "utf8",
            );
            indexFile = injectLinkedDevDedupingFix(indexFile);
            indexFile = injectLinkedDevImportMap(indexFile);
            indexFile = injectDevReloadScript(indexFile, currentPort);
            // Security (M2): stamp inline scripts with the per-request CSP nonce
            // (last so it covers all injected inline scripts too).
            indexFile = injectNonce(indexFile, req.haxcmsCspNonce);
            setNoStoreResponseHeaders(res);
            res.send(indexFile);
            return;
          } catch (e) {
            console.warn(
              "Runtime injection failed for catch-all index, falling back to static delivery:",
              e,
            );
          }
        }
        // Security (M2): non-dev catch-all fallback — read+nonce+send so inline
        // scripts are authorized under the nonce CSP (no 'unsafe-inline').
        sendNonceIndex(res, req, path.join(__dirname, "public", "index.html"));
      } else {
        next();
      }
    });
  }
  // Security (PR8-4): ENOENT -> 404, multer limits -> 413 (HAX-SEC-004), and
  // body-parser failures -> 400/413/415 JSON without logging err.body.
  app.use(haxcmsErrorHandler);
});
// Security (SEC-DEPLOY): resolved once at first listen so port-retry attempts
// keep binding the same interface.
var listenHost = null;
var listenHostResolved = false;
server.on("listening", onServerListening);
server.on("error", handleServerError);
// Security (SEC-UPLOAD): sweep stale multer temp files (>1h) and abandoned
// tmp/imports staging entries (>24h) at startup and every 15 minutes. The
// timer is unref'd and stopped when the server closes.
const stopUploadTempSweeper = uploadSecurity.startUploadTempSweeper(
  UPLOAD_TEMP_DIRECTORY,
);
server.on("close", stopUploadTempSweeper);
startServer(currentPort);

function startServer(portToTry) {
  currentPort = Number(portToTry);
  if (!listenHostResolved) {
    listenHostResolved = true;
    const jwtChecksDisabled = !!HAXCMS.HAXCMS_DISABLE_JWT_CHECKS;
    listenHost = selectListenHost({ env: process.env, jwtChecksDisabled });
    const exposureWarning = getBypassExposureWarning(
      listenHost,
      jwtChecksDisabled,
    );
    if (exposureWarning) {
      console.warn(exposureWarning);
    }
  }
  if (listenHost) {
    server.listen(currentPort, listenHost);
  } else {
    server.listen(currentPort);
  }
}
function onServerListening() {
  const runtimePort = getRuntimePort();
  currentPort = runtimePort;
  process.env.PORT = `${runtimePort}`;
  if (!serverReadyResolved) {
    resolveServerReady(runtimePort);
    serverReadyResolved = true;
  }
  let _siteName = null;
  let _themeName = null;
  if (
    activeSite &&
    activeSite.manifest &&
    activeSite.manifest.metadata &&
    activeSite.manifest.metadata.site &&
    activeSite.manifest.metadata.site.name
  ) {
    _siteName = activeSite.manifest.metadata.site.name;
  }
  if (
    activeSite &&
    activeSite.manifest &&
    activeSite.manifest.metadata &&
    activeSite.manifest.metadata.theme &&
    activeSite.manifest.metadata.theme.element
  ) {
    _themeName = activeSite.manifest.metadata.theme.element;
  }
  cliTheme.printServerBanner({
    url: `${serverProtocol}://${getBrowserHost(listenHost)}:${runtimePort}`,
    mode: HAXCMS.runtimeServerMode || "",
    siteName: _siteName,
    theme: _themeName,
    version: HAXCMS_VERSION,
  });
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
  serverReady,
  serverProtocol,
  getListenHost: () => listenHost,
};
function isSiteScopedSystemApiRoutePattern(req) {
  if (!req || !req.route || typeof req.route.path !== "string") {
    return false;
  }
  return req.route.path.indexOf(`/${HAXCMS.sitesDirectory}/`) === 0;
}
function isDashboardRefererRequest(req) {
  if (!req || !req.headers || typeof req.headers.referer !== "string") {
    return false;
  }
  return req.headers.referer.indexOf(`/${HAXCMS.sitesDirectory}/`) === -1;
}
function setNoStoreResponseHeaders(res) {
  if (!res || typeof res.setHeader !== "function") {
    return;
  }
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}
function normalizePathForCacheMatching(value = "") {
  let normalized = String(value || "");
  if (normalized === "") {
    return "/";
  }
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.charAt(0) !== "/") {
    normalized = "/" + normalized;
  }
  if (
    normalized.length > 1 &&
    normalized.charAt(normalized.length - 1) === "/"
  ) {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}
function hasQueryParameter(req, key) {
  if (!req || !req.query || typeof req.query !== "object") {
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
    "/" + String(HAXCMS.systemRequestBase || "").replace(/^\/+/, ""),
  );
  if (systemRequestBasePath === "/") {
    return false;
  }
  if (requestPath === systemRequestBasePath) {
    return true;
  }
  return requestPath.indexOf(systemRequestBasePath + "/") !== -1;
}
function shouldDisableResponseCache(req) {
  if (!req) {
    return false;
  }
  return hasQueryParameter(req, "cb") || hasQueryParameter(req, "t");
}

function validateSystemV1RouteAccess(req, op = "") {
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
// Security (SEC-UPLOAD): the system API authentication decision, extracted
// from the route handlers so the multipart pre-auth middleware makes exactly
// the same decision (and returns exactly the same status/envelope) before
// multer runs. Order and messages are unchanged from the inline handler code.
function evaluateSystemV1RouteAuthentication(
  req,
  res,
  op = "",
  openRoutes = [],
) {
  if (!validateSystemV1RouteAccess(req, op)) {
    return {
      authenticated: false,
      status: 403,
      message: "system admin route requires system dashboard access",
    };
  }
  let isAuthenticated = openRoutes.includes(op) || HAXCMS.validateJWT(req, res);
  let basicAuth = null;
  if (!isAuthenticated) {
    basicAuth = authenticateBasicAuthorizationRequest(req);
    if (basicAuth.blocked) {
      return {
        authenticated: false,
        status: 429,
        message: "Too many failed login attempts. Please try again later.",
        retryAfterSeconds: basicAuth.retryAfterSeconds || 0,
      };
    }
    isAuthenticated = basicAuth.authenticated;
  }
  if (isAuthenticated) {
    return {
      authenticated: true,
      basicAuth: basicAuth,
    };
  }
  // D1b status-code parity (matches site API + PHP SystemApiSecurity):
  // 401 for no creds or failed basic (fresh credential rejection);
  // 403 for a present-but-invalid bearer (refreshable). Envelope D1.
  // Message strings mirror PHP SystemApiSecurity so outputs are identical.
  if (getBearerJwtFromRequest(req) !== "") {
    return {
      authenticated: false,
      status: 403,
      message: "Invalid bearer token",
    };
  }
  return {
    authenticated: false,
    status: 401,
    message: "Authentication required",
  };
}
function sendSystemV1AuthFailure(res, auth) {
  if (auth.status === 429) {
    res.set("Retry-After", String(auth.retryAfterSeconds || 0));
  }
  return res.status(auth.status).json({
    status: auth.status,
    data: { message: auth.message },
  });
}
function getSystemV1PreAuthResult(req, op = "") {
  if (
    req &&
    req.haxcmsSystemV1PreAuth &&
    req.haxcmsSystemV1PreAuth.op === op &&
    req.haxcmsSystemV1PreAuth.result &&
    req.haxcmsSystemV1PreAuth.result.authenticated === true
  ) {
    return req.haxcmsSystemV1PreAuth.result;
  }
  return null;
}
function isMultipartCapableSystemRouteParser(parser) {
  return (
    parser === parseConversionActionBody ||
    parser === parseSchemaFileOperationBody
  );
}
// Security (SEC-UPLOAD): runs before the multipart parser on system routes
// that accept uploads. Unauthenticated multipart requests are rejected here so
// multer never writes their file parts to disk. Non-multipart requests pass
// through untouched (the handler performs the check as before).
function createSystemV1UploadPreAuthMiddleware(op = "", openRoutes = []) {
  return function systemV1UploadPreAuth(req, res, next) {
    if (!isMultipartRequest(req)) {
      next();
      return;
    }
    const auth = evaluateSystemV1RouteAuthentication(req, res, op, openRoutes);
    if (!auth.authenticated) {
      sendSystemV1AuthFailure(res, auth);
      return;
    }
    req.haxcmsSystemV1PreAuth = { op: op, result: auth };
    next();
  };
}
// Site API denials that are decided before the site name is resolved and so
// cannot change once the multipart body (which may carry a siteName field) is
// parsed. Any other denial is only final when the site name comes from the
// request path.
const SITE_API_UPLOAD_PRE_AUTH_FINAL_403_MESSAGES = [
  "Invalid bearer token",
  "Unable to resolve authenticated user context",
  "X-HAXCMS-Site-Token header is required for this endpoint",
  "X-HAXCMS-User-Token header is required for this endpoint",
  "Invalid X-HAXCMS-User-Token header",
];
function isSiteApiUploadPreAuthDenialFinal(req, access) {
  if (!access || access.allowed) {
    return false;
  }
  if (access.status === 401 || access.status === 429) {
    return true;
  }
  if (
    access.status === 403 &&
    SITE_API_UPLOAD_PRE_AUTH_FINAL_403_MESSAGES.indexOf(access.message) !== -1
  ) {
    return true;
  }
  return (
    getSiteNameFromSiteApiRequestPath(
      req && req.originalUrl ? req.originalUrl : req && req.url ? req.url : "",
    ) !== ""
  );
}
// Security (SEC-UPLOAD): site API pre-auth for multipart upload routes
// (POST v1/files). Uses validateSiteApiRouteAccess and short-circuits with the
// same envelope as siteRouteHandler when the denial cannot depend on the
// not-yet-parsed multipart body; otherwise defers to the handler (whose temp
// file is still removed by the upload cleanup middleware).
function createSiteApiUploadPreAuthMiddleware(route = "", method = "post") {
  return async function siteApiUploadPreAuth(req, res, next) {
    if (!isMultipartRequest(req)) {
      next();
      return;
    }
    let access = null;
    try {
      access = await validateSiteApiRouteAccess(req, route, method);
    } catch {
      // let the route handler produce its own 500 envelope
      next();
      return;
    }
    if (!isSiteApiUploadPreAuthDenialFinal(req, access)) {
      next();
      return;
    }
    if (access.retryAfterSeconds && access.retryAfterSeconds > 0) {
      res.set("Retry-After", String(access.retryAfterSeconds));
    }
    res.status(access.status).json({
      status: access.status,
      data: { message: access.message },
    });
  };
}
function convertOpenApiPathToSiteRoute(openApiPath = "") {
  let route = String(openApiPath || "");
  if (route.indexOf("/x/api") !== 0) {
    return "";
  }
  route = route.replace(/^\/x\/api\/?/, "");
  route = route.replace(/^\//, "");
  route = route.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");
  return route;
}
function normalizeSiteApiSecurityPolicy(securityConfig = null) {
  if (!Array.isArray(securityConfig)) {
    return "public";
  }
  if (securityConfig.length === 0) {
    return "public";
  }
  let requiresBearer = false;
  let requiresUserToken = false;
  for (let i = 0; i < securityConfig.length; i++) {
    const requirement = securityConfig[i];
    if (!requirement || typeof requirement !== "object") {
      continue;
    }
    const keys = Object.keys(requirement);
    if (keys.length === 0) {
      return "public";
    }
    if (Object.prototype.hasOwnProperty.call(requirement, "siteTokenHeader")) {
      // siteTokenHeader paired with bearerAuth (in the same requirement) is
      // 'authenticated-site' (bearer JWT + site token, e.g. provider-search,
      // site API mutations). siteTokenHeader alone is 'site-token-only' —
      // the site token is validated against the server-side active user by
      // the handler (e.g. generateAppStore), no bearer JWT required. This
      // mirrors the original handler-validated behavior and avoids requiring
      // a bearer JWT the front-end appStore fetch does not send.
      if (Object.prototype.hasOwnProperty.call(requirement, "bearerAuth")) {
        return "authenticated-site";
      }
      return "site-token-only";
    }
    if (Object.prototype.hasOwnProperty.call(requirement, "userTokenHeader")) {
      requiresUserToken = true;
    }
    if (Object.prototype.hasOwnProperty.call(requirement, "bearerAuth")) {
      requiresBearer = true;
    }
  }
  if (requiresUserToken) {
    return "authenticated-user";
  }
  if (requiresBearer) {
    return "authenticated";
  }
  return "public";
}
function readSiteApiAuthPoliciesFromOpenApiSpec() {
  const policies = {};
  if (!fs.existsSync(SITE_API_OPENAPI_SPEC_PATH)) {
    return policies;
  }
  try {
    const openApiSpec = YAML.parse(
      fs.readFileSync(SITE_API_OPENAPI_SPEC_PATH, "utf8"),
    );
    if (
      !openApiSpec ||
      typeof openApiSpec !== "object" ||
      !openApiSpec.paths ||
      typeof openApiSpec.paths !== "object"
    ) {
      return policies;
    }
    const methods = [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "options",
      "head",
    ];
    const pathKeys = Object.keys(openApiSpec.paths);
    for (let p = 0; p < pathKeys.length; p++) {
      const openApiPath = pathKeys[p];
      if (String(openApiPath).indexOf("/x/api") !== 0) {
        continue;
      }
      const routeKey = convertOpenApiPathToSiteRoute(openApiPath);
      const pathConfig = openApiSpec.paths[openApiPath];
      if (!pathConfig || typeof pathConfig !== "object") {
        continue;
      }
      const pathLevelPolicy = normalizeSiteApiSecurityPolicy(
        pathConfig.security,
      );
      for (let m = 0; m < methods.length; m++) {
        const method = methods[m];
        if (!Object.prototype.hasOwnProperty.call(pathConfig, method)) {
          continue;
        }
        const operation = pathConfig[method];
        if (!operation || typeof operation !== "object") {
          continue;
        }
        let policy = pathLevelPolicy;
        if (Object.prototype.hasOwnProperty.call(operation, "security")) {
          policy = normalizeSiteApiSecurityPolicy(operation.security);
        }
        policies[`${method}:${routeKey}`] = policy;
      }
    }
  } catch (e) {
    console.warn("Unable to parse site OpenAPI auth policy map", e);
  }
  return policies;
}
function getSiteApiRouteAuthPolicy(route = "", method = "get") {
  if (!siteApiAuthPoliciesByMethodAndRoute) {
    siteApiAuthPoliciesByMethodAndRoute =
      readSiteApiAuthPoliciesFromOpenApiSpec();
  }
  const lookupKey = `${String(method || "get").toLowerCase()}:${String(route || "")}`;
  if (
    siteApiAuthPoliciesByMethodAndRoute &&
    Object.prototype.hasOwnProperty.call(
      siteApiAuthPoliciesByMethodAndRoute,
      lookupKey,
    )
  ) {
    return siteApiAuthPoliciesByMethodAndRoute[lookupKey];
  }
  // Fail closed: any site API route not explicitly declared in the OpenAPI
  // spec requires authentication rather than falling open to public access.
  return "authenticated";
}
function convertOpenApiPathToSystemRoute(openApiPath = "") {
  let route = String(openApiPath || "");
  if (route.indexOf("/system/api/v1") !== 0) {
    return "";
  }
  route = route.replace(/^\/system\/api\/v1\/?/, "");
  route = route.replace(/^\//, "");
  route = route.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");
  return route;
}
function readSystemApiAuthPoliciesFromOpenApiSpec() {
  const policies = {};
  if (!fs.existsSync(SYSTEM_API_OPENAPI_SPEC_PATH)) {
    return policies;
  }
  try {
    const openApiSpec = YAML.parse(
      fs.readFileSync(SYSTEM_API_OPENAPI_SPEC_PATH, "utf8"),
    );
    if (
      !openApiSpec ||
      typeof openApiSpec !== "object" ||
      !openApiSpec.paths ||
      typeof openApiSpec.paths !== "object"
    ) {
      return policies;
    }
    const methods = [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "options",
      "head",
    ];
    const pathKeys = Object.keys(openApiSpec.paths);
    for (let p = 0; p < pathKeys.length; p++) {
      const openApiPath = pathKeys[p];
      if (String(openApiPath).indexOf("/system/api/v1") !== 0) {
        continue;
      }
      const routeKey = convertOpenApiPathToSystemRoute(openApiPath);
      const pathConfig = openApiSpec.paths[openApiPath];
      if (!pathConfig || typeof pathConfig !== "object") {
        continue;
      }
      const pathLevelPolicy = normalizeSiteApiSecurityPolicy(
        pathConfig.security,
      );
      for (let m = 0; m < methods.length; m++) {
        const method = methods[m];
        if (!Object.prototype.hasOwnProperty.call(pathConfig, method)) {
          continue;
        }
        const operation = pathConfig[method];
        if (!operation || typeof operation !== "object") {
          continue;
        }
        let policy = pathLevelPolicy;
        if (Object.prototype.hasOwnProperty.call(operation, "security")) {
          policy = normalizeSiteApiSecurityPolicy(operation.security);
        }
        policies[`${method}:${routeKey}`] = policy;
      }
    }
  } catch (e) {
    console.warn("Unable to parse system OpenAPI auth policy map", e);
  }
  return policies;
}
function getSystemApiRouteAuthPolicy(route = "", method = "get") {
  if (!systemApiAuthPoliciesByMethodAndRoute) {
    systemApiAuthPoliciesByMethodAndRoute =
      readSystemApiAuthPoliciesFromOpenApiSpec();
  }
  const lookupKey = `${String(method || "get").toLowerCase()}:${String(route || "")}`;
  if (
    systemApiAuthPoliciesByMethodAndRoute &&
    Object.prototype.hasOwnProperty.call(
      systemApiAuthPoliciesByMethodAndRoute,
      lookupKey,
    )
  ) {
    return systemApiAuthPoliciesByMethodAndRoute[lookupKey];
  }
  // Fail closed: any system API route not explicitly declared in the OpenAPI
  // spec requires authentication rather than falling open to public access.
  return "authenticated";
}
function resolveSystemApiAuthenticatedUserName(req, basicAuth) {
  if (basicAuth && basicAuth.authenticated && basicAuth.userName) {
    return String(basicAuth.userName);
  }
  return getAuthenticatedUserNameFromBearerJwt(getBearerJwtFromRequest(req));
}
function enforceSystemApiUserTokenPolicy(req, res, op, method, basicAuth) {
  const policy = getSystemApiRouteAuthPolicy(op, method);
  if (policy !== "authenticated-user") {
    return true;
  }
  const userToken = getRequestHeaderValue(req, "x-haxcms-user-token");
  if (userToken === "") {
    res.status(403).json({
      status: 403,
      data: {
        message: "X-HAXCMS-User-Token header is required for this endpoint",
      },
    });
    return false;
  }
  const userName = resolveSystemApiAuthenticatedUserName(req, basicAuth);
  if (!HAXCMS.validateRequestToken(userToken, userName)) {
    res.status(403).json({
      status: 403,
      data: { message: "Invalid X-HAXCMS-User-Token header" },
    });
    return false;
  }
  return true;
}
// F2/Q14+F3: site-token enforcement for 'authenticated-site' system routes
// (e.g. provider-search). Mirrors the site API's 'authenticated-site' policy
// but runs in the system route handler so the 403 envelope is consistent
// with the rest of the system API. The handler may still do semantic
// siteName validation (e.g. generateAppStore) — this function only gates on
// token presence + validity against the resolved siteName + userName.
async function enforceSystemApiSiteTokenPolicy(
  req,
  res,
  op,
  method,
  basicAuth,
) {
  const policy = getSystemApiRouteAuthPolicy(op, method);
  if (policy !== "authenticated-site") {
    return true;
  }
  const siteToken = getRequestHeaderValue(req, "x-haxcms-site-token");
  if (siteToken === "") {
    res.status(403).json({
      status: 403,
      data: {
        message: "X-HAXCMS-Site-Token header is required for this endpoint",
      },
    });
    return false;
  }
  const userName = resolveSystemApiAuthenticatedUserName(req, basicAuth);
  if (userName === "") {
    res.status(403).json({
      status: 403,
      data: { message: "Unable to resolve authenticated user context" },
    });
    return false;
  }
  const siteName = await resolveSiteApiRequestSiteName(req, {
    userName: userName,
    siteToken: siteToken,
  });
  if (!siteName) {
    res.status(403).json({
      status: 403,
      data: { message: "Unable to resolve site token context" },
    });
    return false;
  }
  if (!HAXCMS.validateRequestToken(siteToken, `${userName}:${siteName}`)) {
    res.status(403).json({
      status: 403,
      data: { message: "Invalid X-HAXCMS-Site-Token header" },
    });
    return false;
  }
  return true;
}
function assertSiteApiMutationRoutesAreSecured(routeRegistry = null) {
  const registry =
    routeRegistry && typeof routeRegistry === "object" ? routeRegistry : {};
  const offendingRoutes = [];
  const registryMethods = Object.keys(registry);
  for (let m = 0; m < registryMethods.length; m++) {
    const method = String(registryMethods[m] || "").toLowerCase();
    if (method === "get" || method === "head" || method === "options") {
      continue;
    }
    const routeMap =
      registry[registryMethods[m]] &&
      typeof registry[registryMethods[m]] === "object"
        ? registry[registryMethods[m]]
        : {};
    const routeKeys = Object.keys(routeMap);
    for (let r = 0; r < routeKeys.length; r++) {
      const route = routeKeys[r];
      if (getSiteApiRouteAuthPolicy(route, method) === "public") {
        offendingRoutes.push(`${method.toUpperCase()} ${route}`);
      }
    }
  }
  if (offendingRoutes.length > 0) {
    console.error(
      `SECURITY: site API mutation routes resolve to a public auth policy and must declare security in site-spec.yaml: ${offendingRoutes.join(", ")}`,
    );
  }
  return offendingRoutes;
}
function getRequestHeaderValue(req, headerName = "") {
  if (!req || !req.headers || typeof req.headers !== "object") {
    return "";
  }
  const normalizedHeaderName = String(headerName || "")
    .toLowerCase()
    .trim();
  if (normalizedHeaderName === "") {
    return "";
  }
  const value = req.headers[normalizedHeaderName];
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[0] || "").trim() : "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}
function getBearerJwtFromRequest(req) {
  const authorizationHeader = getRequestHeaderValue(req, "authorization");
  if (authorizationHeader === "") {
    return "";
  }
  if (authorizationHeader.toLowerCase().indexOf("bearer ") !== 0) {
    return "";
  }
  return authorizationHeader.substring(7).trim();
}
function decodeBasicAuthCredentials(authorizationHeader = "") {
  const cleanHeader = String(authorizationHeader || "").trim();
  if (cleanHeader.toLowerCase().indexOf("basic ") !== 0) {
    return null;
  }
  const encodedCredentials = cleanHeader.substring(6).trim();
  if (encodedCredentials === "") {
    return null;
  }
  let decodedCredentials = "";
  try {
    decodedCredentials = Buffer.from(encodedCredentials, "base64").toString(
      "utf8",
    );
  } catch {
    return null;
  }
  const separatorIndex = decodedCredentials.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }
  return {
    userName: decodedCredentials.substring(0, separatorIndex),
    password: decodedCredentials.substring(separatorIndex + 1),
  };
}
function authenticateBasicAuthorizationRequest(req) {
  const authorizationHeader = getRequestHeaderValue(req, "authorization");
  const basicAuthCredentials = decodeBasicAuthCredentials(authorizationHeader);
  if (!basicAuthCredentials) {
    return {
      attempted: false,
      authenticated: false,
      userName: "",
    };
  }
  const userName = String(basicAuthCredentials.userName || "").trim();
  const password = String(basicAuthCredentials.password || "");
  if (userName === "" || password === "") {
    return {
      attempted: true,
      authenticated: false,
      userName: "",
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
    const retryAfterSeconds = Math.ceil(
      (attemptEntry.blockedUntil - now) / 1000,
    );
    return {
      attempted: true,
      authenticated: false,
      userName: "",
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
    loginRateLimiter.registerFailedAttempt(
      attemptEntry,
      now,
      rateLimitSettings,
    );
  }
  return {
    attempted: true,
    authenticated: false,
    userName: "",
  };
}
function getDecodedBearerJwtPayload(jwt = "") {
  const token = String(jwt || "").trim();
  if (token === "") {
    return null;
  }
  const decoded = HAXCMS.decodeJWT(token);
  if (!decoded || typeof decoded !== "object") {
    return null;
  }
  return decoded;
}
function getAuthenticatedUserNameFromBearerJwt(jwt = "") {
  const decoded = getDecodedBearerJwtPayload(jwt);
  if (!decoded || !decoded.user) {
    return "";
  }
  return String(decoded.user);
}
function setSiteApiAuthContext(req, authContext = {}) {
  if (!req || typeof req !== "object") {
    return;
  }
  req.haxcmsSiteApiAuth = {
    policy:
      authContext && authContext.policy ? String(authContext.policy) : "public",
    authenticated: authContext && authContext.authenticated === true,
    userName:
      authContext && authContext.userName ? String(authContext.userName) : "",
    siteName:
      authContext && authContext.siteName ? String(authContext.siteName) : "",
    securityLevel:
      authContext && authContext.securityLevel
        ? String(authContext.securityLevel)
        : "public",
  };
}
function normalizeSiteNameCandidate(siteName = "") {
  const cleanSiteName = String(siteName || "").trim();
  if (cleanSiteName === "") {
    return "";
  }
  try {
    return decodeURIComponent(cleanSiteName);
  } catch {
    return cleanSiteName;
  }
}
function getSiteNameFromSiteApiRequestPath(url = "") {
  const parts = String(getRequestPathWithoutQuery(url) || "")
    .split("/")
    .filter((part) => part !== "");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === HAXCMS.sitesDirectory && parts[i + 1]) {
      return normalizeSiteNameCandidate(parts[i + 1]);
    }
  }
  return "";
}
function getSiteNameFromSiteApiRequestPayload(req) {
  if (!req || typeof req !== "object") {
    return "";
  }
  const sources = [];
  if (req.params && typeof req.params === "object") {
    sources.push(req.params);
  }
  if (req.query && typeof req.query === "object") {
    sources.push(req.query);
  }
  if (req.body && typeof req.body === "object") {
    sources.push(req.body);
  }
  const candidateKeys = ["siteName", "site", "sitename", "site_name"];
  for (let s = 0; s < sources.length; s++) {
    const source = sources[s];
    for (let k = 0; k < candidateKeys.length; k++) {
      const key = candidateKeys[k];
      if (
        Object.prototype.hasOwnProperty.call(source, key) &&
        String(source[key] || "").trim() !== ""
      ) {
        return normalizeSiteNameCandidate(source[key]);
      }
    }
  }
  return "";
}
function getSiteNameFromSiteApiRequestReferer(req) {
  const referer = getRequestHeaderValue(req, "referer");
  if (referer === "") {
    return "";
  }
  try {
    const parsed = new URL(referer);
    const refererPathSiteName = getSiteNameFromSiteApiRequestPath(
      parsed.pathname,
    );
    if (refererPathSiteName !== "") {
      return refererPathSiteName;
    }
  } catch {
    // intentionally ignored
  }
  return getSiteNameFromSiteApiRequestPath(referer);
}
async function resolveSiteApiRequestSiteName(req, _authContext = {}) {
  const pathBasedSiteName = getSiteNameFromSiteApiRequestPath(
    req && req.originalUrl ? req.originalUrl : req && req.url ? req.url : "",
  );
  if (pathBasedSiteName !== "") {
    return pathBasedSiteName;
  }
  const payloadSiteName = getSiteNameFromSiteApiRequestPayload(req);
  if (payloadSiteName !== "") {
    return payloadSiteName;
  }
  const refererSiteName = getSiteNameFromSiteApiRequestReferer(req);
  if (refererSiteName !== "") {
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
  } catch {
    // intentionally ignored
  }
  return "";
}
function normalizeIamAuthorizationResult(iamAuthorization = null) {
  if (typeof iamAuthorization === "boolean") {
    if (iamAuthorization) {
      return {
        allowed: true,
        status: 200,
        message: "",
      };
    }
    return {
      allowed: false,
      status: 403,
      message: "Access denied",
    };
  }
  if (!iamAuthorization || typeof iamAuthorization !== "object") {
    return {
      allowed: true,
      status: 200,
      message: "",
    };
  }
  if (iamAuthorization.allowed === false) {
    return {
      allowed: false,
      status: iamAuthorization.status || 403,
      message: iamAuthorization.message || "Access denied",
    };
  }
  return {
    allowed: true,
    status: 200,
    message: "",
  };
}
function validateHaxiamManagedUserIdentityForRequest(req = null) {
  if (
    typeof HAXCMS.getDeploymentProfile !== "function" ||
    HAXCMS.getDeploymentProfile() !== "haxiam-managed"
  ) {
    return {
      allowed: true,
      status: 200,
      message: "",
    };
  }
  if (typeof HAXCMS.validateIAMRouteAuthorization !== "function") {
    return {
      allowed: true,
      status: 200,
      message: "",
    };
  }
  try {
    return normalizeIamAuthorizationResult(
      HAXCMS.validateIAMRouteAuthorization(true, req),
    );
  } catch {
    return {
      allowed: false,
      status: 403,
      message: "Tenant identity validation failed",
    };
  }
}
async function validateSiteApiRouteAccess(req, route = "", method = "get") {
  const policy = getSiteApiRouteAuthPolicy(route, method);
  const authContext = {
    policy,
    authenticated: false,
    userName: "",
    securityLevel: "public",
  };
  if (HAXCMS.isCLI() || HAXCMS.HAXCMS_DISABLE_JWT_CHECKS) {
    authContext.authenticated = true;
    authContext.securityLevel = policy === "public" ? "authenticated" : policy;
    setSiteApiAuthContext(req, authContext);
    return {
      allowed: true,
      status: 200,
      message: "",
    };
  }
  const bearerJwt = getBearerJwtFromRequest(req);
  const hasBearerJwt = bearerJwt !== "";
  let invalidBearerJwt = false;
  if (hasBearerJwt) {
    const validBearer = HAXCMS.validateJWT(req, null);
    if (!validBearer) {
      invalidBearerJwt = true;
    } else {
      const authenticatedUserName =
        getAuthenticatedUserNameFromBearerJwt(bearerJwt);
      if (authenticatedUserName !== "") {
        authContext.authenticated = true;
        authContext.userName = authenticatedUserName;
        authContext.securityLevel = "authenticated";
      }
    }
  }
  const basicAuth = authenticateBasicAuthorizationRequest(req);
  if (basicAuth.authenticated && !authContext.authenticated) {
    authContext.authenticated = true;
    authContext.userName = basicAuth.userName;
    authContext.securityLevel = "authenticated";
  }
  if (policy === "public") {
    setSiteApiAuthContext(req, authContext);
    return {
      allowed: true,
      status: 200,
      message: "",
    };
  }
  if (basicAuth.blocked && !authContext.authenticated) {
    return {
      allowed: false,
      status: 429,
      message: "Too many failed login attempts. Please try again later.",
      retryAfterSeconds: basicAuth.retryAfterSeconds,
    };
  }
  if (!hasBearerJwt && !basicAuth.attempted) {
    return {
      allowed: false,
      status: 401,
      message:
        "Authorization bearer token or basic credentials are required for this endpoint",
    };
  }
  if (!authContext.authenticated) {
    if (basicAuth.attempted) {
      return {
        allowed: false,
        status: 401,
        message: "Invalid basic authorization credentials",
      };
    }
    if (hasBearerJwt || invalidBearerJwt) {
      // bearer was present but invalid/expired. Return 403 (not 401) so the
      // frontend treats it as "try to refresh" consistently with the System
      // API's 403-on-failed-validateJWT; 401 is reserved for the
      // "no credentials present" case above so the client can distinguish a
      // genuine logged-out state from an expired-but-refreshable token.
      return {
        allowed: false,
        status: 403,
        message: "Invalid bearer token",
      };
    }
    return {
      allowed: false,
      status: 401,
      message: "Unable to authenticate request",
    };
  }
  if (authContext.userName === "") {
    return {
      allowed: false,
      status: 403,
      message: "Unable to resolve authenticated user context",
    };
  }
  if (policy === "authenticated") {
    authContext.securityLevel = "authenticated";
  }
  if (policy === "authenticated-site") {
    // Require and validate the site token even under Basic Auth so that
    // authentication alone (JWT or Basic) never grants site-scoped access.
    const siteToken = getRequestHeaderValue(req, "x-haxcms-site-token");
    if (siteToken === "") {
      return {
        allowed: false,
        status: 403,
        message: "X-HAXCMS-Site-Token header is required for this endpoint",
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
        message: "Unable to resolve site token context",
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
        message: "Invalid X-HAXCMS-Site-Token header",
      };
    }
    const iamAuthorization = validateHaxiamManagedUserIdentityForRequest(req);
    if (!iamAuthorization.allowed) {
      return {
        allowed: false,
        status: iamAuthorization.status || 403,
        message: iamAuthorization.message || "Access denied",
      };
    }
    authContext.siteName = siteName;
    authContext.securityLevel = "authenticated-site";
  }
  if (policy === "authenticated-user") {
    // Require and validate the user token even under Basic Auth.
    const userToken = getRequestHeaderValue(req, "x-haxcms-user-token");
    if (userToken === "") {
      return {
        allowed: false,
        status: 403,
        message: "X-HAXCMS-User-Token header is required for this endpoint",
      };
    }
    if (!HAXCMS.validateRequestToken(userToken, authContext.userName)) {
      return {
        allowed: false,
        status: 403,
        message: "Invalid X-HAXCMS-User-Token header",
      };
    }
    const iamAuthorization = validateHaxiamManagedUserIdentityForRequest(req);
    if (!iamAuthorization.allowed) {
      return {
        allowed: false,
        status: iamAuthorization.status || 403,
        message: iamAuthorization.message || "Access denied",
      };
    }
    authContext.securityLevel = "authenticated-user";
  }
  setSiteApiAuthContext(req, authContext);
  return {
    allowed: true,
    status: 200,
    message: "",
  };
}
function getNormalizedBasePath() {
  let basePath = String(HAXCMS.basePath || "/");
  if (basePath.charAt(0) !== "/") {
    basePath = "/" + basePath;
  }
  if (basePath.charAt(basePath.length - 1) !== "/") {
    basePath += "/";
  }
  return basePath;
}
function getSiteApiBasePath() {
  return getNormalizedBasePath() + "x/api";
}
function getRequestPathWithoutQuery(url = "") {
  return String(url || "").split("?")[0];
}
// Security/correctness: req.url arrives percent-encoded (e.g. a space in a
// filename is '%20'). res.sendFile() internally re-encodes whatever path
// string it is given via encodeURI() before handing it to the `send`
// module, which decodes exactly once downstream. Passing an already-encoded
// path straight through therefore double-encodes it ('%20' -> '%2520'),
// causing send to look up a literal '...%20...' filename that never exists
// on disk and returning a false 404 for any file whose name required
// percent-encoding (spaces, unicode, etc.) — express.static does not have
// this issue because it decodes without a prior re-encode step. Decoding
// once here (mirroring express.static's own behavior) restores the raw
// filesystem-safe path so res.sendFile()'s internal re-encode round-trips
// correctly. Malformed percent-encoding falls back to the raw path; `send`
// still rejects '..' traversal and null bytes downstream regardless.
function decodeStaticRequestPath(requestPath = "") {
  const rawPath = String(requestPath || "");
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}
function isSiteApiRequestPath(url = "") {
  return /\/x\/api(?:\/|$)/.test(getRequestPathWithoutQuery(url));
}
function setWellKnownContentType(res, requestPath = "") {
  const cleanRequestPath = getRequestPathWithoutQuery(requestPath);
  if (/\/\.well-known\/api-catalog$/.test(cleanRequestPath)) {
    res.setHeader(
      "Content-Type",
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    );
    return true;
  }
  if (/\/\.well-known\/security\.txt$/.test(cleanRequestPath)) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return true;
  }
  return false;
}
function shouldAllowWellKnownDotfiles(requestPath = "") {
  const cleanRequestPath = getRequestPathWithoutQuery(requestPath);
  return /\/\.well-known(?:\/|$)/.test(cleanRequestPath);
}
function getStaticSendFileOptions(rootPath = "", requestPath = "") {
  const options = {
    root: rootPath,
  };
  if (shouldAllowWellKnownDotfiles(requestPath)) {
    options.dotfiles = "allow";
  }
  return options;
}
// Extensions whose static files must be tagged charset=utf-8 so clients
// don't guess an encoding and render UTF-8 bytes as mojibake. Mirrors the
// AddCharset directive in system/boilerplate/site/.htaccess (.txt .md
// .json .yaml .yml .xml). HAXcms tooling always writes these as UTF-8.
const STATIC_CHARSET_EXTENSIONS = /\.(txt|md|json|ya?ml|xml)$/i;
// Set Content-Type for an explicitly-served static file: appends
// charset=utf-8 to the managed text formats above (matching the .htaccess
// AddCharset), sets the bare mime type for other resolved extensions, and
// falls back to `fallback` (default 'text/html') when mime can't resolve a
// type. Pass null as `fallback` to only set a header when mime resolves.
// Used at call sites that res.sendFile() afterward: send respects a
// pre-set Content-Type (it does not override), so this header wins.
function setStaticContentTypeWithCharset(
  res,
  requestPath = "",
  fallback = "text/html",
) {
  const cleanPath = getRequestPathWithoutQuery(requestPath);
  // Security (SEC-UPLOAD): resolve the type from the decoded path (what send
  // actually reads from disk), so an encoded extension such as x%2ehtml is not
  // mistaken for an extensionless file.
  const decodedPath = uploadSecurity.decodeRequestPathForFilesGuard(cleanPath);
  const mimeType = mime.getType(decodedPath);
  if (!mimeType) {
    // Security (SEC-UPLOAD): never fall back to text/html for user uploads
    // under a files/ directory; unknown types are served as opaque bytes.
    if (
      fallback !== null &&
      uploadSecurity.isFilesDirectoryRequestPath(decodedPath)
    ) {
      res.setHeader("Content-Type", "application/octet-stream");
    } else if (fallback !== null) {
      res.setHeader("Content-Type", fallback);
    }
    return;
  }
  // Don't charset-tag user uploads in /files/ (encoding not guaranteed),
  // matching the RemoveCharset in system/boilerplate/site/files/.htaccess.
  if (
    STATIC_CHARSET_EXTENSIONS.test(decodedPath) &&
    decodedPath.indexOf("/files/") === -1
  ) {
    res.setHeader("Content-Type", mimeType + "; charset=utf-8");
  } else {
    res.setHeader("Content-Type", mimeType);
  }
}
// express.static setHeaders hook: only tag the managed text formats with
// charset=utf-8 and leave every other type untouched so send's built-in
// type/charset handling (which already charset-tags text/html, text/css,
// application/javascript, etc.) stays intact for non-managed files. Runs
// before send's type() (which skips when Content-Type is already set).
// User uploads in /files/ get the bare type (no charset) to match the
// RemoveCharset in system/boilerplate/site/files/.htaccess.
function setManagedFileCharsetHeader(res, filePath = "") {
  const cleanPath = getRequestPathWithoutQuery(filePath);
  if (!STATIC_CHARSET_EXTENSIONS.test(cleanPath)) {
    return;
  }
  const mimeType = mime.getType(cleanPath);
  if (!mimeType) {
    return;
  }
  if (cleanPath.indexOf("/files/") !== -1) {
    res.setHeader("Content-Type", mimeType);
  } else {
    res.setHeader("Content-Type", mimeType + "; charset=utf-8");
  }
}
// express.static setHeaders hook for every static mount. On top of the charset
// handling above, force-download active content (html, htm, xhtml, xml, svg)
// under a files/ directory based on the file express.static actually resolved
// on disk. This is defense in depth behind the request-URL middleware (which
// can only guess at what the static handler will resolve) and mirrors the
// Apache FilesMatch rule in the site files/.htaccess.
function setManagedStaticHeaders(res, filePath = "") {
  setManagedFileCharsetHeader(res, filePath);
  if (uploadSecurity.shouldForceDownloadResolvedFile(publicDir, filePath)) {
    res.setHeader("Content-Disposition", "attachment");
  }
}
// D60: 405+Allow dispatch helpers. These support the catch-all middleware
// that checks if a request path matches a registered route for a different
// method and returns 405 + Allow header. Mirrors PHP SystemApiRouter /
// SiteApiRouter matchRoute + 405+Allow dispatch.
function matchRoutePatternToPath(pattern, routePath) {
  const patternParts = String(pattern || "")
    .split("/")
    .filter(function (p) {
      return p !== "";
    });
  const pathParts = String(routePath || "")
    .split("/")
    .filter(function (p) {
      return p !== "";
    });
  if (patternParts.length !== pathParts.length) {
    return false;
  }
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].charAt(0) === ":") {
      continue;
    }
    if (patternParts[i] !== pathParts[i]) {
      return false;
    }
  }
  return true;
}
function findAllowedMethodsForRouteSuffix(routeSuffix, registry) {
  const allowedMethods = [];
  if (!registry || typeof registry !== "object") {
    return allowedMethods;
  }
  const registryMethods = Object.keys(registry);
  for (let i = 0; i < registryMethods.length; i++) {
    const method = registryMethods[i];
    const routeMap = registry[method];
    if (!routeMap || typeof routeMap !== "object") {
      continue;
    }
    const routePatterns = Object.keys(routeMap);
    for (let j = 0; j < routePatterns.length; j++) {
      if (matchRoutePatternToPath(routePatterns[j], routeSuffix)) {
        const upperMethod = String(method || "").toUpperCase();
        if (allowedMethods.indexOf(upperMethod) === -1) {
          allowedMethods.push(upperMethod);
        }
        break;
      }
    }
  }
  return allowedMethods;
}
function extractSiteApiRouteSuffixFromPath(requestPath) {
  const siteApiBase = getSiteApiBasePath();
  const normalizedPath = getRequestPathWithoutQuery(requestPath);
  const siteScopedPrefix = "/" + HAXCMS.sitesDirectory + "/";
  let workingPath = normalizedPath;
  if (workingPath.indexOf(siteScopedPrefix) === 0) {
    const afterSites = workingPath.substring(siteScopedPrefix.length);
    const apiIndex = afterSites.indexOf(siteApiBase + "/");
    if (apiIndex !== -1) {
      workingPath = afterSites.substring(apiIndex);
    }
  }
  if (workingPath.indexOf(siteApiBase + "/") === 0) {
    return workingPath.substring(siteApiBase.length + 1);
  }
  if (workingPath === siteApiBase) {
    return "";
  }
  return null;
}
function extractSystemApiRouteSuffixFromPath(requestPath) {
  const systemApiV1Base =
    String(HAXCMS.basePath || "/") +
    String(HAXCMS.systemRequestBase || "") +
    "v1/";
  const normalizedPath = getRequestPathWithoutQuery(requestPath);
  const siteScopedPrefix = "/" + HAXCMS.sitesDirectory + "/";
  let workingPath = normalizedPath;
  if (workingPath.indexOf(siteScopedPrefix) === 0) {
    const afterSites = workingPath.substring(siteScopedPrefix.length);
    const apiIndex = afterSites.indexOf(systemApiV1Base);
    if (apiIndex !== -1) {
      workingPath = afterSites.substring(apiIndex);
    }
  }
  if (workingPath.indexOf(systemApiV1Base) === 0) {
    return workingPath.substring(systemApiV1Base.length);
  }
  return null;
}
function sendMethodNotAllowedResponse(res, routeSuffix, allowedMethods) {
  const sortedMethods = allowedMethods.slice().sort();
  res.set("Allow", sortedMethods.join(", "));
  return res.status(405).json({
    status: 405,
    data: {
      message: "Method not allowed",
      route: routeSuffix,
      methods: sortedMethods,
    },
  });
}

function getExplicitVariantInfo(pathname = "") {
  const matched = String(pathname || "").match(
    /^(.*)\.(html|md|json|ya?ml|xml)$/i,
  );
  if (!matched) {
    return {
      format: null,
      basePath: pathname,
    };
  }
  let format = matched[2].toLowerCase();
  if (format === "yml") {
    format = "yaml";
  }
  return {
    format,
    basePath: matched[1] || "",
  };
}

function getNegotiatedVariantFormat(acceptHeader = "") {
  const accept = String(acceptHeader || "").toLowerCase();
  const acceptsHtml =
    accept.indexOf("text/html") !== -1 ||
    accept.indexOf("application/xhtml+xml") !== -1;
  if (acceptsHtml) {
    return null;
  }
  if (accept.indexOf("text/markdown") !== -1) {
    return "md";
  }
  if (
    accept.indexOf("application/yaml") !== -1 ||
    accept.indexOf("application/x-yaml") !== -1 ||
    accept.indexOf("text/yaml") !== -1
  ) {
    return "yaml";
  }
  if (
    accept.indexOf("application/xml") !== -1 ||
    accept.indexOf("text/xml") !== -1
  ) {
    return "xml";
  }
  if (
    accept.indexOf("application/json") !== -1 &&
    accept.indexOf("text/html") === -1
  ) {
    return "json";
  }
  return null;
}

function normalizeSlugFromPath(pathname = "") {
  let slugPath = String(pathname || "").replace(/^\/+/, "");
  slugPath = slugPath.replace(/\/+$/, "");
  return slugPath;
}

function resolvePageBySlug(site, slug = "") {
  if (
    !site ||
    !site.manifest ||
    !Array.isArray(site.manifest.items) ||
    slug === ""
  ) {
    return null;
  }
  if (site.manifest.getItemByProperty) {
    const matched = site.manifest.getItemByProperty("slug", slug);
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

// Root/home fallback (PHP parity): PHP's loadNodeByLocation() falls back to
// $this->manifest->items[0] when no explicit path/slug match is found, so
// the site's first manifest item is always resolved as the homepage. The
// Node SSR path lacked this fallback, so requesting the bare site root
// (empty slug) never resolved a page item server-side and shipped an empty
// <haxcms-site-builder> — the client-side router then had to fetch and
// inject the homepage content after load, producing a blank-content flash
// on first paint.
function resolveHomePageItem(site) {
  if (
    !site ||
    !site.manifest ||
    !Array.isArray(site.manifest.items) ||
    site.manifest.items.length === 0
  ) {
    return null;
  }
  return site.manifest.items[0];
}

function buildCanonicalPagePath(routePrefix = "", slug = "") {
  const cleanPrefix = String(routePrefix || "").replace(/\/+$/, "");
  const cleanSlug = String(slug || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (cleanSlug === "") {
    if (cleanPrefix === "") {
      return "/";
    }
    return cleanPrefix;
  }
  if (cleanPrefix === "") {
    return "/" + cleanSlug;
  }
  return cleanPrefix + "/" + cleanSlug;
}

function appendVaryHeader(res, value = "Accept") {
  const currentHeader = res.getHeader("Vary");
  if (!currentHeader) {
    res.setHeader("Vary", value);
    return;
  }
  const current = String(currentHeader);
  const entries = current.split(",").map((entry) => entry.trim().toLowerCase());
  if (entries.indexOf(value.toLowerCase()) === -1) {
    res.setHeader("Vary", current + ", " + value);
  }
}

function getPageVariantLocation(site, item, format = "json") {
  if (!site || !item || !item.location) {
    return null;
  }
  if (site.getPageAlternateLocation) {
    return site.getPageAlternateLocation(item.location, format);
  }
  if (/\.html?$/i.test(item.location)) {
    return item.location.replace(/\.html?$/i, "." + format);
  }
  return item.location + "." + format;
}

function resolveVariantFilePath(site, item, format = "json") {
  const variantLocation = getPageVariantLocation(site, item, format);
  if (!variantLocation || !site || !site.siteDirectory) {
    return null;
  }
  // Security (N1/N5 parity): the sidecar path derives from the manifest
  // location, so prove it resolves inside the site before serving it.
  const absolutePath = resolveContainedPath(
    site.siteDirectory,
    variantLocation,
  );
  if (absolutePath === false) {
    return null;
  }
  if (fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isFile()) {
    return absolutePath;
  }
  return null;
}
async function ensurePageVariantFile(site, item, format = "json") {
  let variantFilePath = resolveVariantFilePath(site, item, format);
  if (variantFilePath) {
    return variantFilePath;
  }
  if (site && item && typeof site.writePageAlternateFormats === "function") {
    try {
      await site.writePageAlternateFormats(item);
    } catch {
      // intentionally ignored
    }
    variantFilePath = resolveVariantFilePath(site, item, format);
    if (variantFilePath) {
      return variantFilePath;
    }
  }
  return null;
}

async function servePageVariantFile(
  res,
  site,
  item,
  format,
  canonicalPath,
  negotiated = false,
) {
  const variantFilePath = await ensurePageVariantFile(site, item, format);
  if (!variantFilePath) {
    return false;
  }
  const contentType =
    PAGE_VARIANT_CONTENT_TYPES[format] || "text/plain; charset=utf-8";
  res.setHeader("Content-Type", contentType);
  if (canonicalPath) {
    res.setHeader("Content-Location", canonicalPath + "." + format);
  }
  if (negotiated) {
    appendVaryHeader(res, "Accept");
  }
  res.sendFile(variantFilePath);
  return true;
}

function setPageAlternateHeaders(res, site, item, canonicalPath = "") {
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
        "<" +
          canonicalPath +
          "." +
          format +
          '>; rel="alternate"; type="' +
          PAGE_VARIANT_CONTENT_TYPES[format].replace("; charset=utf-8", "") +
          '"',
      );
    }
  }
  if (links.length > 0) {
    res.setHeader("Link", links.join(", "));
    appendVaryHeader(res, "Accept");
  }
}
// llms-full.txt: the whole site as one markdown document, always the
// anonymous view (unpublished and hidden pages excluded). Same content as
// GET x/api/v1/site/export/md for an anonymous caller. Private sites answer
// 404 so they are never advertised to agents. Mirrors PHP
// HAXCMSSite::respondWithLlmsFull.
async function tryServeLlmsFull(req, res, site) {
  const isPrivate =
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.settings &&
    site.manifest.metadata.site.settings.private;
  if (isPrivate) {
    res.status(404).type("text/plain; charset=utf-8").send("Not found");
    return;
  }
  const {
    buildSiteExportMarkdown,
    sendCacheableText,
  } = require("./siteRoutes/v1/exports.js");
  const markdown = await buildSiteExportMarkdown(site, "", true);
  sendCacheableText(req, res, markdown, "text/markdown; charset=utf-8", true);
}

async function tryServePageVariantRequest(
  req,
  res,
  site,
  requestPath = "",
  routePrefix = "",
) {
  if (String(requestPath || "").replace(/^\/+|\/+$/g, "") === "llms-full.txt") {
    await tryServeLlmsFull(req, res, site);
    return {
      served: true,
      item: null,
      canonicalPath: null,
      notFound: false,
    };
  }
  const explicitInfo = getExplicitVariantInfo(requestPath);
  const slug = normalizeSlugFromPath(explicitInfo.basePath);
  const isHomeRequest = slug === "";
  const item = isHomeRequest
    ? resolveHomePageItem(site)
    : resolvePageBySlug(site, slug);
  if (!item) {
    // Empty site (no manifest items) — nothing to fall back to; preserve
    // the previous no-op behavior for the root path itself.
    if (isHomeRequest) {
      return {
        served: false,
        item: null,
        canonicalPath: null,
        notFound: false,
      };
    }
    const missingCanonicalPath = buildCanonicalPagePath(routePrefix, slug);
    if (explicitInfo.format) {
      res.status(404);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send("Not found");
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
      canonicalPath,
    );
    if (!servedExplicit) {
      res.status(404);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send("Not found");
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
      true,
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

function getMultisiteSiteName(requestPath = "") {
  const pathParts = String(requestPath || "")
    .replace(/^\/+/, "")
    .split("/");
  if (pathParts.length === 0 || pathParts[0] === "") {
    return null;
  }
  return pathParts[0];
}

function getMultisiteSiteSubPath(requestPath = "") {
  const pathParts = String(requestPath || "")
    .replace(/^\/+/, "")
    .split("/");
  if (pathParts.length <= 1) {
    return "/";
  }
  return "/" + pathParts.slice(1).join("/");
}

function getRequestAbsoluteUrl(req, fallbackPath = "/") {
  // Security (HAX-SEC / PHP [M4] parity): delegate protocol/host resolution to
  // HAXCMS.resolveTrustedProtocol / resolveTrustedHost so this and both
  // discovery API endpoints share one trust-proxy-aware + allowedHosts-validated
  // implementation. An attacker cannot inject a forged Host into canonical/
  // alternate Link headers or getSiteMetadata because X-Forwarded-* are trusted
  // only behind a configured trusted proxy and the host is validated against
  // config.security.allowedHosts when set.
  const protocol = HAXCMS.resolveTrustedProtocol(req);
  const host = HAXCMS.resolveTrustedHost(req);
  let requestPath = fallbackPath;
  if (req && (req.originalUrl || req.url)) {
    requestPath = getRequestPathWithoutQuery(req.originalUrl || req.url);
  }
  if (!requestPath || typeof requestPath !== "string") {
    requestPath = "/";
  }
  if (requestPath.substring(0, 1) !== "/") {
    requestPath = "/" + requestPath;
  }
  if (host === "") {
    return requestPath;
  }
  return protocol + "://" + host + requestPath;
}

function sanitizeManagedHeadMarkup(markup = "") {
  return String(markup || "").replace(/\\"/g, '"');
}

function replaceManagedHeadMarkup(
  indexFile = "",
  metadata = "",
  serviceWorkerScript = "",
) {
  const cleanMetadata = sanitizeManagedHeadMarkup(metadata);
  const cleanServiceWorkerScript =
    sanitizeManagedHeadMarkup(serviceWorkerScript);
  let managedHeadMarkup = cleanMetadata;
  if (cleanServiceWorkerScript !== "") {
    managedHeadMarkup += "\n" + cleanServiceWorkerScript + "\n";
  }
  let output = String(indexFile || "");
  const managedHeadPattern = /<meta charset[\s\S]*?(?=\s*<style[\s>])/i;
  if (managedHeadPattern.test(output)) {
    // Preserve <script> blocks (the base-href document.write setter and the
    // importmap) that sit between <meta charset> and <style>. The managed
    // metadata does not regenerate these, so without preservation they are
    // swallowed by the replacement. This regressed when <meta charset> was
    // moved to the top of <head> in the site boilerplate: the regex then
    // spans the base/importmap scripts instead of starting below them.
    // Without the base-href script no <base> tag is written, so relative
    // asset paths resolve against the document URL on sub-pages and 404.
    // Mirrors the PHP index.php template where getBaseTag() + the importmap
    // are separate parts ahead of the metadata.
    const matched = output.match(managedHeadPattern)[0];
    const scriptBlockPattern = /<script[\s\S]*?<\/script>/gi;
    const preservedScripts = [];
    let scriptMatch;
    while ((scriptMatch = scriptBlockPattern.exec(matched)) !== null) {
      preservedScripts.push(scriptMatch[0]);
    }
    const preservedScriptsMarkup =
      preservedScripts.length > 0 ? preservedScripts.join("\n  ") + "\n  " : "";
    output = output.replace(
      managedHeadPattern,
      preservedScriptsMarkup + managedHeadMarkup + "\n",
    );
    return output;
  }
  if (output.indexOf("</head>") !== -1) {
    output = output.replace("</head>", managedHeadMarkup + "\n</head>");
  }
  return output;
}

function replaceSiteBuilderContent(indexFile = "", pageContent = "") {
  const builderPattern =
    /<haxcms-site-builder([^>]*)>[\s\S]*?<\/haxcms-site-builder>/i;
  if (!builderPattern.test(indexFile)) {
    return indexFile;
  }
  // Security (M1): page content is untrusted for CSP purposes; pre-mark its
  // scripts so the later injectNonce pass never authorizes them.
  const safeContent = neutralizeUntrustedScriptNonces(pageContent);
  // Replacer function (not a replacement string) so `$&`, `$1`, `` $` `` or
  // `$'` sequences inside page content are inserted literally instead of
  // being expanded into other parts of the template.
  return String(indexFile || "").replace(
    builderPattern,
    function (match, builderAttrs) {
      return (
        "<haxcms-site-builder" +
        builderAttrs +
        ">" +
        safeContent +
        "</haxcms-site-builder>"
      );
    },
  );
}

function injectDevReloadScript(indexFile = "", port = 3000) {
  let output = String(indexFile || "");
  // dev-reload websocket only makes sense (and only has a server-side
  // listener) when running in development; never inject it otherwise.
  if (process.env.NODE_ENV !== "development") {
    return output;
  }
  if (output.indexOf("data-haxcms-dev-reload") !== -1) {
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
  if (output.indexOf("</body>") !== -1) {
    return output.replace(
      "</body>",
      `${devScript}
</body>`,
    );
  }
  return `${output}
${devScript}`;
}

async function renderDynamicSiteIndexResponse(
  req,
  site,
  item,
  canonicalPath = "",
  pageMiss = false,
  indexFilePath = "",
) {
  let indexFile = fs.readFileSync(indexFilePath, "utf8");
  const absoluteUrl = getRequestAbsoluteUrl(req, canonicalPath || "/");
  const metadata = await site.getSiteMetadata(
    item || null,
    absoluteUrl,
    "",
    canonicalPath || "",
  );
  const serviceWorkerScript = site.getServiceWorkerScript(
    null,
    false,
    site.getServiceWorkerStatus(),
  );
  indexFile = replaceManagedHeadMarkup(
    indexFile,
    metadata,
    serviceWorkerScript,
  );
  let pageContent = "";
  if (item) {
    try {
      pageContent = await site.getPageContent(item);
    } catch {
      pageContent = "";
    }
  } else if (pageMiss) {
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
