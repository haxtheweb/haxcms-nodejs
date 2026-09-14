'use strict';

// Collection-access interface for one entity type.
//
// `load(key)` returns a single Entity by primary key; `list(filters)` returns
// many. Writable implementations (FileStorage, Phase 2) also implement
// save()/delete(); read-only / reserved implementations (NotImplementedStorage)
// throw EntityStorageNotImplementedException on every method.
//
// The primary key per type is declared in the entity's entities.yaml entry:
// uuid for file, element for theme, name for skeleton, metadata.site.name for
// site, id for item, name for system.
//
// In JS this "interface" is a base class whose default methods throw — concrete
// adapters extend it and override load/list/save/delete. EntityDefinition
// uses `instanceof EntityStorage` to verify a resolver-returned adapter.
class EntityStorage {
  load(/* key */) {
    throw new Error('EntityStorage.load() not implemented');
  }
  list(/* filters */) {
    throw new Error('EntityStorage.list() not implemented');
  }
  save(/* entity */) {
    throw new Error('EntityStorage.save() not implemented');
  }
  delete(/* key */) {
    throw new Error('EntityStorage.delete() not implemented');
  }
}

module.exports = EntityStorage;
