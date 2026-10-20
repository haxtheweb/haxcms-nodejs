const fs = require('fs-extra');
const path = require('path');

// where the front end build keeps every element's locales/ folder
const DEFAULT_PACKAGES_ROOT = path.join(
  __dirname,
  '..',
  'public',
  'build',
  'es6',
  'node_modules',
  '@haxtheweb',
);

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Is this a name that is safe to compare against file names? Used for the
 * namespace filter; it is never joined onto a path.
 */
function isSafeName(value) {
  return typeof value === 'string' && value.length <= 200 && SAFE_NAME.test(value);
}

/**
 * Collect the translated strings for one language across every element.
 *
 * Translation files are <namespace>.<locale>.json inside each package's
 * locales/ folder. Namespaces ending in `.haxProperties` hold the editor
 * (HAX schema) strings; everything else is UI strings.
 *
 * @param {object} options
 * @param {string} options.locale translation file suffix (registry `locale`)
 * @param {string} [options.namespace] only this element, e.g. video-player
 *   (matches both its UI and its .haxProperties files)
 * @param {string} [options.type] ui | schema | all (default all)
 * @param {string} [options.packagesRoot] folder holding the packages
 * @returns {Promise<{count: number, namespaces: object}>}
 */
async function collectTranslations({
  locale,
  namespace = '',
  type = 'all',
  packagesRoot = DEFAULT_PACKAGES_ROOT,
}) {
  const result = { count: 0, namespaces: {} };
  if (!isSafeName(locale) || !(await fs.pathExists(packagesRoot))) {
    return result;
  }
  const suffix = `.${locale}.json`;
  const packages = (await fs.readdir(packagesRoot)).sort();
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    const localesDir = path.join(packagesRoot, pkg, 'locales');
    let files = [];
    try {
      files = await fs.readdir(localesDir);
    }
    catch (e) {
      continue;
    }
    files.sort();
    for (let j = 0; j < files.length; j++) {
      const file = files[j];
      if (!file.endsWith(suffix)) {
        continue;
      }
      const key = file.slice(0, -suffix.length);
      if (!key) {
        continue;
      }
      const isSchema = key.endsWith('.haxProperties');
      if (type === 'ui' && isSchema) {
        continue;
      }
      if (type === 'schema' && !isSchema) {
        continue;
      }
      const base = isSchema ? key.slice(0, -'.haxProperties'.length) : key;
      if (namespace && base !== namespace) {
        continue;
      }
      let strings = null;
      try {
        strings = JSON.parse(await fs.readFile(path.join(localesDir, file), 'utf8'));
      }
      catch (e) {
        continue;
      }
      if (!strings || typeof strings !== 'object' || Array.isArray(strings)) {
        continue;
      }
      result.namespaces[key] = {
        namespace: base,
        package: `@haxtheweb/${pkg}`,
        type: isSchema ? 'schema' : 'ui',
        file,
        strings,
      };
      result.count++;
    }
  }
  return result;
}

module.exports = {
  DEFAULT_PACKAGES_ROOT,
  isSafeName,
  collectTranslations,
};
