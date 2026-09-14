'use strict';

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const EntityDefinition = require('./EntityDefinition.js');
const NotImplementedStorage = require('./NotImplementedStorage.js');

// Single entry point for the entity system. Loads the merged entities.yaml
// registry and serves definitions + storage adapters for every entity type
// (file, item, theme, skeleton, site, system).
//
// One instance serves both /x/api/v1/entities and /system/api/v1/entities:
// getDefinitions() is the data behind both endpoints (optionally filtered by
// ?scope=site|system). getDefinition(type) works for any type from any
// context because the registry merges all types across scopes.
//
// Adapter registration: registerStorage(type, adapter) wires a real storage
// adapter for a type. In Phase 1 NO adapters are registered, so getStorage()
// for every type (including file) returns a NotImplementedStorage. Phase 2
// registers FileStorage for 'file'; future phases register the read-only
// adapters for theme/skeleton/site/item/system.
class EntityRegistry {
  constructor(site, yamlPath) {
    this.site = site || null;
    this.definitions = {};
    this.adapters = {};
    this.load(yamlPath || null);
  }

  // Register a storage adapter for an entity type. Phase 2 registers
  // FileStorage for 'file'; future phases register the read-only adapters.
  registerStorage(type, adapter) {
    this.adapters[String(type)] = adapter;
  }

  // All entity definitions merged across scopes (file/item/theme/skeleton/
  // site/system). Optionally filtered by scope.
  getDefinitions(scope) {
    if (scope == null || scope === '') {
      return Object.keys(this.definitions).map((key) => this.definitions[key]);
    }
    const filterScope = String(scope);
    const out = [];
    const keys = Object.keys(this.definitions);
    for (let i = 0; i < keys.length; i++) {
      const definition = this.definitions[keys[i]];
      if (definition.getScope() === filterScope) {
        out.push(definition);
      }
    }
    return out;
  }

  // One definition by type. Works for any type from any context (merged).
  // Returns null when the type is not in the registry.
  getDefinition(type) {
    type = String(type);
    if (!Object.prototype.hasOwnProperty.call(this.definitions, type)) {
      return null;
    }
    return this.definitions[type];
  }

  // Shorthand for getDefinition(type).getStorage(). Returns the registered
  // adapter or a NotImplementedStorage when no adapter is registered (or when
  // the type itself is unknown).
  getStorage(type) {
    const definition = this.getDefinition(type);
    if (definition === null) {
      return new NotImplementedStorage(String(type));
    }
    return definition.getStorage();
  }

  // The site context passed at construction.
  getSite() {
    return this.site;
  }

  // Load and parse entities.yaml, building one EntityDefinition per entry
  // with a storage resolver bound to this registry's adapter map.
  load(yamlPath) {
    const resolvedPath = yamlPath
      ? String(yamlPath)
      : path.join(__dirname, 'entities.yaml');
    let contents = '';
    try {
      contents = fs.readFileSync(resolvedPath, 'utf8');
    } catch (e) {
      return;
    }
    if (!contents) {
      return;
    }
    let data = null;
    try {
      data = yaml.load(contents);
    } catch (e) {
      return;
    }
    if (!data || typeof data !== 'object' || !data.entities || typeof data.entities !== 'object') {
      return;
    }
    // Resolver bound to this registry: returns the registered adapter for a
    // type, or null (EntityDefinition then falls back to NotImplementedStorage).
    const self = this;
    const resolver = function (type) {
      type = String(type);
      if (Object.prototype.hasOwnProperty.call(self.adapters, type)) {
        return self.adapters[type];
      }
      return null;
    };
    const types = Object.keys(data.entities);
    for (let i = 0; i < types.length; i++) {
      const type = types[i];
      const entry = data.entities[type];
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      this.definitions[String(type)] = new EntityDefinition(entry, resolver);
    }
  }
}

module.exports = EntityRegistry;
