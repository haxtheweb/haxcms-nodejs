const fs = require('fs-extra');
const path = require('path');

const SUPPORTED_API_KEY_PROVIDERS = [
  'youtube',
  'vimeo',
  'giphy',
  'unsplash',
  'flickr',
  'anthropic',
];

function getApiKeysFilePath(haxcms) {
  const configDirectory = (
    haxcms &&
    typeof haxcms.configDirectory === 'string' &&
    haxcms.configDirectory
  ) ? haxcms.configDirectory : path.join(process.cwd(), '_config');
  return path.join(configDirectory, 'settings', 'apiKeys.json');
}

function normalizeApiKeyValue(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  return `${value}`.trim();
}

function normalizeApiKeys(input = {}) {
  const source = (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
  ) ? input : {};
  const normalized = {};
  for (let i = 0; i < SUPPORTED_API_KEY_PROVIDERS.length; i++) {
    const provider = SUPPORTED_API_KEY_PROVIDERS[i];
    normalized[provider] = normalizeApiKeyValue(source[provider]);
  }
  return normalized;
}

function hasSupportedApiKeyPayload(input = {}) {
  const source = (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
  ) ? input : {};
  for (let i = 0; i < SUPPORTED_API_KEY_PROVIDERS.length; i++) {
    const provider = SUPPORTED_API_KEY_PROVIDERS[i];
    if (Object.prototype.hasOwnProperty.call(source, provider)) {
      return true;
    }
  }
  return false;
}

async function readApiKeys(haxcms) {
  const filePath = getApiKeysFilePath(haxcms);
  let existing = {};
  if (await fs.pathExists(filePath)) {
    try {
      existing = JSON.parse(await fs.readFile(filePath, 'utf8'));
    }
    catch (e) {
      existing = {};
    }
  }
  return normalizeApiKeys(existing);
}

function readConfigApiKeys(haxcms) {
  if (
    !haxcms ||
    !haxcms.config ||
    !haxcms.config.appStore ||
    !haxcms.config.appStore.apiKeys
  ) {
    return normalizeApiKeys({});
  }
  return normalizeApiKeys(haxcms.config.appStore.apiKeys);
}

async function readEffectiveApiKeys(haxcms) {
  const configApiKeys = readConfigApiKeys(haxcms);
  const filePath = getApiKeysFilePath(haxcms);
  if (!(await fs.pathExists(filePath))) {
    return configApiKeys;
  }
  const fileApiKeys = await readApiKeys(haxcms);
  const mergedApiKeys = {
    ...configApiKeys,
  };
  for (let i = 0; i < SUPPORTED_API_KEY_PROVIDERS.length; i++) {
    const provider = SUPPORTED_API_KEY_PROVIDERS[i];
    const value = normalizeApiKeyValue(fileApiKeys[provider]);
    if (value !== '') {
      mergedApiKeys[provider] = value;
    }
  }
  return normalizeApiKeys(mergedApiKeys);
}

async function writeApiKeys(haxcms, keys = {}) {
  const filePath = getApiKeysFilePath(haxcms);
  const normalized = normalizeApiKeys(keys);
  await fs.ensureDir(path.dirname(filePath));
  const data = `${JSON.stringify(normalized, null, 2)}\n`;
  // Security (review 2026-10): apiKeys.json holds third-party API secrets but
  // was written with the default umask (usually 0644). Route it through the
  // same 0600 secret-file helpers as .pk/.rpk/.user, then chmod so a file
  // created by an older version is tightened too. Mirrors PHP
  // APIKeysService::writeAPIKeys SEC-10 (LOCK_EX + chmod 0600).
  if (haxcms && typeof haxcms.writeSecretFile === 'function') {
    haxcms.writeSecretFile(filePath, data);
  }
  else if (process.platform === 'win32') {
    await fs.writeFile(filePath, data, 'utf8');
  }
  else {
    await fs.writeFile(filePath, data, { encoding: 'utf8', mode: 0o600 });
  }
  if (haxcms && typeof haxcms.chmodSecretFile === 'function') {
    haxcms.chmodSecretFile(filePath);
  }
  else if (process.platform !== 'win32') {
    try {
      await fs.chmod(filePath, 0o600);
    }
    catch (e) {
      // non-fatal, same as HAXCMS.chmodSecretFile
    }
  }
  return normalized;
}

module.exports = {
  SUPPORTED_API_KEY_PROVIDERS,
  normalizeApiKeys,
  hasSupportedApiKeyPayload,
  readApiKeys,
  readConfigApiKeys,
  readEffectiveApiKeys,
  writeApiKeys,
  getApiKeysFilePath,
};
