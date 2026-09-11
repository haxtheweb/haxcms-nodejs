'use strict';

const EntityStorage = require('./EntityStorage.js');
const EntityStorageNotImplementedException = require('./EntityStorageNotImplementedException.js');

// Default storage adapter returned by EntityRegistry for any entity type
// whose real adapter is not registered.
//
// In Phase 1 NO real adapters are registered, so getStorage() for every type
// (including file) returns a NotImplementedStorage. load()/list()/save()/
// delete() all throw EntityStorageNotImplementedException.
//
// The entity DEFINITION still exists in entities.yaml (so getDefinition()
// works for every type); only the read/write adapter is reserved for a future
// phase. This keeps the EntityRegistry->getDefinition(type)->getStorage()
// chain uniform across all types.
class NotImplementedStorage extends EntityStorage {
  constructor(type = '') {
    super();
    this.type = String(type);
  }

  // The entity type this stub stands in for.
  getType() {
    return this.type;
  }

  load(key) {
    throw new EntityStorageNotImplementedException(this.type, 'load');
  }

  list(filters = {}) {
    throw new EntityStorageNotImplementedException(this.type, 'list');
  }

  save(entity) {
    throw new EntityStorageNotImplementedException(this.type, 'save');
  }

  delete(key) {
    throw new EntityStorageNotImplementedException(this.type, 'delete');
  }
}

module.exports = NotImplementedStorage;
