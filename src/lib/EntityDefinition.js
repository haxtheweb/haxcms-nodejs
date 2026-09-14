'use strict';

const EntityStorage = require('./EntityStorage.js');
const NotImplementedStorage = require('./NotImplementedStorage.js');

// Typed wrapper around one entities.yaml entry. Mirrors the OpenAPI
// EntityDescriptor 1:1 and knows its `storage` block.
//
// Constructed by EntityRegistry with the raw parsed entry and an optional
// storage-resolver function (which the registry uses to hand back registered
// adapters). When no resolver is supplied — or the resolver has no adapter for
// this type — getStorage() returns a NotImplementedStorage, so the
// EntityRegistry->getDefinition(type)->getStorage()->load() chain is uniform
// across every type even before real adapters are wired.
class EntityDefinition {
  constructor(entry, storageResolver) {
    this.entry = entry || {};
    this.storageResolver = storageResolver || null;
  }

  // The entity type (canonical identifier, e.g. 'file').
  getType() {
    return this.entry && this.entry.type != null
      ? String(this.entry.type)
      : '';
  }

  // Site or system scope.
  getScope() {
    return this.entry && this.entry.scope != null
      ? String(this.entry.scope)
      : '';
  }

  // Human-readable description.
  getDescription() {
    return this.entry && this.entry.description != null
      ? String(this.entry.description)
      : '';
  }

  // Primary-key field name.
  getPrimaryKey() {
    return this.entry && this.entry.primaryKey != null
      ? String(this.entry.primaryKey)
      : '';
  }

  // Unique-key field names.
  getUniqueKeys() {
    if (this.entry && Array.isArray(this.entry.uniqueKeys)) {
      return this.entry.uniqueKeys.slice();
    }
    return [];
  }

  // Required field names.
  getRequiredFields() {
    if (this.entry && Array.isArray(this.entry.requiredFields)) {
      return this.entry.requiredFields.slice();
    }
    return [];
  }

  // The storage block (type/enabled/scope/location/storeSchema/collectionKey/indexKey/source).
  getStorageBlock() {
    if (this.entry && this.entry.storage && typeof this.entry.storage === 'object') {
      return this.entry.storage;
    }
    return {};
  }

  // The storage.type vocabulary value (datastore/jos.items/webcomponent/file/jos/config).
  getStorageType() {
    const storage = this.getStorageBlock();
    return storage && storage.type != null ? String(storage.type) : '';
  }

  // Supported operation names.
  getSupportedOperations() {
    if (this.entry && Array.isArray(this.entry.supportedOperations)) {
      return this.entry.supportedOperations.slice();
    }
    return [];
  }

  // Endpoint paths.
  getEndpoints() {
    if (this.entry && Array.isArray(this.entry.endpoints)) {
      return this.entry.endpoints.slice();
    }
    return [];
  }

  // Filterable field names (may be empty for types that declare none).
  getFilterableFields() {
    if (this.entry && Array.isArray(this.entry.filterableFields)) {
      return this.entry.filterableFields.slice();
    }
    return [];
  }

  // Sortable field names (may be empty).
  getSortableFields() {
    if (this.entry && Array.isArray(this.entry.sortableFields)) {
      return this.entry.sortableFields.slice();
    }
    return [];
  }

  // Selectable field names (may be empty).
  getSelectableFields() {
    if (this.entry && Array.isArray(this.entry.selectableFields)) {
      return this.entry.selectableFields.slice();
    }
    return [];
  }

  // Supported formats.
  getFormats() {
    if (this.entry && Array.isArray(this.entry.formats)) {
      return this.entry.formats.slice();
    }
    return [];
  }

  // Auth requirement label.
  getAuth() {
    return this.entry && this.entry.auth != null
      ? String(this.entry.auth)
      : '';
  }

  // Whether the entity type is enabled in the registry.
  isEnabled() {
    return !!(this.entry && this.entry.enabled);
  }

  // Whether this entity's storage adapter is implemented. Mirrors
  // `storage.enabled` from entities.yaml. Only `file` is true (and even then
  // the adapter is not registered until Phase 2, so getStorage() still
  // returns NotImplementedStorage in Phase 1).
  isImplemented() {
    const storage = this.getStorageBlock();
    return !!(storage && storage.enabled);
  }

  // Whether this entity is read-only. Only `datastore`-backed entities are
  // writable; every other storage.type (jos.items/webcomponent/file/jos/
  // config) is read-only. This drives the save()/delete() guard on Entity.
  isReadOnly() {
    return this.getStorageType() !== 'datastore';
  }

  // Build/return the storage adapter for this definition. If the registry
  // injected a resolver and it returns an EntityStorage instance, use it;
  // otherwise return a NotImplementedStorage (the default for any unregistered
  // type).
  getStorage() {
    if (typeof this.storageResolver === 'function') {
      const adapter = this.storageResolver(this.getType());
      if (adapter instanceof EntityStorage) {
        return adapter;
      }
    }
    return new NotImplementedStorage(this.getType());
  }

  // Produce the descriptor object served by the /v1/entities endpoints.
  // Mirrors the entities.yaml entry 1:1 (extended EntityDescriptor shape),
  // with `name` included as a backward-compatible alias of `type`.
  toDescriptorArray() {
    const type = this.getType();
    const descriptor = {
      type: type,
      name: type,
      scope: this.getScope(),
      description: this.getDescription(),
      primaryKey: this.getPrimaryKey(),
      uniqueKeys: this.getUniqueKeys(),
      requiredFields: this.getRequiredFields(),
      storage: this.getStorageBlock(),
      supportedOperations: this.getSupportedOperations(),
      endpoints: this.getEndpoints(),
      formats: this.getFormats(),
      auth: this.getAuth(),
      enabled: this.isEnabled(),
    };
    // Optional list fields: only include when declared in entities.yaml so
    // the descriptor mirrors the registry entry exactly.
    const filterable = this.getFilterableFields();
    if (filterable.length > 0) {
      descriptor.filterableFields = filterable;
    }
    const sortable = this.getSortableFields();
    if (sortable.length > 0) {
      descriptor.sortableFields = sortable;
    }
    const selectable = this.getSelectableFields();
    if (selectable.length > 0) {
      descriptor.selectableFields = selectable;
    }
    return descriptor;
  }
}

module.exports = EntityDefinition;
