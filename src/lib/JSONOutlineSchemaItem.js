const fs = require('fs-extra');
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
    // Security (SEC-PATH), PHP parity: the location must resolve inside basePath.
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
      // Security (SEC-PATH), PHP parity: the destination must stay inside basePath
      // (mirrors PHP JSONOutlineSchemaItem::writeLocation).
      const resolved = resolveContainedPath(basePath, this.location);
      if (resolved === false) {
        return false;
      }
      // a page location names a file, never a folder
      const last = this.location.charAt(this.location.length - 1);
      if (last === "/" || last === "\\") {
        return false;
      }
      // a page is a regular file: an existing one is overwritten, a missing
      // one is created when its folder exists (no folders are made here).
      // Anything else at the location (a directory, a dangling symlink) is
      // not written and answers false.
      const existing = fs.lstatSync(resolved, { throwIfNoEntry: false });
      if (existing && !existing.isFile()) {
        return false;
      }
      fs.writeFileSync(resolved, body);
      return true;
    }
    catch {
      return false;
    }
  }
}
module.exports = JSONOutlineSchemaItem;
