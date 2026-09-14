'use strict';

const Entity = require('./Entity.js');

// A single file entity record (Phase 2, issue #3043).
//
// Fields: uuid, path, name, mimetype, size, width, height, dateCreated,
// fullUrl, url. save()/delete() are inherited from Entity, which enforces
// the read-only guard (file is datastore => writable) and delegates to the
// FileStorage adapter registered on the EntityRegistry.
//
// Constructed by FileStorage.load() with the EntityDefinition for 'file'
// (so entity.save() resolves back to the same FileStorage via the
// definition's storage resolver).
class FileEntity extends Entity {
  // The stable files.json-sourced UUID.
  getUuid() {
    return this.get('uuid');
  }

  // The API path, e.g. 'files/banner.jpg'.
  getPath() {
    return this.get('path');
  }

  // The file name (basename of path).
  getName() {
    return this.get('name');
  }

  // The MIME type.
  getMimetype() {
    return this.get('mimetype');
  }

  // The file size in bytes (coerced to Number, null when absent).
  getSize() {
    const value = this.get('size');
    return value === null ? null : Number(value);
  }

  // Pixel width for images; null/0 for non-images.
  getWidth() {
    const value = this.get('width');
    return value === null ? null : Number(value);
  }

  // Pixel height for images; null/0 for non-images.
  getHeight() {
    const value = this.get('height');
    return value === null ? null : Number(value);
  }

  // Unix timestamp (seconds) of file creation/modification.
  getDateCreated() {
    const value = this.get('dateCreated');
    return value === null ? null : Number(value);
  }

  // The full URL (basePath + sitesDirectory + siteName + path).
  getFullUrl() {
    return this.get('fullUrl');
  }

  // The relative URL (same as path).
  getUrl() {
    return this.get('url');
  }

  // Whether this record represents an image (by mimetype prefix).
  // SVGs are excluded (they are not raster images).
  isImage() {
    const mimetype = String(this.getMimetype() || '');
    return (
      mimetype.indexOf('image/') === 0 && mimetype !== 'image/svg+xml'
    );
  }
}

module.exports = FileEntity;
