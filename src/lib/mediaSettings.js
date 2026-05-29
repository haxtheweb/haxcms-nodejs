const fs = require('fs-extra');
const path = require('path');

const MIN_JPEG_QUALITY = 1;
const MAX_JPEG_QUALITY = 100;
const MIN_UPLOAD_SIZE_MB = 1;
const MAX_UPLOAD_SIZE_MB = 10240;

function getMediaSettingsFilePath(haxcms) {
  const configDirectory = (
    haxcms &&
    typeof haxcms.configDirectory === 'string' &&
    haxcms.configDirectory
  ) ? haxcms.configDirectory : path.join(process.cwd(), '_config');
  return path.join(configDirectory, 'settings', 'media.json');
}

function normalizeJpegQuality(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }
  const parsedValue = parseInt(value, 10);
  if (Number.isNaN(parsedValue)) {
    return null;
  }
  if (parsedValue < MIN_JPEG_QUALITY) {
    return MIN_JPEG_QUALITY;
  }
  if (parsedValue > MAX_JPEG_QUALITY) {
    return MAX_JPEG_QUALITY;
  }
  return parsedValue;
}
function normalizeMaxUploadSizeMb(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }
  const parsedValue = parseInt(value, 10);
  if (Number.isNaN(parsedValue)) {
    return null;
  }
  if (parsedValue < MIN_UPLOAD_SIZE_MB) {
    return MIN_UPLOAD_SIZE_MB;
  }
  if (parsedValue > MAX_UPLOAD_SIZE_MB) {
    return MAX_UPLOAD_SIZE_MB;
  }
  return parsedValue;
}
function normalizeAcceptedFormats(value) {
  if (value === null || typeof value === 'undefined') {
    return null;
  }
  let candidates = [];
  if (Array.isArray(value)) {
    candidates = value;
  }
  else if (typeof value === 'string') {
    candidates = value.split(',');
  }
  else {
    return null;
  }
  const seen = {};
  const normalized = [];
  for (let i = 0; i < candidates.length; i++) {
    const format = `${candidates[i] || ''}`
      .trim()
      .toLowerCase()
      .replace(/^\.+/, '');
    if (!format || !/^[a-z0-9]+$/.test(format) || seen[format]) {
      continue;
    }
    seen[format] = true;
    normalized.push(format);
  }
  if (normalized.length === 0) {
    return null;
  }
  return normalized.join(',');
}

function normalizeMediaSettings(input = {}) {
  const source = (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
  ) ? input : {};
  return {
    jpegQuality: normalizeJpegQuality(source.jpegQuality),
    maxUploadSizeMb: normalizeMaxUploadSizeMb(source.maxUploadSizeMb),
    acceptedFormats: normalizeAcceptedFormats(source.acceptedFormats),
  };
}

function hasSupportedMediaSettingsPayload(input = {}) {
  const source = (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
  ) ? input : {};
  return (
    Object.prototype.hasOwnProperty.call(source, 'jpegQuality') ||
    Object.prototype.hasOwnProperty.call(source, 'maxUploadSizeMb') ||
    Object.prototype.hasOwnProperty.call(source, 'acceptedFormats')
  );
}

async function readMediaSettings(haxcms) {
  const filePath = getMediaSettingsFilePath(haxcms);
  let existing = {};
  if (await fs.pathExists(filePath)) {
    try {
      existing = JSON.parse(await fs.readFile(filePath, 'utf8'));
    }
    catch (e) {
      existing = {};
    }
  }
  return normalizeMediaSettings(existing);
}

async function writeMediaSettings(haxcms, settings = {}) {
  const filePath = getMediaSettingsFilePath(haxcms);
  const source = (
    settings &&
    typeof settings === 'object' &&
    !Array.isArray(settings)
  ) ? settings : {};
  const nextSettings = await readMediaSettings(haxcms);
  if (Object.prototype.hasOwnProperty.call(source, 'jpegQuality')) {
    nextSettings.jpegQuality = normalizeJpegQuality(source.jpegQuality);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'maxUploadSizeMb')) {
    nextSettings.maxUploadSizeMb = normalizeMaxUploadSizeMb(
      source.maxUploadSizeMb,
    );
  }
  if (Object.prototype.hasOwnProperty.call(source, 'acceptedFormats')) {
    nextSettings.acceptedFormats = normalizeAcceptedFormats(
      source.acceptedFormats,
    );
  }
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(
    filePath,
    `${JSON.stringify(nextSettings, null, 2)}\n`,
    'utf8',
  );
  return nextSettings;
}

module.exports = {
  getMediaSettingsFilePath,
  normalizeJpegQuality,
  normalizeMaxUploadSizeMb,
  normalizeAcceptedFormats,
  normalizeMediaSettings,
  hasSupportedMediaSettingsPayload,
  readMediaSettings,
  writeMediaSettings,
};
