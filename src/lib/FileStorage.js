'use strict';

const EntityStorage = require('./EntityStorage.js');
const EntityDefinition = require('./EntityDefinition.js');
const FileEntity = require('./FileEntity.js');
const FilesDataStore = require('./FilesDataStore.js');

// Writable EntityStorage adapter for the 'file' entity type (Phase 2, #3043).
//
// Wraps FilesDataStore (low-level files.json I/O) and implements EntityStorage
// so EntityRegistry.getStorage('file') returns this real adapter instead of
// NotImplementedStorage. load(key) is O(1) from the files.json uuid index;
// list(filters) runs reconcileMissingFromDisk first; save(entity) upserts
// into files.json; delete(key) removes the record AND scrubs the uuid from
// every page's page.metadata.files (one manifest save).
class FileStorage extends EntityStorage {
  constructor(site, definition) {
    super();
    this.site = site || null;
    this.dataStore = new FilesDataStore(site);
    this.definition = definition || null;
  }

  // Register this FileStorage on an EntityRegistry for the 'file' type.
  // Route handlers call this once after constructing the registry so
  // getStorage('file') returns the real adapter.
  static registerOn(registry) {
    const site = registry.getSite();
    const definition = registry.getDefinition('file');
    const storage = new FileStorage(site, definition);
    registry.registerStorage('file', storage);
    return storage;
  }

  // Load a single file entity by UUID (O(1) from the files.json index).
  load(key) {
    const record = this.dataStore.getByUuid(key);
    if (record === null) {
      return null;
    }
    return new FileEntity(this.resolveDefinition(), record);
  }

  // List file entities. Runs reconcileMissingFromDisk first so manually
  // dropped files appear in the index. Optional filters: mimetype, name, path.
  // Async because reconcileMissingFromDisk uses sharp for image dimensions.
  async list(filters) {
    filters = filters || {};
    await this.dataStore.reconcileMissingFromDisk();
    const records = this.dataStore.getRecords();
    const definition = this.resolveDefinition();
    const entities = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      // Apply optional filters (mimetype, name, path).
      if (filters.mimetype) {
        const mt = record && record.mimetype ? String(record.mimetype) : '';
        if (mt.indexOf(String(filters.mimetype)) !== 0) {
          continue;
        }
      }
      if (filters.name) {
        const nm = record && record.name ? String(record.name) : '';
        if (nm.indexOf(String(filters.name)) === -1) {
          continue;
        }
      }
      if (filters.path) {
        const p = record && record.path ? String(record.path) : '';
        if (p.indexOf(String(filters.path)) === -1) {
          continue;
        }
      }
      entities.push(new FileEntity(definition, record));
    }
    return entities;
  }

  // Upsert a file entity into files.json. Returns false if the entity is
  // not an Entity or is missing required fields (uuid/path/name/mimetype).
  save(entity) {
    if (!entity || typeof entity !== 'object') {
      return false;
    }
    const fields =
      typeof entity.getFields === 'function' ? entity.getFields() : entity;
    if (!fields || typeof fields !== 'object') {
      return false;
    }
    const uuid = fields.uuid ? String(fields.uuid) : '';
    const recPath = fields.path ? String(fields.path) : '';
    const name = fields.name ? String(fields.name) : '';
    const mimetype = fields.mimetype ? String(fields.mimetype) : '';
    if (uuid === '' || recPath === '' || name === '' || mimetype === '') {
      return false;
    }
    return this.dataStore.upsertRecord(fields);
  }

  // Delete a file entity by UUID: remove the files.json record and scrub
  // the uuid from every page's page.metadata.files (one manifest save).
  // The actual disk file deletion is handled by the route handler's
  // fileOperation() (which has the security validation); this method only
  // handles the data-layer cleanup.
  delete(key) {
    const uuid = String(key || '').trim().toLowerCase();
    if (uuid === '') {
      return false;
    }
    const removed = this.dataStore.removeRecord(uuid);
    this.scrubUuidFromPages(uuid);
    return removed;
  }

  // The underlying datastore (for route handlers that need
  // reconcileMissingFromDisk / flagOrphans / resolveUuidByPath).
  getDataStore() {
    return this.dataStore;
  }

  // Resolve the EntityDefinition for 'file'. Uses the injected definition
  // if available; otherwise builds a standalone one from a hardcoded entry
  // (the file entity definition is stable). The standalone resolver returns
  // this storage so entity.save() delegates back to us.
  resolveDefinition() {
    if (this.definition) {
      return this.definition;
    }
    const entry = {
      type: 'file',
      scope: 'site',
      primaryKey: 'uuid',
      uniqueKeys: ['uuid'],
      requiredFields: ['uuid', 'path', 'name', 'mimetype'],
      storage: {
        type: 'datastore',
        enabled: true,
        scope: 'site',
        location: '{siteDirectory}/files/files.json',
        storeSchema: 'HAXCMS-FILE-SCHEMA-V1',
        collectionKey: 'files',
        indexKey: 'uuid',
      },
      supportedOperations: ['load', 'save', 'list', 'delete', 'reconcile'],
      endpoints: ['/x/api/v1/files', '/x/api/v1/files/{fileUuid}'],
      formats: ['json', 'md', 'yaml', 'xml'],
      auth: 'authenticated-site',
      enabled: true,
    };
    const self = this;
    const resolver = function (type) {
      if (type === 'file') {
        return self;
      }
      return null;
    };
    return new EntityDefinition(entry, resolver);
  }

  // Walk the site manifest items and remove the given uuid from every
  // page's page.metadata.files array. Saves the manifest once if any
  // page was modified. Only scrubs string matches (Phase 2 uuid shape);
  // legacy object entries are left to self-heal on the next page save.
  scrubUuidFromPages(uuid) {
    const site = this.site;
    if (!site || typeof site !== 'object') {
      return;
    }
    if (!site.manifest || !Array.isArray(site.manifest.items)) {
      return;
    }
    const items = site.manifest.items;
    let modified = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || !item.metadata || typeof item.metadata !== 'object') {
        continue;
      }
      if (!Array.isArray(item.metadata.files)) {
        continue;
      }
      const files = item.metadata.files;
      const newFiles = [];
      let changed = false;
      for (let j = 0; j < files.length; j++) {
        const entry = files[j];
        // uuid-string shape (Phase 2): entries are plain strings.
        if (typeof entry === 'string') {
          if (entry.toLowerCase() === uuid) {
            changed = true;
            continue;
          }
          newFiles.push(entry);
        }
        // Legacy object shape: entries are objects with no uuid field —
        // skip (they self-heal on the next page save).
        else {
          newFiles.push(entry);
        }
      }
      if (changed) {
        item.metadata.files = newFiles;
        modified = true;
      }
    }
    if (modified) {
      if (site.manifest && typeof site.manifest.save === 'function') {
        try {
          site.manifest.save();
        } catch (e) {}
      } else if (typeof site.save === 'function') {
        try {
          site.save();
        } catch (e) {}
      }
    }
  }
}

module.exports = FileStorage;
