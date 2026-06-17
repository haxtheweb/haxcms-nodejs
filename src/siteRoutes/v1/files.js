const path = require('path');
const fs = require('fs-extra');
const mime = require('mime');
const sharp = require('sharp');
const crypto = require('crypto');
const { HAXCMS } = require('../../lib/HAXCMS.js');
const HAXCMSFile = require('../../lib/HAXCMSFile.js');
const { readMediaSettings } = require('../../lib/mediaSettings.js');
const {
  platformAllows,
  featureDisabledResponse,
} = require('../../lib/platformFeatures.js');
const {
  getApiBasePath,
  getCsvQuery,
  getQueryValue,
  sortRecords,
  paginateRecords,
  projectRecord,
  projectCollection,
  resolveSiteForRequest,
  collectSiteFiles,
  normalizePathForResponse,
  sendFormattedResponse,
  ensureRequestBodyObject,
  ensureRequestQueryObject,
  decodePathToken,
  normalizeOperationName,
  isSiteApiRequestAuthenticated,
} = require('./siteRouteUtils.js');

const IMAGE_SCALE_PRESETS = {
  xs: { width: 200, height: 150 },
  sm: { width: 320, height: 240 },
  md: { width: 400, height: 300 },
  lg: { width: 800, height: 600 },
  xl: { width: 1200, height: 900 },
};
const DEFAULT_SCALE_PRESET = 'md';
const DEFAULT_JPEG_QUALITY = 90;
const MIN_JPEG_QUALITY = 1;
const MAX_JPEG_QUALITY = 100;
const ALLOWED_RENAME_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webm',
  'webp',
  'mp4',
  'mp3',
  'mov',
  'csv',
  'ppt',
  'pptx',
  'xlsx',
  'doc',
  'xls',
  'docx',
  'pdf',
  'rtf',
  'txt',
  'vtt',
  'html',
  'md',
];

function isMultisiteContext(site) {
  if (HAXCMS.runtimeServerMode === 'single-site') {
    return false;
  }
  if (HAXCMS.runtimeServerMode === 'multisite') {
    return true;
  }
  if (HAXCMS.operatingContext === 'multisite') {
    return true;
  }
  if (
    typeof HAXCMS.getDeploymentProfile === 'function' &&
    HAXCMS.getDeploymentProfile() === 'self-hosted-multi-site'
  ) {
    return true;
  }
  if (site && typeof site.basePath === 'string' && site.basePath) {
    const basePath = normalizePathForResponse(site.basePath);
    const sitesDir = normalizePathForResponse(HAXCMS.sitesDirectory);
    if (basePath.indexOf('/' + sitesDir + '/') !== -1) {
      return true;
    }
  }
  return false;
}

function buildFilePublicUrl(site, relativeFilePath) {
  const normalizedRelativePath = normalizePathForResponse(relativeFilePath).replace(
    /^\/+/,
    '',
  );
  let fullUrl = '/' + normalizedRelativePath;
  if (isMultisiteContext(site)) {
    fullUrl =
      HAXCMS.basePath +
      HAXCMS.sitesDirectory +
      '/' +
      site.manifest.metadata.site.name +
      '/' +
      normalizedRelativePath;
  }
  return fullUrl;
}

function getDateCreatedValue(entryStats) {
  if (!entryStats || typeof entryStats !== 'object') {
    return 0;
  }
  let createdMs = 0;
  if (
    typeof entryStats.mtimeMs === 'number' &&
    Number.isFinite(entryStats.mtimeMs) &&
    entryStats.mtimeMs > 0
  ) {
    createdMs = entryStats.mtimeMs;
  }
  else if (
    typeof entryStats.ctimeMs === 'number' &&
    Number.isFinite(entryStats.ctimeMs) &&
    entryStats.ctimeMs > 0
  ) {
    createdMs = entryStats.ctimeMs;
  }
  else if (
    typeof entryStats.birthtimeMs === 'number' &&
    Number.isFinite(entryStats.birthtimeMs) &&
    entryStats.birthtimeMs > 0
  ) {
    createdMs = entryStats.birthtimeMs;
  }
  if (createdMs <= 0) {
    return 0;
  }
  return Math.round(createdMs);
}

function getSiteNameForFileUuid(site) {
  if (
    site &&
    site.manifest &&
    site.manifest.metadata &&
    site.manifest.metadata.site &&
    site.manifest.metadata.site.name
  ) {
    return String(site.manifest.metadata.site.name);
  }
  if (site && site.name) {
    return String(site.name);
  }
  return 'site';
}

function getCanonicalFilePathForUuid(relativePath) {
  const normalizedPath = normalizePathForResponse(relativePath || '').replace(
    /^\/+/,
    '',
  );
  if (normalizedPath.indexOf('files/') === 0) {
    return normalizedPath;
  }
  return normalizedPath === '' ? 'files' : 'files/' + normalizedPath;
}

function toUuidFromHash(hash) {
  return (
    hash.substring(0, 8) +
    '-' +
    hash.substring(8, 12) +
    '-' +
    hash.substring(12, 16) +
    '-' +
    hash.substring(16, 20) +
    '-' +
    hash.substring(20, 32)
  );
}

function getDeterministicFileUuid(site, relativePath, fileSize) {
  const canonicalPath = getCanonicalFilePathForUuid(relativePath);
  const canonicalSize =
    typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize > 0
      ? Math.round(fileSize)
      : 0;
  const identityString =
    getSiteNameForFileUuid(site) + ':' + canonicalPath + ':' + canonicalSize;
  const hash = crypto.createHash('sha256').update(identityString).digest('hex');
  return toUuidFromHash(hash);
}

function toFileRecord(site, file) {
  const apiPath = `files/${file.relativePath}`;
  const dateCreated = getDateCreatedValue(file.stats);
  const fileSize =
    file && file.stats && typeof file.stats.size === 'number'
      ? file.stats.size
      : 0;
  const baseFileUrl = buildFilePublicUrl(site, apiPath);
  return {
    path: apiPath,
    fullUrl:
      baseFileUrl +
      (dateCreated
        ? (baseFileUrl.indexOf('?') === -1 ? '?t=' : '&t=') + dateCreated
        : ''),
    url: apiPath,
    mimetype: mime.getType(file.absolutePath) || '',
    name: path.basename(apiPath),
    uuid: getDeterministicFileUuid(site, apiPath, fileSize),
    size: fileSize,
    dateCreated: dateCreated,
  };
}

function applyFileFilters(records, req) {
  const filterType = String(getQueryValue(req, 'filter.type', '') || '')
    .trim()
    .toLowerCase();
  const filterExtension = String(
    getQueryValue(req, 'filter.extension', '') || '',
  )
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
  const filterStartsWith = String(
    getQueryValue(req, 'filter.startsWith', '') || '',
  )
    .trim()
    .toLowerCase();
  const filterNameContains = String(
    getQueryValue(req, 'filter.nameContains', '') || '',
  )
    .trim()
    .toLowerCase();
  return records.filter((record) => {
    const mimetype = String(record.mimetype || '').toLowerCase();
    const name = String(record.name || '').toLowerCase();
    const recordPath = String(record.path || '').toLowerCase();
    if (filterType !== '' && mimetype.indexOf(filterType) !== 0) {
      return false;
    }
    if (filterExtension !== '' && !name.endsWith(`.${filterExtension}`)) {
      return false;
    }
    if (filterStartsWith !== '' && recordPath.indexOf(filterStartsWith) !== 0) {
      return false;
    }
    if (filterNameContains !== '' && name.indexOf(filterNameContains) === -1) {
      return false;
    }
    return true;
  });
}
function resolveUploadedFile(req) {
  if (req && req.file && req.file.path) {
    return req.file;
  }
  if (req && Array.isArray(req.files) && req.files.length > 0) {
    const preferredFields = ['file-upload', 'upload', 'file', 'files[]'];
    for (let i = 0; i < preferredFields.length; i++) {
      const matched = req.files.find(
        (item) => item && item.path && item.fieldname === preferredFields[i],
      );
      if (matched) {
        return matched;
      }
    }
    for (let i = 0; i < req.files.length; i++) {
      const item = req.files[i];
      if (item && item.path) {
        return item;
      }
    }
  }
  return null;
}

function createStatusError(message, status) {
  const statusError = new Error(message);
  statusError.status = status;
  return statusError;
}

function normalizeJpegQualityValue(value) {
  const numericValue = parseInt(value, 10);
  if (Number.isNaN(numericValue)) {
    return null;
  }
  if (numericValue < MIN_JPEG_QUALITY) {
    return MIN_JPEG_QUALITY;
  }
  if (numericValue > MAX_JPEG_QUALITY) {
    return MAX_JPEG_QUALITY;
  }
  return numericValue;
}

function resolveJpegQualityFromSettings(mediaSettings = {}) {
  let configuredQuality = null;
  if (
    mediaSettings &&
    typeof mediaSettings === 'object' &&
    !Array.isArray(mediaSettings)
  ) {
    configuredQuality = normalizeJpegQualityValue(mediaSettings.jpegQuality);
  }
  if (configuredQuality !== null) {
    return configuredQuality;
  }
  return DEFAULT_JPEG_QUALITY;
}

function isPathInsideDirectory(basePath, candidatePath) {
  if (!basePath || !candidatePath) {
    return false;
  }
  if (basePath === candidatePath) {
    return true;
  }
  return candidatePath.indexOf(basePath + path.sep) === 0;
}

function resolveSiteFilesRootPath(site) {
  let siteRootPath = '';
  try {
    siteRootPath = fs.realpathSync(path.resolve(site.siteDirectory));
  } catch (e) {
    throw createStatusError('Unable to resolve site path', 500);
  }
  const filesRootCandidate = path.join(siteRootPath, 'files');
  if (!fs.pathExistsSync(filesRootCandidate)) {
    throw createStatusError('Files directory was not found', 404);
  }
  const filesRootStats = fs.lstatSync(filesRootCandidate);
  if (filesRootStats.isSymbolicLink() || !filesRootStats.isDirectory()) {
    throw createStatusError('Files directory was not found', 404);
  }
  let filesRootPath = '';
  try {
    filesRootPath = fs.realpathSync(filesRootCandidate);
  } catch (e) {
    throw createStatusError('Files directory was not found', 404);
  }
  if (!isPathInsideDirectory(siteRootPath, filesRootPath)) {
    throw createStatusError('Files directory is outside of allowed site path', 403);
  }
  return {
    siteRootPath,
    filesRootPath,
  };
}

function normalizeRequestedFilePath(inputPath = '') {
  let normalizedPath = decodePathToken(inputPath);
  if (
    normalizedPath === '' ||
    normalizedPath.indexOf('\0') !== -1 ||
    normalizedPath.indexOf('..') !== -1
  ) {
    return '';
  }
  if (normalizedPath.indexOf('files/') !== 0) {
    return '';
  }
  return normalizedPath;
}

function resolveSiteFilePath(site, requestedPath) {
  const normalizedPath = normalizeRequestedFilePath(requestedPath);
  if (normalizedPath === '') {
    throw createStatusError('Invalid file path', 400);
  }
  const siteRoots = resolveSiteFilesRootPath(site);
  const resolvedPath = path.resolve(siteRoots.siteRootPath, normalizedPath);
  if (!isPathInsideDirectory(siteRoots.filesRootPath, resolvedPath)) {
    throw createStatusError('File path is outside of allowed files directory', 403);
  }
  return {
    normalizedPath,
    resolvedPath,
    filesRootPath: siteRoots.filesRootPath,
  };
}

function sanitizeFileRenameBaseName(inputValue = '') {
  let value = String(inputValue || '').trim();
  if (value === '') {
    return '';
  }
  try {
    value = decodeURIComponent(value);
  } catch (e) {}
  value = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return value;
}

function getAllowedExtension(extensionValue = '') {
  const normalizedExtension = String(extensionValue || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '');
  if (
    normalizedExtension === '' ||
    !/^[a-z0-9]+$/.test(normalizedExtension) ||
    !ALLOWED_RENAME_EXTENSIONS.includes(normalizedExtension)
  ) {
    return '';
  }
  return normalizedExtension;
}

function parseRenameRequestName(requestedName, sourceExtension) {
  let normalizedInput = String(requestedName || '').trim();
  if (normalizedInput === '') {
    throw createStatusError('New file name is required', 400);
  }
  try {
    normalizedInput = decodeURIComponent(normalizedInput);
  } catch (e) {}
  const segments = normalizedInput.split('.');
  if (segments.length > 2) {
    throw createStatusError('File name can only include one extension', 400);
  }
  let baseInput = normalizedInput;
  let extensionInput = '';
  if (segments.length === 2) {
    baseInput = segments[0];
    extensionInput = segments[1];
  }
  const safeBaseName = sanitizeFileRenameBaseName(baseInput);
  if (safeBaseName === '') {
    throw createStatusError(
      'New file name must include at least one alphanumeric character',
      400,
    );
  }
  if (extensionInput !== '') {
    const allowedInputExtension = getAllowedExtension(extensionInput);
    if (allowedInputExtension === '') {
      throw createStatusError('Requested extension is not allowed', 400);
    }
    if (allowedInputExtension !== sourceExtension) {
      throw createStatusError(
        'Extension cannot be changed during rename and must remain .' +
          sourceExtension,
        400,
      );
    }
  }
  return safeBaseName;
}

function getRenamedFileInfo(fileInfo, requestedName) {
  const sourceFileName = path.basename(fileInfo.normalizedPath);
  const sourceRawExtension = path.extname(sourceFileName);
  const sourceExtension = getAllowedExtension(sourceRawExtension);
  if (sourceExtension === '') {
    throw createStatusError('Current file extension is not allowed for rename', 400);
  }
  const sourceDirectory = path.dirname(fileInfo.normalizedPath);
  const safeBaseName = parseRenameRequestName(requestedName, sourceExtension);
  const outputFileName = safeBaseName + '.' + sourceExtension;
  const outputPath = path.resolve(path.dirname(fileInfo.resolvedPath), outputFileName);
  if (!isPathInsideDirectory(fileInfo.filesRootPath, outputPath)) {
    throw createStatusError(
      'Renamed file path is outside of allowed files directory',
      403,
    );
  }
  const normalizedOutputPath = normalizePathForResponse(
    path.join(sourceDirectory, outputFileName),
  ).replace(/^\/+/, '');
  if (normalizedOutputPath === fileInfo.normalizedPath) {
    throw createStatusError('New file name must be different from current name', 400);
  }
  if (fs.pathExistsSync(outputPath)) {
    throw createStatusError('A file with this name already exists', 400);
  }
  return {
    outputPath,
    normalizedOutputPath,
  };
}

function ensureExistingRegularFile(filePath, filesRootPath) {
  if (!fs.pathExistsSync(filePath)) {
    throw createStatusError('Requested file was not found', 404);
  }
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw createStatusError('Requested file path is not a valid file', 404);
  }
  let realFilePath = '';
  try {
    realFilePath = fs.realpathSync(filePath);
  } catch (e) {
    throw createStatusError('Requested file was not found', 404);
  }
  if (!isPathInsideDirectory(filesRootPath, realFilePath)) {
    throw createStatusError('File path is outside of allowed files directory', 403);
  }
  return realFilePath;
}

function buildFileRecord(site, absolutePath, siteRelativePath = null) {
  const normalizedRelativePath = siteRelativePath
    ? normalizePathForResponse(siteRelativePath)
    : normalizePathForResponse(path.relative(site.siteDirectory, absolutePath));
  const safeRelativePath = normalizedRelativePath.replace(/^\/+/, '');
  const stats = fs.statSync(absolutePath);
  const dateCreated = getDateCreatedValue(stats);
  const baseFileUrl = buildFilePublicUrl(site, safeRelativePath);
  return {
    path: safeRelativePath,
    url: safeRelativePath,
    fullUrl:
      baseFileUrl +
      (dateCreated
        ? (baseFileUrl.indexOf('?') === -1 ? '?t=' : '&t=') + dateCreated
        : ''),
    mimetype: mime.getType(absolutePath) || '',
    name: path.basename(safeRelativePath),
    uuid: getDeterministicFileUuid(site, safeRelativePath, stats.size || 0),
    size: stats.size || 0,
    dateCreated: dateCreated,
  };
}

function getSafeOutputBasename(relativePath) {
  let safeName = path
    .basename(relativePath, path.extname(relativePath))
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  if (safeName === '') {
    safeName = 'image';
  }
  return safeName;
}

function getImgOpsOutputPath(filesRootPath, sourceRelativePath, width, height) {
  const outputDirectory = path.resolve(filesRootPath, 'imgops');
  if (fs.pathExistsSync(outputDirectory)) {
    const outputDirectoryStats = fs.lstatSync(outputDirectory);
    if (outputDirectoryStats.isSymbolicLink() || !outputDirectoryStats.isDirectory()) {
      throw createStatusError('Output path is not writable', 400);
    }
  } else {
    try {
      fs.ensureDirSync(outputDirectory);
    } catch (e) {
      throw createStatusError('Unable to prepare image operations directory', 500);
    }
  }
  let resolvedOutputDirectory = '';
  try {
    resolvedOutputDirectory = fs.realpathSync(outputDirectory);
  } catch (e) {
    throw createStatusError('Unable to prepare image operations directory', 500);
  }
  if (!isPathInsideDirectory(filesRootPath, resolvedOutputDirectory)) {
    throw createStatusError('Invalid output file path', 403);
  }
  const outputFileName =
    getSafeOutputBasename(sourceRelativePath) +
    '-' +
    String(width) +
    'x' +
    String(height) +
    '.jpg';
  const resolvedOutputPath = path.resolve(resolvedOutputDirectory, outputFileName);
  if (!isPathInsideDirectory(filesRootPath, resolvedOutputPath)) {
    throw createStatusError('Invalid output file path', 403);
  }
  if (fs.pathExistsSync(resolvedOutputPath)) {
    const outputStats = fs.lstatSync(resolvedOutputPath);
    if (outputStats.isSymbolicLink() || !outputStats.isFile()) {
      throw createStatusError('Output path is not writable', 400);
    }
  }
  return {
    outputPath: resolvedOutputPath,
    relativePath: 'files/imgops/' + outputFileName,
  };
}

function getScalePreset(sizeKey) {
  const requestedKey = typeof sizeKey === 'string' ? sizeKey.toLowerCase() : '';
  if (requestedKey && IMAGE_SCALE_PRESETS[requestedKey]) {
    return {
      key: requestedKey,
      preset: IMAGE_SCALE_PRESETS[requestedKey],
    };
  }
  return {
    key: DEFAULT_SCALE_PRESET,
    preset: IMAGE_SCALE_PRESETS[DEFAULT_SCALE_PRESET],
  };
}

function getTemporaryImagePath(sourcePath, operationLabel = 'tmp') {
  const sourceDirectory = path.dirname(sourcePath);
  const sourceExtension = path.extname(sourcePath);
  const sourceBaseName = path.basename(sourcePath, sourceExtension);
  return path.join(
    sourceDirectory,
    sourceBaseName + '-' + operationLabel + '-' + Date.now() + sourceExtension,
  );
}

async function convertImageToJpg(
  sourcePath,
  outputPath,
  transformMode = 'none',
  jpegQuality = DEFAULT_JPEG_QUALITY,
) {
  const metadata = await sharp(sourcePath, { failOn: 'none' }).metadata();
  if (!metadata || !metadata.format || String(metadata.format).indexOf('svg') === 0) {
    throw createStatusError('Only raster images can be converted to JPG', 400);
  }
  let pipeline = sharp(sourcePath).rotate();
  if (transformMode === 'black-and-white') {
    pipeline = pipeline.grayscale();
  }
  else if (transformMode === 'sepia') {
    pipeline = pipeline
      .grayscale()
      .linear(1.08, 0)
      .recomb([
        [0.393, 0.769, 0.189],
        [0.349, 0.686, 0.168],
        [0.272, 0.534, 0.131],
      ]);
  }
  const normalizedQuality = normalizeJpegQualityValue(jpegQuality);
  const outputQuality =
    normalizedQuality !== null ? normalizedQuality : DEFAULT_JPEG_QUALITY;
  await pipeline
    .jpeg({ quality: outputQuality, mozjpeg: true })
    .toFile(outputPath);
}

async function scaleImageToPreset(
  sourcePath,
  outputPath,
  width,
  height,
  jpegQuality = DEFAULT_JPEG_QUALITY,
) {
  const metadata = await sharp(sourcePath, { failOn: 'none' }).metadata();
  if (!metadata || !metadata.format || String(metadata.format).indexOf('svg') === 0) {
    throw createStatusError('Only raster images can be scaled', 400);
  }
  const normalizedQuality = normalizeJpegQualityValue(jpegQuality);
  const outputQuality =
    normalizedQuality !== null ? normalizedQuality : DEFAULT_JPEG_QUALITY;
  await sharp(sourcePath)
    .rotate()
    .resize({
      width: width,
      height: height,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: outputQuality, mozjpeg: true })
    .toFile(outputPath);
}

async function rotateImageInPlace(sourcePath, rotation = 90) {
  let metadata = null;
  try {
    metadata = await sharp(sourcePath, { failOn: 'none' }).metadata();
  } catch (e) {
    throw createStatusError('Only raster images can be rotated', 400);
  }
  if (!metadata || !metadata.format || String(metadata.format).indexOf('svg') === 0) {
    throw createStatusError('Only raster images can be rotated', 400);
  }
  const normalizedRotation = parseInt(rotation, 10);
  const rotationValue = Number.isNaN(normalizedRotation) ? 90 : normalizedRotation;
  const temporaryPath = getTemporaryImagePath(sourcePath, 'rotate');
  try {
    const rotatedBuffer = await sharp(sourcePath).rotate(rotationValue).toBuffer();
    await fs.writeFile(temporaryPath, rotatedBuffer);
    fs.moveSync(temporaryPath, sourcePath, { overwrite: true });
    try {
      const now = new Date();
      fs.utimesSync(sourcePath, now, now);
    } catch (mtimeError) {}
  } catch (e) {
    if (fs.pathExistsSync(temporaryPath)) {
      fs.removeSync(temporaryPath);
    }
    throw createStatusError(
      e && e.message ? e.message : 'Unable to rotate image',
      e && e.status ? e.status : 500,
    );
  }
}

function resolveRequestedFilePath(req, site) {
  const params =
    req && req.params && typeof req.params === 'object' ? req.params : {};
  const decodedPath = decodePathToken(params.fileUuid || '');
  if (!decodedPath || !site || !site.siteDirectory) {
    return '';
  }
  const normalizedUuid = String(decodedPath).trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      normalizedUuid,
    )
  ) {
    throw createStatusError(
      'File uuid is required and must be a valid UUID',
      400,
    );
  }
  const siteFilePath = path.join(site.siteDirectory, 'files');
  const fileEntries = collectSiteFiles(site, siteFilePath, '');
  for (let i = 0; i < fileEntries.length; i++) {
    const fileRecord = toFileRecord(site, fileEntries[i]);
    if (String(fileRecord.uuid || '').toLowerCase() === normalizedUuid) {
      return fileRecord.path;
    }
  }
  throw createStatusError('Requested file was not found', 404);
}

function readOperationPayload(req, operationOverride = '') {
  const body = ensureRequestBodyObject(req);
  const operation = operationOverride
    ? normalizeOperationName(operationOverride)
    : normalizeOperationName(body.operation || '');
  return {
    operation,
    size:
      typeof body.size === 'string'
        ? body.size.trim().toLowerCase()
        : String(body.size || '').trim().toLowerCase(),
    newName:
      typeof body.newName === 'string'
        ? body.newName
        : typeof body.name === 'string'
          ? body.name
          : typeof body.value === 'string'
            ? body.value
            : '',
  };
}

async function performFileOperation(site, requestedPath, payload, jpegQuality) {
  const operation = payload.operation;
  if (
    ![
      'delete',
      'rename',
      'convert-jpg',
      'scale',
      'sepia',
      'black-and-white',
      'rotate-90',
    ].includes(operation)
  ) {
    throw createStatusError('Unsupported file operation', 400);
  }
  let fileInfo = resolveSiteFilePath(site, requestedPath);
  fileInfo.resolvedPath = ensureExistingRegularFile(
    fileInfo.resolvedPath,
    fileInfo.filesRootPath,
  );
  if (operation === 'delete') {
    fs.removeSync(fileInfo.resolvedPath);
    return {
      commitMessage: 'File deleted: ' + fileInfo.normalizedPath,
      data: {
        operation: operation,
        path: fileInfo.normalizedPath,
        deleted: true,
      },
    };
  }
  if (operation === 'rename') {
    const renameInfo = getRenamedFileInfo(fileInfo, payload.newName);
    fs.moveSync(fileInfo.resolvedPath, renameInfo.outputPath, {
      overwrite: false,
    });
    const renamedFile = buildFileRecord(
      site,
      renameInfo.outputPath,
      renameInfo.normalizedOutputPath,
    );
    return {
      commitMessage:
        'File renamed: ' +
        fileInfo.normalizedPath +
        ' -> ' +
        renameInfo.normalizedOutputPath,
      data: {
        operation: operation,
        source: fileInfo.normalizedPath,
        path: renameInfo.normalizedOutputPath,
        file: renamedFile,
      },
    };
  }
  if (operation === 'rotate-90') {
    await rotateImageInPlace(fileInfo.resolvedPath, 90);
    const rotatedFile = buildFileRecord(
      site,
      fileInfo.resolvedPath,
      fileInfo.normalizedPath,
    );
    return {
      commitMessage: 'File rotated (90deg): ' + fileInfo.normalizedPath,
      data: {
        operation: operation,
        path: fileInfo.normalizedPath,
        file: rotatedFile,
      },
    };
  }
  if (operation === 'convert-jpg') {
    const sourceMetadata = await sharp(fileInfo.resolvedPath, { failOn: 'none' }).metadata();
    const targetWidth =
      sourceMetadata && sourceMetadata.width
        ? sourceMetadata.width
        : IMAGE_SCALE_PRESETS.md.width;
    const targetHeight =
      sourceMetadata && sourceMetadata.height
        ? sourceMetadata.height
        : IMAGE_SCALE_PRESETS.md.height;
    const convertOutput = getImgOpsOutputPath(
      fileInfo.filesRootPath,
      fileInfo.normalizedPath,
      targetWidth,
      targetHeight,
    );
    await convertImageToJpg(
      fileInfo.resolvedPath,
      convertOutput.outputPath,
      'none',
      jpegQuality,
    );
    const convertedFile = buildFileRecord(
      site,
      convertOutput.outputPath,
      convertOutput.relativePath,
    );
    return {
      commitMessage:
        'File converted to JPG: ' +
        fileInfo.normalizedPath +
        ' -> ' +
        convertOutput.relativePath,
      data: {
        operation: operation,
        source: fileInfo.normalizedPath,
        file: convertedFile,
      },
    };
  }
  if (operation === 'sepia' || operation === 'black-and-white') {
    const sourceMetadata = await sharp(fileInfo.resolvedPath, {
      failOn: 'none',
    }).metadata();
    const targetWidth =
      sourceMetadata && sourceMetadata.width
        ? sourceMetadata.width
        : IMAGE_SCALE_PRESETS.md.width;
    const targetHeight =
      sourceMetadata && sourceMetadata.height
        ? sourceMetadata.height
        : IMAGE_SCALE_PRESETS.md.height;
    const transformOutput = getImgOpsOutputPath(
      fileInfo.filesRootPath,
      fileInfo.normalizedPath + '-' + operation,
      targetWidth,
      targetHeight,
    );
    await convertImageToJpg(
      fileInfo.resolvedPath,
      transformOutput.outputPath,
      operation,
      jpegQuality,
    );
    const transformedFile = buildFileRecord(
      site,
      transformOutput.outputPath,
      transformOutput.relativePath,
    );
    return {
      commitMessage:
        'File transformed (' +
        operation +
        '): ' +
        fileInfo.normalizedPath +
        ' -> ' +
        transformOutput.relativePath,
      data: {
        operation: operation,
        source: fileInfo.normalizedPath,
        file: transformedFile,
      },
    };
  }
  const presetData = getScalePreset(payload.size);
  const scaleOutput = getImgOpsOutputPath(
    fileInfo.filesRootPath,
    fileInfo.normalizedPath,
    presetData.preset.width,
    presetData.preset.height,
  );
  await scaleImageToPreset(
    fileInfo.resolvedPath,
    scaleOutput.outputPath,
    presetData.preset.width,
    presetData.preset.height,
    jpegQuality,
  );
  const scaledFile = buildFileRecord(site, scaleOutput.outputPath, scaleOutput.relativePath);
  return {
    commitMessage:
      'File scaled (' +
      presetData.key +
      '): ' +
      fileInfo.normalizedPath +
      ' -> ' +
      scaleOutput.relativePath,
    data: {
      operation: operation,
      source: fileInfo.normalizedPath,
      size: presetData.key,
      dimensions: {
        width: presetData.preset.width,
        height: presetData.preset.height,
      },
      presets: IMAGE_SCALE_PRESETS,
      file: scaledFile,
    },
  };
}

async function listFiles(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/files',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  const siteFilePath = path.join(site.siteDirectory, 'files');
  const records = collectSiteFiles(
    site,
    siteFilePath,
    getQueryValue(req, 'filename', ''),
  ).map((file) => toFileRecord(site, file));
  let filteredRecords = applyFileFilters(records, req);
  filteredRecords = sortRecords(
    filteredRecords,
    getQueryValue(req, 'sort', ''),
    'path',
  );
  const paged = paginateRecords(filteredRecords, req, 25, 500);
  const outputRecords = projectCollection(paged.records, fields);
  return sendFormattedResponse(
    req,
    res,
    {
      count: outputRecords.length,
      total: paged.page.total,
      page: paged.page,
      files: outputRecords,
      links: {
        self: `${apiBasePath}/v1/files`,
      },
    },
    {
      allowedFormats: ['json', 'md', 'yaml', 'xml'],
      defaultFormat: 'json',
    },
  );
}

async function createFile(req, res) {
  if (!isSiteApiRequestAuthenticated(req, 'authenticated-site')) {
    return res.status(403).json({
      status: 403,
      message: 'Authenticated site access is required for this endpoint',
    });
  }
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/files',
    });
  }
  if (!platformAllows(site, 'uploadMedia')) {
    return featureDisabledResponse(
      res,
      'Uploading media is disabled for this site',
    );
  }
  const upload = resolveUploadedFile(req);
  if (!upload) {
    return res.status(400).json({
      status: 400,
      message: 'Missing file upload',
    });
  }
  const body = ensureRequestBodyObject(req);
  const query = ensureRequestQueryObject(req);
  const nodeId =
    (body.node && typeof body.node === 'object' && body.node.id) ||
    body.nodeId ||
    query.nodeId ||
    '';
  let page = null;
  if (nodeId && typeof site.loadNode === 'function') {
    page = site.loadNode(String(nodeId));
  }
  upload.name = upload.originalname || upload.name || '';
  upload.tmp_name = path.join('./', upload.path);
  const file = new HAXCMSFile();
  let fileResult = null;
  try {
    fileResult = await file.save(upload, site, page);
  } catch (e) {
    return res.status(500).json({
      status: 500,
      message: e && e.message ? e.message : 'Unable to save file',
    });
  }
  if (!fileResult || Number(fileResult.status) !== 200) {
    const failed =
      fileResult &&
      fileResult.__failed &&
      typeof fileResult.__failed === 'object'
        ? fileResult.__failed
        : null;
    return res.status(500).json({
      status: 500,
      message:
        failed && typeof failed.message === 'string'
          ? failed.message
          : 'Unable to save file',
    });
  }
  try {
    await site.gitCommit('File added: ' + upload.name);
  } catch (e) {}
  return res.status(200).json(fileResult);
}

async function fileDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/files/:fileUuid',
    });
  }
  const fields = getCsvQuery(req, 'fields');
  try {
    const requestedPath = resolveRequestedFilePath(req, site);
    if (!requestedPath) {
      return res.status(400).json({
        status: 400,
        message: 'File uuid is required',
      });
    }
    const fileInfo = resolveSiteFilePath(site, requestedPath);
    const resolvedPath = ensureExistingRegularFile(
      fileInfo.resolvedPath,
      fileInfo.filesRootPath,
    );
    const record = buildFileRecord(site, resolvedPath, fileInfo.normalizedPath);
    return sendFormattedResponse(req, res, projectRecord(record, fields), {
      allowedFormats: ['json', 'md', 'yaml', 'xml'],
      defaultFormat: 'json',
    });
  } catch (e) {
    return res.status(e && e.status ? e.status : 500).json({
      status: e && e.status ? e.status : 500,
      message: e && e.message ? e.message : 'Unable to load file',
    });
  }
}

async function updateFile(req, res) {
  if (!isSiteApiRequestAuthenticated(req, 'authenticated-site')) {
    return res.status(403).json({
      status: 403,
      message: 'Authenticated site access is required for this endpoint',
    });
  }
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/files/{fileUuid}',
    });
  }
  if (!platformAllows(site, 'uploadMedia')) {
    return featureDisabledResponse(
      res,
      'File operations are disabled for this site',
    );
  }
  const requestedPath = resolveRequestedFilePath(req, site);
  if (!requestedPath) {
    return res.status(400).json({
      status: 400,
      message: 'File uuid is required',
    });
  }
  const payload = readOperationPayload(req);
  if (!payload.operation) {
    return res.status(400).json({
      status: 400,
      message: 'Operation is required',
    });
  }
  if (payload.operation === 'delete') {
    return res.status(400).json({
      status: 400,
      message: 'Use DELETE /x/api/v1/files/{fileUuid} for file deletion',
    });
  }
  let mediaSettings = {};
  try {
    mediaSettings = await readMediaSettings(HAXCMS);
  } catch (e) {}
  const jpegQuality = resolveJpegQualityFromSettings(mediaSettings);
  try {
    const result = await performFileOperation(
      site,
      requestedPath,
      payload,
      jpegQuality,
    );
    await site.gitCommit(result.commitMessage);
    return res.status(200).json({
      status: 200,
      data: result.data,
    });
  } catch (e) {
    return res.status(e && e.status ? e.status : 500).json({
      status: e && e.status ? e.status : 500,
      message: e && e.message ? e.message : 'Unable to complete file operation',
    });
  }
}

async function deleteFile(req, res) {
  if (!isSiteApiRequestAuthenticated(req, 'authenticated-site')) {
    return res.status(403).json({
      status: 403,
      message: 'Authenticated site access is required for this endpoint',
    });
  }
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest || !site.siteDirectory) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/files/{fileUuid}',
    });
  }
  if (!platformAllows(site, 'uploadMedia')) {
    return featureDisabledResponse(
      res,
      'File operations are disabled for this site',
    );
  }
  const requestedPath = resolveRequestedFilePath(req, site);
  if (!requestedPath) {
    return res.status(400).json({
      status: 400,
      message: 'File uuid is required',
    });
  }
  let mediaSettings = {};
  try {
    mediaSettings = await readMediaSettings(HAXCMS);
  } catch (e) {}
  const jpegQuality = resolveJpegQualityFromSettings(mediaSettings);
  try {
    const result = await performFileOperation(
      site,
      requestedPath,
      readOperationPayload(req, 'delete'),
      jpegQuality,
    );
    await site.gitCommit(result.commitMessage);
    return res.status(200).json({
      status: 200,
      data: result.data,
    });
  } catch (e) {
    return res.status(e && e.status ? e.status : 500).json({
      status: e && e.status ? e.status : 500,
      message: e && e.message ? e.message : 'Unable to complete file operation',
    });
  }
}

module.exports = {
  listFiles,
  fileDetail,
  createFile,
  updateFile,
  deleteFile,
};
