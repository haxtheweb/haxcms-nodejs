const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { resolveContainedPath } = require('./pathConfinement.js');
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
    // Security (N1/N5 parity): the location must resolve inside basePath.
    // Rejects NUL bytes and `..` segments, then proves realpath containment
    // (mirrors PHP JSONOutlineSchemaItem::readLocation).
    const resolved = resolveContainedPath(basePath, this.location);
    if (resolved === false) {
      return false;
    }
    // a missing file returns false (PHP parity) rather than throwing
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isFile()) {
      return await fs.readFileSync(resolved,
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
    try {
      // Security (N1/N5 parity): the destination must stay inside basePath
      // (mirrors PHP JSONOutlineSchemaItem::writeLocation).
      const resolved = resolveContainedPath(basePath, this.location);
      if (resolved === false) {
        return false;
      }
      if (fs.lstatSync(resolved).isFile()) {
        fs.writeFileSync(resolved, body);
      }
      return true;
    }
    catch {
      return false;
    }
  }
}
module.exports = JSONOutlineSchemaItem;
