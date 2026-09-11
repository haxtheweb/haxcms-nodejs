'use strict';

const EntityReadOnlyException = require('./EntityReadOnlyException.js');

// A single loaded entity record with instance-level save()/delete().
//
// Holds its type, primary-key value, all record fields, and a back-reference
// to its EntityDefinition. save()/delete() enforce the #3043
// "no datastore => can't save" rule per-type via the definition: they throw
// EntityReadOnlyException when definition.isReadOnly() (storage.type !==
// 'datastore'), and otherwise delegate to the storage adapter.
//
// Concrete subclasses (FileEntity in Phase 2) add typed field accessors; the
// base is abstract because a record always has a concrete type. In JS the
// "abstract" nature is by convention — the base is usable directly for
// testing the save()/delete() guards (matching the PHP test entity subclass).
class Entity {
  constructor(definition, fields) {
    this.definition = definition;
    this.fields = fields || {};
  }

  getDefinition() {
    return this.definition;
  }

  // The entity type.
  getType() {
    return this.definition.getType();
  }

  // The full record field map.
  getFields() {
    return this.fields;
  }

  // Get one field value (or null if absent).
  get(name) {
    name = String(name);
    if (this.fields && Object.prototype.hasOwnProperty.call(this.fields, name)) {
      return this.fields[name];
    }
    return null;
  }

  // Set one field value (in-memory; persisted only on save()).
  set(name, value) {
    if (!this.fields) {
      this.fields = {};
    }
    this.fields[String(name)] = value;
  }

  // The primary-key value (fields[definition.primaryKey]).
  getPrimaryKeyValue() {
    const pk = this.definition.getPrimaryKey();
    if (pk === '' || !pk) {
      return null;
    }
    if (this.fields && Object.prototype.hasOwnProperty.call(this.fields, pk)) {
      return this.fields[pk];
    }
    return null;
  }

  // Persist (upsert) this record. Throws EntityReadOnlyException when the
  // definition is read-only (non-datastore); otherwise delegates to the
  // storage adapter's save(). In Phase 1 every storage is a
  // NotImplementedStorage, so even a writable (datastore) entity's save()
  // surfaces EntityStorageNotImplementedException until Phase 2 registers the
  // real FileStorage adapter.
  save() {
    if (this.definition.isReadOnly()) {
      throw new EntityReadOnlyException(
        this.definition.getType(),
        this.definition.getStorageType(),
      );
    }
    const storage = this.definition.getStorage();
    storage.save(this);
  }

  // Delete this record. Same read-only guard as save(); otherwise delegates
  // to the storage adapter's delete() with the primary-key value.
  delete() {
    if (this.definition.isReadOnly()) {
      throw new EntityReadOnlyException(
        this.definition.getType(),
        this.definition.getStorageType(),
      );
    }
    const storage = this.definition.getStorage();
    storage.delete(this.getPrimaryKeyValue());
  }
}

module.exports = Entity;
