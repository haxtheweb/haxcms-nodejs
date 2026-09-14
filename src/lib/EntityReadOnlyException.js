'use strict';

// Thrown when save() or delete() is called on an Entity whose
// EntityDefinition is read-only (storage.type !== 'datastore').
//
// This enforces the #3043 "no datastore => can't save" rule per-type via the
// definition, not hardcoded: only `datastore`-backed entities are writable.
class EntityReadOnlyException extends Error {
  constructor(type = '', storageType = '') {
    type = String(type);
    storageType = String(storageType);
    let message = 'Entity "' + type + '" is read-only';
    if (storageType !== '') {
      message += ' (storage type: ' + storageType + ')';
    }
    message += '; only datastore-backed entities support save()/delete().';
    super(message);
    this.name = 'EntityReadOnlyException';
    this.entityType = type;
    this.storageType = storageType;
  }
}

module.exports = EntityReadOnlyException;
