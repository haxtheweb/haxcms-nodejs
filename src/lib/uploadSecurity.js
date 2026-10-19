'use strict';

// Security (SEC-UPLOAD): upload temp-file lifecycle + HTML-in-files guard.
//
// multer writes every multipart file part to <configDirectory>/tmp/ before any
// route handler runs. None of the upload/convert/import handlers unlink those
// temp files, so every request (including unauthenticated ones, before the
// auth pre-check in app.js was added) left a file behind. This module holds:
//   - a per-request cleanup middleware that unlinks req.file / req.files temp
//     paths once the response finishes or the connection closes,
//   - a sweeper that removes stale multer temp files (and stale bulk-import
//     staging entries) left behind by crashes or aborted requests,
//   - the per-route conversion upload cap,
//   - the decoded-path decision for forcing a download of active content
//     (HTML/XHTML/XML/SVG) served from a site files/ directory.

const fs = require('fs-extra');
const path = require('path');

// multer's DiskStorage default filename is crypto.randomBytes(16).toString('hex')
// (32 lowercase hex chars, no extension). Other HAXcms code writes transient
// files into the same directory with fixed prefixes that are always deleted
// on the happy path; a crash could leave them behind, so they are swept too.
const UPLOAD_TEMP_NAME_PATTERNS = [
  /^[0-9a-f]{32}$/,
  /^inline-image-[0-9a-f-]{36}$/,
  /^haxcms-upload-\d+-\d+$/,
];
const UPLOAD_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
// tmp/imports is the bulk-import staging root (stageRemoteFile, importers).
// Staged entries are moved into a site during the same request, so anything
// older than a day is abandoned.
const IMPORT_STAGING_DIRNAME = 'imports';
const IMPORT_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UPLOAD_TEMP_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// Security (SEC-UPLOAD): conversion actions/* routes only ever accept a single
// office/PDF/HTML document, so they get a much lower cap than the general
// 1 GB upload limit. Configurable via config.json security.conversionMaxUploadMb
// or the HAXCMS_CONVERSION_MAX_UPLOAD_MB env var (env wins).
const DEFAULT_CONVERSION_MAX_UPLOAD_MB = 50;
const MAX_CONVERSION_MAX_UPLOAD_MB = 1024;

// Security (SEC-UPLOAD): extensions forced to download (Content-Disposition:
// attachment) when served from any site files/ directory. Parity contract with
// the PHP backend (.htaccess / nginx): html, htm, xhtml, xml, svg.
const FORCE_DOWNLOAD_FILES_EXTENSIONS = ['html', 'htm', 'xhtml', 'xml', 'svg'];
const FORCE_DOWNLOAD_FILES_EXTENSION_PATTERN = new RegExp(
  '\\.(' + FORCE_DOWNLOAD_FILES_EXTENSIONS.join('|') + ')$',
  'i',
);

function isUploadTempFileName(name = '') {
  const value = String(name || '');
  for (let i = 0; i < UPLOAD_TEMP_NAME_PATTERNS.length; i++) {
    if (UPLOAD_TEMP_NAME_PATTERNS[i].test(value)) {
      return true;
    }
  }
  return false;
}

function isPathInside(parentPath, targetPath) {
  const relative = path.relative(parentPath, targetPath);
  return relative !== '' && relative.indexOf('..') !== 0 && !path.isAbsolute(relative);
}

// Collect the on-disk temp paths multer recorded on the request. Handles
// upload.any() (array), upload.fields() (object of arrays) and upload.single().
function collectUploadedTempPaths(req) {
  const paths = [];
  if (!req || typeof req !== 'object') {
    return paths;
  }
  const pushFile = (file) => {
    if (file && typeof file === 'object' && typeof file.path === 'string' && file.path !== '') {
      paths.push(file.path);
    }
  };
  pushFile(req.file);
  if (Array.isArray(req.files)) {
    for (let i = 0; i < req.files.length; i++) {
      pushFile(req.files[i]);
    }
  }
  else if (req.files && typeof req.files === 'object') {
    const keys = Object.keys(req.files);
    for (let k = 0; k < keys.length; k++) {
      const group = req.files[keys[k]];
      if (Array.isArray(group)) {
        for (let i = 0; i < group.length; i++) {
          pushFile(group[i]);
        }
      }
    }
  }
  return paths;
}

// Unlink the multer temp files for this request. Only paths inside the upload
// temp directory are touched, and only by their original temp path, so a file
// a handler already moved into a site (fs.moveSync) is simply gone from the
// temp path (ENOENT, ignored) and is never affected.
function removeUploadedTempFiles(req, uploadTempDirectory) {
  const tempPaths = collectUploadedTempPaths(req);
  if (tempPaths.length === 0) {
    return 0;
  }
  const root = path.resolve(String(uploadTempDirectory || ''));
  let removed = 0;
  for (let i = 0; i < tempPaths.length; i++) {
    const tempPath = path.resolve(tempPaths[i]);
    if (!isPathInside(root, tempPath)) {
      continue;
    }
    try {
      fs.unlinkSync(tempPath);
      removed++;
    }
    catch (e) {
      // ENOENT (moved/already removed) or anything else: never break the response
    }
  }
  return removed;
}

// Express middleware: register cleanup BEFORE the multipart parser runs so the
// temp files are removed whatever the outcome (handler success, handler error,
// auth failure, multer limit error, client abort).
function createUploadTempCleanupMiddleware(uploadTempDirectory) {
  return function uploadTempCleanupMiddleware(req, res, next) {
    if (!req.haxcmsUploadTempCleanupRegistered) {
      req.haxcmsUploadTempCleanupRegistered = true;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        removeUploadedTempFiles(req, uploadTempDirectory);
      };
      res.once('finish', cleanup);
      res.once('close', cleanup);
    }
    next();
  };
}

function getEntryAgeMs(entryPath, now) {
  const stats = fs.lstatSync(entryPath);
  return { stats, ageMs: now - stats.mtimeMs };
}

// Delete stale multer-style temp files directly in uploadTempDirectory (older
// than maxAgeMs, default 1h) and stale entries in the tmp/imports staging root
// (older than importMaxAgeMs, default 24h). Nothing else in the directory is
// touched. Returns the list of removed absolute paths.
function sweepUploadTempDirectory(uploadTempDirectory, options = {}) {
  const removed = [];
  const root = path.resolve(String(uploadTempDirectory || ''));
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const maxAgeMs = typeof options.maxAgeMs === 'number' ? options.maxAgeMs : UPLOAD_TEMP_MAX_AGE_MS;
  const importMaxAgeMs = typeof options.importMaxAgeMs === 'number'
    ? options.importMaxAgeMs
    : IMPORT_STAGING_MAX_AGE_MS;
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  }
  catch (e) {
    return removed;
  }
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i];
    if (!isUploadTempFileName(name)) {
      continue;
    }
    const entryPath = path.join(root, name);
    try {
      const info = getEntryAgeMs(entryPath, now);
      if (!info.stats.isFile() || info.ageMs <= maxAgeMs) {
        continue;
      }
      fs.unlinkSync(entryPath);
      removed.push(entryPath);
    }
    catch (e) {}
  }
  const importsRoot = path.join(root, IMPORT_STAGING_DIRNAME);
  let importEntries = [];
  try {
    if (fs.lstatSync(importsRoot).isDirectory()) {
      importEntries = fs.readdirSync(importsRoot);
    }
  }
  catch (e) {
    importEntries = [];
  }
  for (let i = 0; i < importEntries.length; i++) {
    const entryPath = path.join(importsRoot, importEntries[i]);
    try {
      const info = getEntryAgeMs(entryPath, now);
      if (info.ageMs <= importMaxAgeMs) {
        continue;
      }
      fs.removeSync(entryPath);
      removed.push(entryPath);
    }
    catch (e) {}
  }
  return removed;
}

// Run the sweeper now and every intervalMs. The timer is unref'd so it never
// keeps the process alive; the returned function stops it.
function startUploadTempSweeper(uploadTempDirectory, options = {}) {
  const intervalMs = typeof options.intervalMs === 'number'
    ? options.intervalMs
    : UPLOAD_TEMP_SWEEP_INTERVAL_MS;
  const run = () => {
    try {
      sweepUploadTempDirectory(uploadTempDirectory, options);
    }
    catch (e) {}
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  return function stopUploadTempSweeper() {
    clearInterval(timer);
  };
}

function getConversionUploadMaxBytes(config = null, env = process.env) {
  let mb = DEFAULT_CONVERSION_MAX_UPLOAD_MB;
  let candidate = null;
  if (config && config.security && typeof config.security.conversionMaxUploadMb !== 'undefined') {
    candidate = config.security.conversionMaxUploadMb;
  }
  if (env && typeof env.HAXCMS_CONVERSION_MAX_UPLOAD_MB === 'string' && env.HAXCMS_CONVERSION_MAX_UPLOAD_MB.trim() !== '') {
    candidate = env.HAXCMS_CONVERSION_MAX_UPLOAD_MB.trim();
  }
  if (candidate !== null) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      mb = Math.min(parsed, MAX_CONVERSION_MAX_UPLOAD_MB);
    }
  }
  return Math.floor(mb * 1024 * 1024);
}

// Decode the request path once (as send/res.sendFile does before touching the
// filesystem) so encoded tricks like x%2ehtml cannot dodge the extension test.
function decodeRequestPathForFilesGuard(url = '') {
  const rawPath = String(url || '').split('?')[0].split('#')[0];
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  }
  catch (e) {
    decoded = rawPath;
  }
  return decoded.replace(/\\/g, '/');
}

// True when the (decoded) path is somewhere below a files/ directory. 'files'
// must be a directory segment, not the final segment, so a page slug such as
// /files is not treated as an upload.
function isFilesDirectoryRequestPath(decodedPath = '') {
  return String(decodedPath || '').indexOf('/files/') !== -1;
}

// True when the request targets active content (see
// FORCE_DOWNLOAD_FILES_EXTENSIONS) somewhere under a files/ directory,
// evaluated on the decoded path.
function shouldForceDownloadFilesRequest(url = '') {
  const decodedPath = decodeRequestPathForFilesGuard(url);
  if (!isFilesDirectoryRequestPath(decodedPath)) {
    return false;
  }
  const segments = decodedPath.split('/');
  const lastSegment = segments[segments.length - 1] || '';
  return FORCE_DOWNLOAD_FILES_EXTENSION_PATTERN.test(lastSegment);
}

module.exports = {
  UPLOAD_TEMP_MAX_AGE_MS,
  IMPORT_STAGING_MAX_AGE_MS,
  UPLOAD_TEMP_SWEEP_INTERVAL_MS,
  DEFAULT_CONVERSION_MAX_UPLOAD_MB,
  FORCE_DOWNLOAD_FILES_EXTENSIONS,
  isUploadTempFileName,
  collectUploadedTempPaths,
  removeUploadedTempFiles,
  createUploadTempCleanupMiddleware,
  sweepUploadTempDirectory,
  startUploadTempSweeper,
  getConversionUploadMaxBytes,
  decodeRequestPathForFilesGuard,
  isFilesDirectoryRequestPath,
  shouldForceDownloadFilesRequest,
};
