const fs = require("fs-extra");
const path = require("path");

const MIN_JPEG_QUALITY = 1;
const MAX_JPEG_QUALITY = 100;
const MIN_UPLOAD_SIZE_MB = 1;
const MAX_UPLOAD_SIZE_MB = 10240;
const DEFAULT_JPEG_QUALITY = 80;
// Security: 256 MB default upload cap (was 1 GB). Operators can raise it via
// settings/media.json (maxUploadSizeMb, up to MAX_UPLOAD_SIZE_MB) when a
// deployment really needs larger media files.
const DEFAULT_MAX_UPLOAD_SIZE_MB = 256;
// haxtheweb/issues#3054: every format HAXcms can safely store (the
// HAXCMSFile upload allowlist). acceptedFormats narrows uploads within this
// list; a format outside it is never accepted, whatever the setting says.
const SAFE_UPLOAD_FORMATS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webm",
  "webp",
  "mp4",
  "mp3",
  "mov",
  "csv",
  "ppt",
  "pptx",
  "xlsx",
  "doc",
  "xls",
  "docx",
  "pdf",
  "rtf",
  "txt",
  "vtt",
  "html",
  "md",
  "xml",
  "ics",
  "vcf",
  "h5p",
];
const DEFAULT_ACCEPTED_FORMATS = SAFE_UPLOAD_FORMATS.join(",");
// defaults earlier releases stored or showed while the setting was not yet
// applied to uploads; a saved copy of one means "not chosen", so it reads as
// the default instead of suddenly blocking documents and media
const LEGACY_DEFAULT_ACCEPTED_FORMATS = [
  "jpg,jpeg,png,gif,webp,svg",
  "jpg,jpeg,png,webp,gif",
];
const DEFAULT_MEDIA_SETTINGS = {
  jpegQuality: DEFAULT_JPEG_QUALITY,
  maxUploadSizeMb: DEFAULT_MAX_UPLOAD_SIZE_MB,
  acceptedFormats: DEFAULT_ACCEPTED_FORMATS,
};

function getMediaSettingsFilePath(haxcms) {
  const configDirectory =
    haxcms &&
    typeof haxcms.configDirectory === "string" &&
    haxcms.configDirectory
      ? haxcms.configDirectory
      : path.join(process.cwd(), "_config");
  return path.join(configDirectory, "settings", "media.json");
}

function normalizeJpegQuality(value) {
  if (value === null || typeof value === "undefined" || value === "") {
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
  if (value === null || typeof value === "undefined" || value === "") {
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
  if (value === null || typeof value === "undefined") {
    return null;
  }
  let candidates = [];
  if (Array.isArray(value)) {
    candidates = value;
  } else if (typeof value === "string") {
    candidates = value.split(",");
  } else {
    return null;
  }
  const seen = {};
  const normalized = [];
  for (let i = 0; i < candidates.length; i++) {
    const format = `${candidates[i] || ""}`
      .trim()
      .toLowerCase()
      .replace(/^\.+/, "");
    if (!format || !/^[a-z0-9]+$/.test(format) || seen[format]) {
      continue;
    }
    seen[format] = true;
    normalized.push(format);
  }
  if (normalized.length === 0) {
    return null;
  }
  return normalized.join(",");
}

function normalizeMediaSettings(input = {}) {
  const source =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    jpegQuality: normalizeJpegQuality(source.jpegQuality),
    maxUploadSizeMb: normalizeMaxUploadSizeMb(source.maxUploadSizeMb),
    acceptedFormats: normalizeAcceptedFormats(source.acceptedFormats),
  };
}

function getEffectiveMediaSettings(settings = {}) {
  const source =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? settings
      : {};
  return {
    jpegQuality:
      source.jpegQuality == null ? DEFAULT_JPEG_QUALITY : source.jpegQuality,
    maxUploadSizeMb:
      source.maxUploadSizeMb == null
        ? DEFAULT_MAX_UPLOAD_SIZE_MB
        : source.maxUploadSizeMb,
    acceptedFormats:
      source.acceptedFormats == null ||
      LEGACY_DEFAULT_ACCEPTED_FORMATS.indexOf(source.acceptedFormats) !== -1
        ? DEFAULT_ACCEPTED_FORMATS
        : source.acceptedFormats,
  };
}

/**
 * Whether an upload with this extension is accepted: it must be a safe
 * format, and one the media settings accept (haxtheweb/issues#3054).
 * @param {object} settings readMediaSettings() result
 * @param {string} extension file extension, with or without the dot
 * @returns {boolean}
 */
function isUploadFormatAccepted(settings, extension) {
  const format = `${extension || ""}`.trim().toLowerCase().replace(/^\.+/, "");
  if (SAFE_UPLOAD_FORMATS.indexOf(format) === -1) {
    return false;
  }
  const accepted = getEffectiveMediaSettings(settings).acceptedFormats;
  return `${accepted}`.split(",").indexOf(format) !== -1;
}

function hasSupportedMediaSettingsPayload(input = {}) {
  const source =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return (
    Object.prototype.hasOwnProperty.call(source, "jpegQuality") ||
    Object.prototype.hasOwnProperty.call(source, "maxUploadSizeMb") ||
    Object.prototype.hasOwnProperty.call(source, "acceptedFormats")
  );
}

async function readMediaSettings(haxcms) {
  const filePath = getMediaSettingsFilePath(haxcms);
  let existing = {};
  if (await fs.pathExists(filePath)) {
    try {
      existing = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      existing = {};
    }
  }
  return normalizeMediaSettings(existing);
}

async function writeMediaSettings(haxcms, settings = {}) {
  const filePath = getMediaSettingsFilePath(haxcms);
  const source =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? settings
      : {};
  const nextSettings = await readMediaSettings(haxcms);
  if (Object.prototype.hasOwnProperty.call(source, "jpegQuality")) {
    nextSettings.jpegQuality = normalizeJpegQuality(source.jpegQuality);
  }
  if (Object.prototype.hasOwnProperty.call(source, "maxUploadSizeMb")) {
    nextSettings.maxUploadSizeMb = normalizeMaxUploadSizeMb(
      source.maxUploadSizeMb,
    );
  }
  if (Object.prototype.hasOwnProperty.call(source, "acceptedFormats")) {
    nextSettings.acceptedFormats = normalizeAcceptedFormats(
      source.acceptedFormats,
    );
  }
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(
    filePath,
    `${JSON.stringify(nextSettings, null, 2)}\n`,
    "utf8",
  );
  return nextSettings;
}

module.exports = {
  getMediaSettingsFilePath,
  normalizeJpegQuality,
  normalizeMaxUploadSizeMb,
  normalizeAcceptedFormats,
  normalizeMediaSettings,
  getEffectiveMediaSettings,
  isUploadFormatAccepted,
  SAFE_UPLOAD_FORMATS,
  DEFAULT_ACCEPTED_FORMATS,
  DEFAULT_MEDIA_SETTINGS,
  hasSupportedMediaSettingsPayload,
  readMediaSettings,
  writeMediaSettings,
};
