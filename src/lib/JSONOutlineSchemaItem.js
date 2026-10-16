const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { resolvePageLocation } = require('./pageLocation.js');
/**
 * JSONOutlineSchemaItem - a single item without an outline of items.
 */
class JSONOutlineSchemaItem
{
  /**
   * Establish defaults for a new item
   */
  constructor() {
    this.id = 'item-' + uuidv4();
    this.indent = 0;
    this.location = '';
    this.slug = '';
    this.order = 0;
    // top-level items have a null parent (JSON Outline Schema canonical form)
    this.parent = null;
    this.title = 'New item';
    this.description = '';
    this.metadata = {};
  }
  /**
   * Load data from the location specified
   */
  async readLocation(basePath = '') {
    // Security (review 2026-10): refuse locations that are not provably inside
    // basePath (NUL, `..` segments, symlink escapes). Mirrors PHP
    // JSONOutlineSchemaItem::readLocation (N1).
    if (resolvePageLocation(basePath, this.location, { mustExist: false }) === false) {
      return false;
    }
    if (fs.lstatSync(path.join(basePath, this.location)).isFile()) {
      return await fs.readFileSync(path.join(basePath, this.location),
        {encoding:'utf8', flag:'r'});
    }
    return false;
  }
  /**
   * Load data from the location specified
   */
  async writeLocation(body, basePath = '') {
    // ensure we have a blank set
    if (body == '') {
      body = '<p></p>';
    }
    // Security (review 2026-10): the destination must stay inside basePath.
    // Mirrors PHP JSONOutlineSchemaItem::writeLocation (N1).
    if (resolvePageLocation(basePath, this.location, { mustExist: false }) === false) {
      return false;
    }
    try {
      if (fs.lstatSync(path.join(basePath, this.location)).isFile()) {
        fs.writeFileSync(path.join(basePath, this.location), body);
      }
      return true;
    }
    catch(e) {
      return false;
    }
  }
}
module.exports = JSONOutlineSchemaItem;