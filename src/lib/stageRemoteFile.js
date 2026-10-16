'use strict';

const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('./HAXCMS.js');
// reached through the module object so the network boundary can be stubbed in tests
const safeFetchLib = require('./safeFetch.js');

// Bulk-import staging shared by the site importers and createSite (#3060).
// HAXCMSFile.isValidBulkImportStagedPath only accepts real files under
// <configDirectory>/tmp/imports, so a remote file is downloaded here first and
// the staged path then takes the same bulk-import save as any other file.

// Directory under the HAXCMS config tree where bulk-import files are staged,
// created if it does not exist yet.
function getBulkImportStagingRoot() {
  const root = path.join(HAXCMS.configDirectory, 'tmp', 'imports');
  try {
    fs.ensureDirSync(root);
  } catch (e) {}
  sweepStaleStagedFiles(root);
  return root;
}

// Security (review 2026-10): files staged by the import routes are handed to
// the client and only consumed by a later createSite request, so they cannot
// be deleted right after staging, and an abandoned import left them behind
// forever. Opportunistically remove our own staged files (haximp- prefix,
// top level only) once they are older than the TTL. Mirrors PHP
// haxcms_import_sweep_staging_root.
const STAGED_FILE_PREFIX = 'haximp-';
const STAGED_FILE_TTL_MS = 60 * 60 * 1000;
function sweepStaleStagedFiles(root, now) {
  const cutoff = (typeof now === 'number' ? now : Date.now()) - STAGED_FILE_TTL_MS;
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch (e) {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (name.indexOf(STAGED_FILE_PREFIX) !== 0) {
      continue;
    }
    const full = path.join(root, name);
    try {
      const stats = fs.lstatSync(full);
      if (stats.isFile() && stats.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch (e) {}
  }
  return removed;
}

// Security (review 2026-10): the staged file's extension came straight from
// the remote URL. Keep it only when it is an extension the upload allowlist
// accepts; anything else is staged without an extension (save() validates
// the content against the real target name, not the staged one). Mirrors PHP
// haxcms_import_staged_extension.
function getStagedExtension(relPath) {
  const ext = path.extname(String(relPath || '').split(/[?#]/)[0]).toLowerCase().replace(/^\./, '');
  if (ext === '' || !/^[a-z0-9]+$/.test(ext)) {
    return '';
  }
  // lazy require: HAXCMSFile -> safeFetch -> HAXCMSFile
  const HAXCMSFile = require('./HAXCMSFile.js');
  if (HAXCMSFile.ALLOWED_MIME_BY_EXTENSION && Object.prototype.hasOwnProperty.call(HAXCMSFile.ALLOWED_MIME_BY_EXTENSION, ext)) {
    return '.' + ext;
  }
  return '';
}

// Fetch a remote file via safeFetch (SSRF-guarded: every resolved address and
// redirect hop is validated and the connection is pinned to the checked
// address) and stage it under the bulk-import root so createSite can move it
// into the site tree. Returns the absolute staged path, or null on any
// fetch/write failure or empty body (the file is simply skipped, matching how
// page fetch failures are handled). idx keeps staged filenames unique across
// the import.
async function stageRemoteFile(url, stagingRoot, idx, relPath) {
  let stagedPath = null;
  try {
    // Security (review 2026-10): cap the download at the site's
    // maxUploadSizeMb (save() would reject anything larger anyway) instead of
    // buffering an unbounded body.
    const maxBytes = await safeFetchLib.getUploadMaxBytes();
    const response = await safeFetchLib.safeFetch(url, { maxBytes: maxBytes });
    if (!response || !response.ok) {
      return null;
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (!buf || buf.length === 0) {
      return null;
    }
    const ext = getStagedExtension(relPath);
    stagedPath = path.join(
      stagingRoot,
      STAGED_FILE_PREFIX + Date.now() + '-' + idx + '-' + Math.floor(Math.random() * 1000000) + ext
    );
    fs.writeFileSync(stagedPath, buf);
    return stagedPath;
  } catch (e) {
    if (stagedPath) {
      try { fs.removeSync(stagedPath); } catch (removeErr) {}
    }
    return null;
  }
}

module.exports = {
  getBulkImportStagingRoot,
  stageRemoteFile,
  sweepStaleStagedFiles,
  getStagedExtension,
  STAGED_FILE_TTL_MS,
};
