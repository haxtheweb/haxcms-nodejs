'use strict';

const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const mime = require('mime');
const sharp = require('sharp');
const { buildFilePublicUrl } = require('./siteFileUrl.js');
const {
  getDeterministicFileUuid,
  getCanonicalFilePathForUuid,
  getSiteNameForFileUuid,
} = require('./siteFileUuid.js');

// Low-level files.json I/O for the file entity datastore (Phase 2, #3043).
//
// Reads and writes {siteDirectory}/files/files.json (the
// HAXCMS-FILE-SCHEMA-V1 envelope) with an atomic write and two in-memory
// indexes for O(1) lookup:
//   - uuid -> record (for load-by-uuid)
//   - path -> uuid   (for the page-save content path-scan and social-share)
//
// Delegates deterministic UUID logic to siteFileUuid.js so persisted UUIDs
// match the values existing consumers (files.js route, HAXCMSFile.save)
// expect. Image width/height uses sharp (already a dependency); mimetype
// uses the mime package (same as files.js).
class FilesDataStore {
  constructor(site) {
    this.site = site || null;
    this.envelope = null;
    this.uuidIndex = {};
    this.pathIndex = {};
    this.loaded = false;
  }

  // ------------------------------------------------------------------
  // Path resolution
  // ------------------------------------------------------------------

  // Absolute path to files.json.
  getFilesJsonPath() {
    const siteDirectory =
      this.site && typeof this.site.siteDirectory === 'string'
        ? this.site.siteDirectory
        : '';
    return path.join(siteDirectory, 'files', 'files.json');
  }

  // Absolute path to the files/ directory.
  getFilesDirectory() {
    const siteDirectory =
      this.site && typeof this.site.siteDirectory === 'string'
        ? this.site.siteDirectory
        : '';
    return path.join(siteDirectory, 'files');
  }

  // ------------------------------------------------------------------
  // Load / save the envelope
  // ------------------------------------------------------------------

  // Lazy-load the files.json envelope from disk (once per instance).
  // Auto-builds from disk if files.json is missing. Builds indexes.
  load() {
    if (this.loaded) {
      return this.envelope;
    }
    this.loaded = true;
    const jsonPath = this.getFilesJsonPath();
    if (fs.pathExistsSync(jsonPath)) {
      try {
        const contents = fs.readFileSync(jsonPath, 'utf8');
        if (contents) {
          const decoded = JSON.parse(contents);
          if (
            decoded &&
            typeof decoded === 'object' &&
            decoded.schema &&
            decoded.data
          ) {
            this.envelope = decoded;
            this.buildIndexes();
            return this.envelope;
          }
        }
      } catch (e) {
        // corrupt: fall through to auto-build
      }
    }
    // Missing or corrupt: auto-build from disk, then persist.
    this.envelope = this.buildEmptyEnvelope();
    this.buildIndexes();
    // reconcileMissingFromDisk is async, but load() is sync — we can't
    // call it here. The caller (getRecords, getByUuid, etc.) will trigger
    // a reconcile on first list() via FileStorage. For load() we just
    // build the empty envelope; disk files are ingested on first
    // reconcileMissingFromDisk or resolveUuidByPath call.
    return this.envelope;
  }

  // Persist the envelope to disk atomically (write temp + rename).
  save() {
    if (!this.loaded) {
      this.load();
    }
    const jsonPath = this.getFilesJsonPath();
    const dir = path.dirname(jsonPath);
    if (!fs.pathExistsSync(dir)) {
      fs.ensureDirSync(dir);
    }
    this.envelope.generated = Math.floor(Date.now() / 1000);
    const json = JSON.stringify(this.envelope, null, 2);
    if (!json) {
      return false;
    }
    const temp =
      jsonPath + '.tmp-' + crypto.randomUUID().split('-').join('').slice(0, 8);
    try {
      fs.writeFileSync(temp, json, 'utf8');
      fs.renameSync(temp, jsonPath);
    } catch (e) {
      try {
        fs.removeSync(temp);
      } catch (cleanupErr) {}
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Index management
  // ------------------------------------------------------------------

  buildIndexes() {
    this.uuidIndex = {};
    this.pathIndex = {};
    const files = this.getRecordsRaw();
    for (let i = 0; i < files.length; i++) {
      const record = files[i];
      const uuid = record && record.uuid ? String(record.uuid) : '';
      const recPath = record && record.path ? String(record.path) : '';
      if (uuid !== '') {
        this.uuidIndex[uuid] = record;
      }
      if (uuid !== '' && recPath !== '') {
        this.pathIndex[recPath] = uuid;
      }
    }
  }

  // The raw records array from the envelope (by reference).
  getRecordsRaw() {
    if (
      !this.envelope.data ||
      !Array.isArray(this.envelope.data.files)
    ) {
      this.envelope.data = this.envelope.data || {};
      this.envelope.data.files = [];
    }
    return this.envelope.data.files;
  }

  // ------------------------------------------------------------------
  // Read access
  // ------------------------------------------------------------------

  // All records (a copy of the envelope's files array).
  getRecords() {
    this.load();
    const files = this.getRecordsRaw();
    return files.slice();
  }

  // O(1) lookup by UUID.
  getByUuid(uuid) {
    this.load();
    const normalized = String(uuid || '')
      .trim()
      .toLowerCase();
    if (
      normalized === '' ||
      !Object.prototype.hasOwnProperty.call(this.uuidIndex, normalized)
    ) {
      return null;
    }
    return this.uuidIndex[normalized];
  }

  // O(1) lookup by canonical path.
  getByPath(inputPath) {
    this.load();
    const canonical = FilesDataStore.canonicalPath(inputPath);
    if (!Object.prototype.hasOwnProperty.call(this.pathIndex, canonical)) {
      return null;
    }
    const uuid = this.pathIndex[canonical];
    if (
      uuid &&
      Object.prototype.hasOwnProperty.call(this.uuidIndex, uuid)
    ) {
      return this.uuidIndex[uuid];
    }
    return null;
  }

  // Resolve a files/... path to its UUID, upserting unknown paths first
  // with the deterministic UUID at first ingest. Async because
  // buildFileRecordFromDisk uses sharp for image dimensions.
  async resolveUuidByPath(inputPath) {
    this.load();
    const canonical = FilesDataStore.canonicalPath(inputPath);
    if (Object.prototype.hasOwnProperty.call(this.pathIndex, canonical)) {
      return this.pathIndex[canonical];
    }
    // Unknown path: build a record from disk (deterministic uuid) and
    // upsert it, then return the uuid.
    const record = await this.buildFileRecordFromDisk(canonical);
    if (!record) {
      return '';
    }
    this.upsertRecord(record);
    return record.uuid ? String(record.uuid) : '';
  }

  // ------------------------------------------------------------------
  // Write access
  // ------------------------------------------------------------------

  // Upsert a record into files.json by UUID. Rebuilds indexes and persists.
  upsertRecord(record) {
    if (!record || typeof record !== 'object') {
      return false;
    }
    this.load();
    const uuid = record.uuid ? String(record.uuid).trim().toLowerCase() : '';
    if (uuid === '') {
      return false;
    }
    record.uuid = uuid;
    const files = this.getRecordsRaw();
    let found = false;
    for (let i = 0; i < files.length; i++) {
      if (
        files[i] &&
        files[i].uuid &&
        String(files[i].uuid).toLowerCase() === uuid
      ) {
        files[i] = record;
        found = true;
        break;
      }
    }
    if (!found) {
      files.push(record);
    }
    this.buildIndexes();
    return this.save();
  }

  // Remove a record by UUID. Rebuilds indexes and persists.
  removeRecord(uuid) {
    this.load();
    const normalized = String(uuid || '')
      .trim()
      .toLowerCase();
    if (normalized === '') {
      return false;
    }
    const files = this.getRecordsRaw();
    let removed = false;
    for (let i = 0; i < files.length; i++) {
      if (
        files[i] &&
        files[i].uuid &&
        String(files[i].uuid).toLowerCase() === normalized
      ) {
        files.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed) {
      return false;
    }
    this.buildIndexes();
    return this.save();
  }

  // ------------------------------------------------------------------
  // Reconciliation (non-destructive)
  // ------------------------------------------------------------------

  // Scan the files/ directory and build records for any on-disk files
  // missing from the index. Persists files.json if any were added.
  // Async because buildFileRecordFromDisk uses sharp.
  async reconcileMissingFromDisk() {
    this.load();
    const filesDir = this.getFilesDirectory();
    if (!fs.pathExistsSync(filesDir)) {
      return 0;
    }
    const diskFiles = this.collectDiskFiles(filesDir);
    let added = 0;
    for (let i = 0; i < diskFiles.length; i++) {
      const canonical = 'files/' + diskFiles[i];
      if (Object.prototype.hasOwnProperty.call(this.pathIndex, canonical)) {
        continue;
      }
      const record = await this.buildFileRecordFromDisk(canonical);
      if (record) {
        const files = this.getRecordsRaw();
        files.push(record);
        const uuid = record.uuid ? String(record.uuid) : '';
        const recPath = record.path ? String(record.path) : '';
        if (uuid !== '') {
          this.uuidIndex[uuid] = record;
        }
        if (uuid !== '' && recPath !== '') {
          this.pathIndex[recPath] = uuid;
        }
        added++;
      }
    }
    if (added > 0) {
      this.save();
    }
    return added;
  }

  // Flag records whose disk file is gone. NON-DESTRUCTIVE: does NOT
  // remove the records from files.json. Returns the orphan record arrays.
  flagOrphans() {
    this.load();
    const filesDir = this.getFilesDirectory();
    const orphans = [];
    const uuids = Object.keys(this.uuidIndex);
    for (let i = 0; i < uuids.length; i++) {
      const uuid = uuids[i];
      const record = this.uuidIndex[uuid];
      const recPath = record && record.path ? String(record.path) : '';
      if (recPath === '') {
        continue;
      }
      // path is 'files/...', strip the leading 'files/' to get the
      // relative path within the files directory.
      let relative = recPath;
      if (relative.indexOf('files/') === 0) {
        relative = relative.substring(6);
      }
      const absolute = path.join(filesDir, relative);
      if (!fs.pathExistsSync(absolute) || !fs.statSync(absolute).isFile()) {
        orphans.push(record);
      }
    }
    return orphans;
  }

  // ------------------------------------------------------------------
  // Disk scanning + record building
  // ------------------------------------------------------------------

  // Recursively scan the files/ directory for relative file paths,
  // excluding haxcms-managed/, dotfiles, and symlinks.
  collectDiskFiles(filesDir) {
    const result = [];
    if (!fs.pathExistsSync(filesDir)) {
      return result;
    }
    const ignored = [
      '.',
      '..',
      '.gitkeep',
      '.DS_Store',
      '._.DS_Store',
      '.htaccess',
      '._htaccess',
      'files.json',
    ];
    const stack = [filesDir];
    while (stack.length > 0) {
      const activeDir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(activeDir, { withFileTypes: true });
      } catch (e) {
        entries = [];
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (ignored.indexOf(entry.name) !== -1) {
          continue;
        }
        const absoluteEntryPath = path.join(activeDir, entry.name);
        // Skip symlinks.
        try {
          if (fs.lstatSync(absoluteEntryPath).isSymbolicLink()) {
            continue;
          }
        } catch (e) {
          continue;
        }
        if (entry.isDirectory()) {
          const relativeDirPath = path.relative(filesDir, absoluteEntryPath);
          if (
            relativeDirPath === 'haxcms-managed' ||
            relativeDirPath.indexOf('haxcms-managed' + path.sep) === 0 ||
            relativeDirPath.indexOf('haxcms-managed/') === 0
          ) {
            continue;
          }
          stack.push(absoluteEntryPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const relativePath = path.relative(filesDir, absoluteEntryPath);
        if (
          relativePath === '' ||
          relativePath === 'haxcms-managed' ||
          relativePath.indexOf('haxcms-managed' + path.sep) === 0 ||
          relativePath.indexOf('haxcms-managed/') === 0
        ) {
          continue;
        }
        // Normalize to forward slashes for the canonical path.
        result.push(relativePath.split(path.sep).join('/'));
      }
    }
    result.sort();
    return result;
  }

  // Build a file record from the on-disk file at the given canonical path.
  // Async because sharp (image dimensions) is async. Returns null if the
  // file does not exist.
  async buildFileRecordFromDisk(canonicalPathInput) {
    const canonical = FilesDataStore.canonicalPath(canonicalPathInput);
    const filesDir = this.getFilesDirectory();
    let relative = canonical;
    if (relative.indexOf('files/') === 0) {
      relative = relative.substring(6);
    }
    const absolutePath = path.join(filesDir, relative);
    if (!fs.pathExistsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return null;
    }
    const stats = fs.statSync(absolutePath);
    const size = stats && typeof stats.size === 'number' ? stats.size : 0;
    const dateCreated = FilesDataStore.getDateCreatedValue(stats);

    let mimetype = '';
    try {
      mimetype = mime.getType(absolutePath) || '';
    } catch (e) {
      mimetype = '';
    }
    if (mimetype === '') {
      mimetype = FilesDataStore.mimetypeFromExtension(absolutePath);
    }

    const baseFileUrl = buildFilePublicUrl(this.site, canonical);
    let fullUrl = baseFileUrl;
    if (dateCreated > 0) {
      fullUrl +=
        (baseFileUrl.indexOf('?') === -1 ? '?t=' : '&t=') + dateCreated;
    }

    let width = 0;
    let height = 0;
    if (
      mimetype.indexOf('image/') === 0 &&
      mimetype !== 'image/svg+xml'
    ) {
      try {
        const metadata = await sharp(absolutePath, { failOn: 'none' }).metadata();
        if (
          metadata &&
          metadata.width &&
          metadata.height &&
          metadata.width > 0 &&
          metadata.height > 0
        ) {
          width = metadata.width;
          height = metadata.height;
        }
      } catch (e) {
        // not a valid raster image or unreadable — leave 0/0
      }
    }

    return {
      uuid: getDeterministicFileUuid(this.site, canonical, size),
      path: canonical,
      name: path.basename(canonical),
      mimetype: mimetype,
      size: size,
      dateCreated: dateCreated,
      fullUrl: fullUrl,
      url: canonical,
      width: width,
      height: height,
    };
  }

  // ------------------------------------------------------------------
  // Envelope helpers
  // ------------------------------------------------------------------

  // Build an empty HAXCMS-FILE-SCHEMA-V1 envelope.
  buildEmptyEnvelope() {
    return {
      schema: 'HAXCMS-FILE-SCHEMA-V1',
      site: getSiteNameForFileUuid(this.site),
      generated: Math.floor(Date.now() / 1000),
      data: {
        path: 'files',
        files: [],
      },
    };
  }

  // Whether files.json exists on disk.
  exists() {
    return fs.pathExistsSync(this.getFilesJsonPath());
  }

  // ------------------------------------------------------------------
  // Static helpers (mirror PHP statics, delegate to siteFileUuid.js)
  // ------------------------------------------------------------------

  // Canonicalize a relative path to 'files/...' form.
  static canonicalPath(relativePath) {
    return getCanonicalFilePathForUuid(relativePath);
  }

  // Extension-based MIME type fallback (mirrors PHP mimetypeFromExtension).
  static mimetypeFromExtension(inputPath) {
    const extension = path.extname(String(inputPath || '')).replace(/^\./, '').toLowerCase();
    if (extension === 'jpg' || extension === 'jpeg') {
      return 'image/jpeg';
    }
    if (extension === 'png') {
      return 'image/png';
    }
    if (extension === 'gif') {
      return 'image/gif';
    }
    if (extension === 'svg') {
      return 'image/svg+xml';
    }
    if (extension === 'pdf') {
      return 'application/pdf';
    }
    if (extension === 'md') {
      return 'text/markdown';
    }
    if (extension === 'mp4') {
      return 'video/mp4';
    }
    if (extension === 'mp3') {
      return 'audio/mpeg';
    }
    if (extension === 'webp') {
      return 'image/webp';
    }
    if (extension === 'webm') {
      return 'video/webm';
    }
    if (extension === 'csv') {
      return 'text/csv';
    }
    if (extension === 'txt') {
      return 'text/plain';
    }
    if (extension === 'html') {
      return 'text/html';
    }
    return '';
  }

  // Date created from fs.Stats in SECONDS (matches files.js getDateCreatedValue).
  static getDateCreatedValue(stats) {
    if (!stats || typeof stats !== 'object') {
      return 0;
    }
    let createdMs = 0;
    if (
      typeof stats.mtimeMs === 'number' &&
      Number.isFinite(stats.mtimeMs) &&
      stats.mtimeMs > 0
    ) {
      createdMs = stats.mtimeMs;
    } else if (
      typeof stats.ctimeMs === 'number' &&
      Number.isFinite(stats.ctimeMs) &&
      stats.ctimeMs > 0
    ) {
      createdMs = stats.ctimeMs;
    } else if (
      typeof stats.birthtimeMs === 'number' &&
      Number.isFinite(stats.birthtimeMs) &&
      stats.birthtimeMs > 0
    ) {
      createdMs = stats.birthtimeMs;
    }
    if (createdMs <= 0) {
      return 0;
    }
    return Math.floor(createdMs / 1000);
  }
}

module.exports = FilesDataStore;
