const fs = require('fs-extra');
const path = require('path');

/**
 * Canonical language registry for the backend.
 *
 * languages.json (src/coreConfig/languages.json) is a byte-identical copy of
 * the registry authored in webcomponents at
 * elements/i18n-manager/lib/languages.json, mirrored here the same way
 * themes.json is. The front end reads the same file, so the installer, the
 * Configuration panel, the site language field, the CLI and these routes all
 * agree on which languages exist.
 *
 * Entries are keyed by the canonical code that gets stored (en, sw, pt-BR,
 * zh-CN). An entry without `parent` is a language; one with `parent` is a
 * regional variant that resolves to its parent's translations. `locale` is the
 * translation file suffix (<namespace>.<locale>.json), so zh-CN loads zh files.
 */

const REGISTRY_PATH = path.join(__dirname, '..', 'coreConfig', 'languages.json');

let cache = null;

function prepare(data) {
  if (!data || typeof data !== 'object' || !data.languages) {
    throw new Error('language registry: missing languages');
  }
  const lookup = {};
  Object.keys(data.languages).forEach((code) => {
    lookup[code.toLowerCase()] = code;
  });
  // aliases never override a real code
  Object.keys(data.languages).forEach((code) => {
    (data.languages[code].aliases || []).forEach((alias) => {
      const key = String(alias).toLowerCase();
      if (!lookup[key]) {
        lookup[key] = code;
      }
    });
  });
  return { languages: data.languages, lookup };
}

/**
 * Load (once) and return { languages, lookup }. Pass a parsed registry to
 * use it instead of the file (tests).
 */
function getLanguageRegistry(data) {
  if (data) {
    return prepare(data);
  }
  if (!cache) {
    cache = prepare(fs.readJsonSync(REGISTRY_PATH));
  }
  return cache;
}

/**
 * Forget the cached file (tests)
 */
function resetLanguageRegistry() {
  cache = null;
}

/**
 * The registry code a value is exactly, or an alias of, ignoring case and
 * `_` vs `-` (zh_CN, ZH-cn and the alias zh all give zh-CN). Never drops a
 * region, so a well-formed code the registry does not list (fr-CA) gives null.
 * @returns {string|null}
 */
function matchLanguageCode(value, registry) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const { languages, lookup } = getLanguageRegistry(registry);
  const cleaned = value.trim().replace(/_/g, '-').toLowerCase();
  const code = lookup[cleaned];
  return code && languages[code] ? code : null;
}

/**
 * Registry entry for a code or alias, with its canonical `code`
 * @returns {object|null}
 */
function getLanguage(value, registry) {
  const code = matchLanguageCode(value, registry);
  if (!code) {
    return null;
  }
  const { languages } = getLanguageRegistry(registry);
  return { code, ...languages[code] };
}

/**
 * All entries, sorted by English name.
 * @param {string} regions all (default) | featured | none: which regional
 * variants (en-GB, pt-BR...) to include
 */
function listLanguages(regions = 'all', registry) {
  const { languages } = getLanguageRegistry(registry);
  return Object.keys(languages)
    .filter((code) => {
      const entry = languages[code];
      if (!entry.parent) {
        return true;
      }
      if (regions === 'none') {
        return false;
      }
      return regions === 'featured' ? entry.featured === true : true;
    })
    .map((code) => ({ code, ...languages[code] }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

module.exports = {
  REGISTRY_PATH,
  getLanguageRegistry,
  resetLanguageRegistry,
  matchLanguageCode,
  getLanguage,
  listLanguages,
};
