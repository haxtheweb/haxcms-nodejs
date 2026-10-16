'use strict';

const fs = require('fs-extra');
const path = require('path');

// Security (review 2026-10): lifecycle management for multipart upload temp
// files. multer writes every uploaded part to disk before any route handler
// runs, and no handler removed its temp file, so <config>/tmp grew without
// bound (including from unauthenticated requests). This module:
//   - gives multer a dedicated directory (<config>/tmp/uploads) so cleanup
//     can never touch other tmp consumers such as tmp/imports (bulk-import
//     staging),
//   - removes a request's temp files once its response is finished/closed,
//   - opportunistically sweeps stale temp files left behind by a crash.

// multer's default disk storage names files with crypto.randomBytes(16) hex.
const MULTER_TEMP_FILENAME_PATTERN = /^[0-9a-f]{32}$/;
const UPLOAD_TEMP_SUBDIRECTORY = 'uploads';
const DEFAULT_STALE_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function getUploadTempDirectory(configDirectory) {
  return path.join(String(configDirectory || ''), 'tmp', UPLOAD_TEMP_SUBDIRECTORY);
}

// Collect every temp path multer attached to the request (upload.any() sets
// req.files[], upload.single() sets req.file, upload.fields() sets an object
// of arrays).
function collectRequestUploadPaths(req) {
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
    req.files.forEach(pushFile);
  }
  else if (req.files && typeof req.files === 'object') {
    Object.keys(req.files).forEach((key) => {
      if (Array.isArray(req.files[key])) {
        req.files[key].forEach(pushFile);
      }
    });
  }
  return paths;
}

function isPathInsideDirectory(candidatePath, directory) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate.indexOf(resolvedDirectory + path.sep) === 0;
}

// Remove the request's multer temp files. Only paths that are still inside
// the multer temp directory are touched: a handler that kept the upload
// (e.g. HAXCMSFile.save moves it into the site's files/ dir) has already
// moved it away, so the unlink is a no-op for that path.
function removeRequestUploadTempFiles(req, uploadTempDirectory) {
  const paths = collectRequestUploadPaths(req);
  for (let i = 0; i < paths.length; i++) {
    const filePath = paths[i];
    if (uploadTempDirectory && !isPathInsideDirectory(filePath, uploadTempDirectory)) {
      continue;
    }
    try {
      fs.unlinkSync(filePath);
    }
    catch (e) {
      // ENOENT: already moved/removed by the handler; nothing to do.
    }
  }
}

// Register (once per request) a finish/close hook that removes the request's
// upload temp files when the response is done, success or failure.
function registerUploadTempCleanup(req, res, uploadTempDirectory) {
  if (!req || !res || typeof res.once !== 'function' || req.haxcmsUploadCleanupRegistered) {
    return;
  }
  req.haxcmsUploadCleanupRegistered = true;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    removeRequestUploadTempFiles(req, uploadTempDirectory);
  };
  res.once('finish', cleanup);
  res.once('close', cleanup);
}

// Delete multer-named temp files older than maxAgeMs. Only regular files whose
// name matches multer's random naming are considered, and only directly in
// the given directory (no recursion), so nothing else can be swept.
function sweepStaleUploadTempFiles(directory, options = {}) {
  const maxAgeMs = typeof options.maxAgeMs === 'number' ? options.maxAgeMs : DEFAULT_STALE_UPLOAD_MAX_AGE_MS;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(directory);
  }
  catch (e) {
    return removed;
  }
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i];
    if (!MULTER_TEMP_FILENAME_PATTERN.test(name)) {
      continue;
    }
    const filePath = path.join(directory, name);
    try {
      const stats = fs.lstatSync(filePath);
      if (!stats.isFile()) {
        continue;
      }
      if (now - stats.mtimeMs < maxAgeMs) {
        continue;
      }
      fs.unlinkSync(filePath);
      removed.push(filePath);
    }
    catch (e) {}
  }
  return removed;
}

// Throttled sweeper: runs at most once per intervalMs. Sweeps the dedicated
// multer dir plus any legacy multer-named files multer used to drop directly
// in <config>/tmp before the dedicated dir existed.
function createStaleUploadSweeper(configDirectory, options = {}) {
  const intervalMs = typeof options.intervalMs === 'number' ? options.intervalMs : DEFAULT_SWEEP_INTERVAL_MS;
  const maxAgeMs = typeof options.maxAgeMs === 'number' ? options.maxAgeMs : DEFAULT_STALE_UPLOAD_MAX_AGE_MS;
  let lastSweep = 0;
  return function sweepIfDue(now = Date.now()) {
    if (lastSweep !== 0 && now - lastSweep < intervalMs) {
      return [];
    }
    lastSweep = now;
    return [
      ...sweepStaleUploadTempFiles(getUploadTempDirectory(configDirectory), { maxAgeMs, now }),
      ...sweepStaleUploadTempFiles(path.join(String(configDirectory || ''), 'tmp'), { maxAgeMs, now }),
    ];
  };
}

module.exports = {
  MULTER_TEMP_FILENAME_PATTERN,
  DEFAULT_STALE_UPLOAD_MAX_AGE_MS,
  getUploadTempDirectory,
  collectRequestUploadPaths,
  removeRequestUploadTempFiles,
  registerUploadTempCleanup,
  sweepStaleUploadTempFiles,
  createStaleUploadSweeper,
};
