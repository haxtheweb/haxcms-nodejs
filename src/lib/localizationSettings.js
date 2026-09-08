const fs = require('fs-extra');
const path = require('path');

const DEFAULT_LANGUAGE = 'en-US';
const BCP47_LANGUAGE_REGEX = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/;
const DEFAULT_LOCALIZATION_SETTINGS = {
  defaultLanguage: DEFAULT_LANGUAGE,
};

function getLocalizationSettingsFilePath(haxcms) {
  const configDirectory = (
    haxcms &&
    typeof haxcms.configDirectory === 'string' &&
    haxcms.configDirectory
  ) ? haxcms.configDirectory : path.join(process.cwd(), '_config');
  return path.join(configDirectory, 'config.json');
}

function normalizeDefaultLanguage(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    value = String(value);
  }
  value = value.trim();
  if (value === '') {
    return null;
  }
  if (!BCP47_LANGUAGE_REGEX.test(value)) {
    return null;
  }
  const parts = value.split('-');
  const primary = parts[0].toLowerCase();
  if (parts.length > 1 && parts[1] !== '') {
    const region = parts[1].toUpperCase();
    return primary + '-' + region;
  }
  return primary;
}

function normalizeLocalizationSettings(input = {}) {
  const source = (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
  ) ? input : {};
  return {
    defaultLanguage: normalizeDefaultLanguage(source.defaultLanguage),
  };
}

function getEffectiveLocalizationSettings(settings = {}) {
  const source = (
    settings &&
    typeof settings === 'object' &&
    !Array.isArray(settings)
  ) ? settings : {};
  return {
    defaultLanguage: source.defaultLanguage == null ? DEFAULT_LANGUAGE : source.defaultLanguage,
  };
}

function hasSupportedLocalizationSettingsPayload(input = {}) {
  const source = (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
  ) ? input : {};
  return Object.prototype.hasOwnProperty.call(source, 'defaultLanguage');
}

function isValidDefaultLanguagePayloadValue(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return true;
  }
  return normalizeDefaultLanguage(value) !== null;
}

async function readLocalizationSettings(haxcms) {
  const filePath = getLocalizationSettingsFilePath(haxcms);
  let localizationBlock = {};
  if (await fs.pathExists(filePath)) {
    try {
      const fullConfig = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (
        fullConfig &&
        typeof fullConfig === 'object' &&
        !Array.isArray(fullConfig) &&
        fullConfig.localization
      ) {
        localizationBlock = fullConfig.localization;
      }
    }
    catch (e) {
      localizationBlock = {};
    }
  }
  return normalizeLocalizationSettings(localizationBlock);
}

async function writeLocalizationSettings(haxcms, settings = {}) {
  const filePath = getLocalizationSettingsFilePath(haxcms);
  const source = (
    settings &&
    typeof settings === 'object' &&
    !Array.isArray(settings)
  ) ? settings : {};
  let fullConfig = {};
  if (await fs.pathExists(filePath)) {
    try {
      fullConfig = JSON.parse(await fs.readFile(filePath, 'utf8'));
    }
    catch (e) {
      fullConfig = {};
    }
  }
  if (!fullConfig || typeof fullConfig !== 'object' || Array.isArray(fullConfig)) {
    fullConfig = {};
  }
  const existingLocalization = (
    fullConfig.localization &&
    typeof fullConfig.localization === 'object' &&
    !Array.isArray(fullConfig.localization)
  ) ? fullConfig.localization : {};
  const nextSettings = normalizeLocalizationSettings(existingLocalization);
  if (Object.prototype.hasOwnProperty.call(source, 'defaultLanguage')) {
    nextSettings.defaultLanguage = normalizeDefaultLanguage(source.defaultLanguage);
  }
  fullConfig.localization = nextSettings;
  await fs.writeFile(
    filePath,
    `${JSON.stringify(fullConfig, null, 2)}\n`,
    'utf8',
  );
  if (haxcms && haxcms.config && typeof haxcms.config === 'object') {
    haxcms.config.localization = nextSettings;
  }
  return nextSettings;
}

module.exports = {
  getLocalizationSettingsFilePath,
  normalizeDefaultLanguage,
  normalizeLocalizationSettings,
  getEffectiveLocalizationSettings,
  hasSupportedLocalizationSettingsPayload,
  isValidDefaultLanguagePayloadValue,
  DEFAULT_LOCALIZATION_SETTINGS,
  readLocalizationSettings,
  writeLocalizationSettings,
};
