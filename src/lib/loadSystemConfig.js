const fs = require('fs');
const path = require('path');

const BOILERPLATE_CONFIG = path.join(
  __dirname,
  '..',
  'boilerplate',
  'systemsetup',
  'config.json',
);

/**
 * Last-resort config shape, used only if even the shipped boilerplate cannot be
 * read. Deliberately minimal: the HAXCMS constructor fills in the rest, and
 * `mcp` is closed by default so a degraded boot never opens more surface than a
 * healthy one.
 */
function minimalConfig() {
  return {
    themes: {},
    security: {},
    site: { settings: {}, git: {}, static: {}, publishers: {} },
    mcp: { enabled: false, readOnly: true },
  };
}

function isPlainObject(value) {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value)
  );
}

/**
 * Read the system config.json defensively.
 *
 * The three failure modes are handled separately because they need different
 * responses:
 *
 * - missing   -> restore the boilerplate onto disk (best effort; a read-only
 *                config directory must not brick startup)
 * - empty     -> fall back in memory
 * - corrupt   -> fall back in memory and LEAVE THE FILE ALONE. It may be a
 *                symlink to a shared config holding hand edits (API keys,
 *                themes); overwriting it with boilerplate would destroy them.
 *                The log tells the admin what to fix.
 *
 * The returned config is never null, so downstream property access in the
 * HAXCMS constructor cannot fatal.
 *
 * @param {string} configDirectory directory expected to hold config.json
 * @param {object} [options]
 * @param {string} [options.boilerplatePath] override for tests
 * @param {function} [options.log] override for tests, defaults to console.error
 * @returns {{config: object, source: 'file'|'boilerplate'|'minimal', reason: string|null}}
 */
function loadSystemConfig(configDirectory, options = {}) {
  const boilerplatePath = options.boilerplatePath || BOILERPLATE_CONFIG;
  const log = options.log || console.error;
  const configPath = path.join(configDirectory, 'config.json');

  let reason = null;

  // self healing if config is missing; best effort, a read-only directory is
  // not fatal because the in-memory fallback below covers it
  if (!fs.existsSync(configPath)) {
    reason = 'missing';
    try {
      fs.copyFileSync(boilerplatePath, configPath);
      reason = null;
    }
    catch (e) {
      log(
        `HAXcms: config.json was missing and could not be restored (${e.code || e.message}). Continuing with in-memory defaults.`,
      );
    }
  }

  if (reason === null) {
    let raw = null;
    try {
      raw = fs.readFileSync(configPath, { encoding: 'utf8', flag: 'r' });
    }
    catch (e) {
      reason = 'unreadable';
      log(
        `HAXcms: config.json could not be read (${e.code || e.message}). Continuing with in-memory defaults.`,
      );
    }

    if (raw !== null) {
      if (raw.trim() === '') {
        reason = 'empty';
        log(
          'HAXcms: config.json is empty. Continuing with in-memory defaults; delete the file to have it restored from boilerplate.',
        );
      }
      else {
        try {
          const parsed = JSON.parse(raw);
          if (isPlainObject(parsed)) {
            return { config: parsed, source: 'file', reason: null };
          }
          reason = 'not-an-object';
          log(
            'HAXcms: config.json did not contain a JSON object. Continuing with in-memory defaults; the file was left untouched.',
          );
        }
        catch (e) {
          reason = 'corrupt';
          log(
            `HAXcms: config.json could not be parsed (${e.message}). Continuing with in-memory defaults; the file was left untouched so any hand edits are preserved.`,
          );
        }
      }
    }
  }

  // never leave config null: fall back to the shipped boilerplate in memory
  try {
    const fallback = JSON.parse(fs.readFileSync(boilerplatePath, 'utf8'));
    if (isPlainObject(fallback)) {
      // The boilerplate ships deploymentProfile: self-hosted-multi-site, which
      // is correct for a fresh multi-site install but wrong to assume during a
      // degraded boot -- it would enable MCP and relax IAM tenant checks on a
      // single-site or IAM deployment. Dropping it lets the constructor derive
      // the profile from the real operating context instead.
      delete fallback.deploymentProfile;
      return { config: fallback, source: 'boilerplate', reason };
    }
  }
  catch (e) {
    log(
      `HAXcms: boilerplate config.json is unusable (${e.code || e.message}). Falling back to minimal defaults.`,
    );
  }

  return { config: minimalConfig(), source: 'minimal', reason };
}

module.exports = { loadSystemConfig, minimalConfig, BOILERPLATE_CONFIG };
