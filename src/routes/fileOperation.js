const path = require('path');
const fs = require('fs-extra');
const mime = require('mime');
const sharp = require('sharp');
const { HAXCMS } = require('../lib/HAXCMS.js');
const {
  platformAllows,
  featureDisabledResponse,
} = require('../lib/platformFeatures.js');

const IMAGE_SCALE_PRESETS = {
  xs: { width: 200, height: 150 },
  sm: { width: 320, height: 240 },
  md: { width: 400, height: 300 },
  lg: { width: 800, height: 600 },
  xl: { width: 1200, height: 900 },
};
const DEFAULT_SCALE_PRESET = 'md';
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

function normalizePathForResponse(value = '') {
  return String(value).split(path.sep).join('/');
}

function failed(res, status, message) {
  return res.status(status).send({
    __failed: {
      status,
      message,
    },
  });
}

function normalizeRequestedFilePath(inputPath = '') {
  let normalizedPath = String(inputPath || '').trim();
  if (normalizedPath === '') {
    return '';
  }
  try {
    normalizedPath = decodeURIComponent(normalizedPath);
  } catch (e) {}
  normalizedPath = normalizedPath.replace(/\\/g, '/');
  normalizedPath = normalizedPath.replace(/^\/+/, '');
  normalizedPath = normalizedPath.replace(/^\.\/+/, '');
  return normalizedPath;
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

function getSiteNameFromRequest(req) {
  if (
    req.body &&
    req.body.site &&
    typeof req.body.site.name === 'string' &&
    req.body.site.name
  ) {
    return req.body.site.name;
  }
  if (req.query && typeof req.query.siteName === 'string' && req.query.siteName) {
    return req.query.siteName;
  }
  return '';
}
function isMultisiteContext(site) {
  if (HAXCMS.operatingContext === 'multisite') {
    return true;
  }
  if (
    typeof HAXCMS.getDeploymentProfile === 'function' &&
    HAXCMS.getDeploymentProfile() === 'self-hosted-multi-site'
  ) {
    return true;
  }
  if (site && typeof site.siteDirectory === 'string' && site.siteDirectory) {
    const normalizedSiteDirectory = normalizePathForResponse(site.siteDirectory);
    const multisitePathMarker = '/' + HAXCMS.sitesDirectory + '/';
    if (normalizedSiteDirectory.indexOf(multisitePathMarker) !== -1) {
      return true;
    }
  }
  return false;
}

function resolveSiteFilePath(site, requestedPath) {
  const normalizedPath = normalizeRequestedFilePath(requestedPath);
  if (
    normalizedPath === '' ||
    normalizedPath.indexOf('\0') !== -1 ||
    normalizedPath.indexOf('..') !== -1
  ) {
    throw new Error('Invalid file path');
  }
  if (normalizedPath.indexOf('files/') !== 0) {
    throw new Error('File path must start with files/');
  }
  const filesRootPath = path.resolve(site.siteDirectory, 'files');
  const resolvedPath = path.resolve(site.siteDirectory, normalizedPath);
  if (!isPathInsideDirectory(filesRootPath, resolvedPath)) {
    throw new Error('File path is outside of allowed files directory');
  }
  return {
    normalizedPath,
    resolvedPath,
    filesRootPath,
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
    throw new Error('New file name is required');
  }
  try {
    normalizedInput = decodeURIComponent(normalizedInput);
  } catch (e) {}
  const segments = normalizedInput.split('.');
  if (segments.length > 2) {
    throw new Error('File name can only include one extension');
  }
  let baseInput = normalizedInput;
  let extensionInput = '';
  if (segments.length === 2) {
    baseInput = segments[0];
    extensionInput = segments[1];
  }
  const safeBaseName = sanitizeFileRenameBaseName(baseInput);
  if (safeBaseName === '') {
    throw new Error(
      'New file name must include at least one alphanumeric character',
    );
  }
  if (extensionInput !== '') {
    const allowedInputExtension = getAllowedExtension(extensionInput);
    if (allowedInputExtension === '') {
      throw new Error('Requested extension is not allowed');
    }
    if (allowedInputExtension !== sourceExtension) {
      throw new Error(
        'Extension cannot be changed during rename and must remain .' +
          sourceExtension,
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
    throw new Error('Current file extension is not allowed for rename');
  }
  const sourceDirectory = path.dirname(fileInfo.normalizedPath);
  const safeBaseName = parseRenameRequestName(requestedName, sourceExtension);
  const outputFileName = safeBaseName + '.' + sourceExtension;
  const outputPath = path.resolve(path.dirname(fileInfo.resolvedPath), outputFileName);
  if (!isPathInsideDirectory(fileInfo.filesRootPath, outputPath)) {
    throw new Error('Renamed file path is outside of allowed files directory');
  }
  const normalizedOutputPath = normalizePathForResponse(
    path.join(sourceDirectory, outputFileName),
  ).replace(/^\/+/, '');
  if (normalizedOutputPath === fileInfo.normalizedPath) {
    throw new Error('New file name must be different from current name');
  }
  if (fs.pathExistsSync(outputPath)) {
    throw new Error('A file with this name already exists');
  }
  return {
    outputPath,
    normalizedOutputPath,
  };
}

function ensureExistingRegularFile(filePath) {
  if (!fs.pathExistsSync(filePath)) {
    throw new Error('Requested file was not found');
  }
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Requested file path is not a valid file');
  }
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

function buildFileRecord(site, absolutePath, siteRelativePath = null) {
  const normalizedRelativePath = siteRelativePath
    ? normalizePathForResponse(siteRelativePath)
    : normalizePathForResponse(path.relative(site.siteDirectory, absolutePath));
  const safeRelativePath = normalizedRelativePath.replace(/^\/+/, '');
  const stats = fs.statSync(absolutePath);
  let dateCreated = '';
  if (
    typeof stats.birthtimeMs === 'number' &&
    Number.isFinite(stats.birthtimeMs) &&
    stats.birthtimeMs > 0
  ) {
    dateCreated = new Date(stats.birthtimeMs).toISOString();
  } else if (
    typeof stats.ctimeMs === 'number' &&
    Number.isFinite(stats.ctimeMs) &&
    stats.ctimeMs > 0
  ) {
    dateCreated = new Date(stats.ctimeMs).toISOString();
  } else if (
    typeof stats.mtimeMs === 'number' &&
    Number.isFinite(stats.mtimeMs) &&
    stats.mtimeMs > 0
  ) {
    dateCreated = new Date(stats.mtimeMs).toISOString();
  }
  return {
    path: safeRelativePath,
    url: safeRelativePath,
    fullUrl: buildFilePublicUrl(site, safeRelativePath),
    mimetype: mime.getType(absolutePath) || '',
    name: path.basename(safeRelativePath),
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

function getImgOpsOutputPath(site, sourceRelativePath, width, height) {
  const outputDirectory = path.resolve(site.siteDirectory, 'files', 'imgops');
  const filesRootPath = path.resolve(site.siteDirectory, 'files');
  fs.ensureDirSync(outputDirectory);
  const outputFileName =
    getSafeOutputBasename(sourceRelativePath) +
    '-' +
    String(width) +
    'x' +
    String(height) +
    '.jpg';
  const resolvedOutputPath = path.resolve(outputDirectory, outputFileName);
  if (!isPathInsideDirectory(filesRootPath, resolvedOutputPath)) {
    throw new Error('Invalid output file path');
  }
  if (fs.pathExistsSync(resolvedOutputPath)) {
    const outputStats = fs.lstatSync(resolvedOutputPath);
    if (outputStats.isSymbolicLink() || !outputStats.isFile()) {
      throw new Error('Output path is not writable');
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

async function convertImageToJpg(sourcePath, outputPath, transformMode = 'none') {
  const metadata = await sharp(sourcePath, { failOn: 'none' }).metadata();
  if (!metadata || !metadata.format || String(metadata.format).indexOf('svg') === 0) {
    const conversionError = new Error('Only raster images can be converted to JPG');
    conversionError.status = 400;
    throw conversionError;
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
  const outputQuality = transformMode === 'none' ? 90 : 82;
  await pipeline
    .jpeg({ quality: outputQuality, mozjpeg: true })
    .toFile(outputPath);
}

async function scaleImageToPreset(sourcePath, outputPath, width, height) {
  const metadata = await sharp(sourcePath, { failOn: 'none' }).metadata();
  if (!metadata || !metadata.format || String(metadata.format).indexOf('svg') === 0) {
    const scaleError = new Error('Only raster images can be scaled');
    scaleError.status = 400;
    throw scaleError;
  }
  await sharp(sourcePath)
    .rotate()
    .resize({
      width: width,
      height: height,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(outputPath);
}

/**
 * @OA\Post(
 *    path="/fileOperation",
 *    tags={"hax","authenticated","file"},
 *    @OA\Response(
 *        response="200",
 *        description="Perform file operations for a site file"
 *   )
 * )
 */
async function fileOperation(req, res) {
  const siteName = getSiteNameFromRequest(req);
  if (!req.query.site_token) {
    return failed(res, 403, 'Missing site token');
  }
  if (!siteName) {
    return failed(res, 400, 'Missing site name');
  }
  if (
    !HAXCMS.validateRequestToken(
      req.query.site_token,
      HAXCMS.getActiveUserName() + ':' + siteName,
    )
  ) {
    return failed(res, 403, 'Invalid site token');
  }
  const site = await HAXCMS.loadSite(siteName);
  if (!site || !site.siteDirectory) {
    return failed(res, 404, 'Site not found');
  }
  if (!platformAllows(site, 'uploadMedia')) {
    return featureDisabledResponse(
      res,
      'File operations are disabled for this site',
    );
  }
  const operation = req.body && req.body.operation ? String(req.body.operation).trim() : '';
  if (
    ![
      'delete',
      'rename',
      'convert-jpg',
      'scale',
      'sepia',
      'black-and-white',
    ].includes(
      operation,
    )
  ) {
    return failed(res, 400, 'Unsupported file operation');
  }
  const requestedPath =
    req.body && typeof req.body.path === 'string'
      ? req.body.path
      : req.body && typeof req.body.filePath === 'string'
        ? req.body.filePath
        : req.body && typeof req.body.file === 'string'
          ? req.body.file
          : '';
  if (Array.isArray(requestedPath)) {
    return failed(res, 400, 'Only a single file path is allowed per request');
  }
  let fileInfo = null;
  try {
    fileInfo = resolveSiteFilePath(site, requestedPath);
  } catch (e) {
    return failed(res, 400, e.message || 'Invalid file path');
  }
  try {
    ensureExistingRegularFile(fileInfo.resolvedPath);
  } catch (e) {
    return failed(res, 404, e.message || 'Requested file was not found');
  }
  try {
    if (operation === 'delete') {
      fs.removeSync(fileInfo.resolvedPath);
      await site.gitCommit('File deleted: ' + fileInfo.normalizedPath);
      return res.status(200).send({
        status: 200,
        data: {
          operation: operation,
          path: fileInfo.normalizedPath,
          deleted: true,
        },
      });
    }
    if (operation === 'rename') {
      const renameValue =
        req.body && typeof req.body.newName === 'string'
          ? req.body.newName
          : req.body && typeof req.body.name === 'string'
            ? req.body.name
            : req.body && typeof req.body.value === 'string'
              ? req.body.value
              : '';
      let renameInfo = null;
      try {
        renameInfo = getRenamedFileInfo(fileInfo, renameValue);
      } catch (e) {
        return failed(res, 400, e && e.message ? e.message : 'Invalid rename value');
      }
      fs.moveSync(fileInfo.resolvedPath, renameInfo.outputPath, {
        overwrite: false,
      });
      const renamedFile = buildFileRecord(
        site,
        renameInfo.outputPath,
        renameInfo.normalizedOutputPath,
      );
      await site.gitCommit(
        'File renamed: ' +
          fileInfo.normalizedPath +
          ' -> ' +
          renameInfo.normalizedOutputPath,
      );
      return res.status(200).send({
        status: 200,
        data: {
          operation: operation,
          source: fileInfo.normalizedPath,
          path: renameInfo.normalizedOutputPath,
          file: renamedFile,
        },
      });
    }
    if (operation === 'convert-jpg') {
      const sourceMetadata = await sharp(fileInfo.resolvedPath, { failOn: 'none' }).metadata();
      const targetWidth =
        sourceMetadata && sourceMetadata.width ? sourceMetadata.width : IMAGE_SCALE_PRESETS.md.width;
      const targetHeight =
        sourceMetadata && sourceMetadata.height
          ? sourceMetadata.height
          : IMAGE_SCALE_PRESETS.md.height;
      const convertOutput = getImgOpsOutputPath(
        site,
        fileInfo.normalizedPath,
        targetWidth,
        targetHeight,
      );
      await convertImageToJpg(
        fileInfo.resolvedPath,
        convertOutput.outputPath,
        'none',
      );
      const convertedFile = buildFileRecord(
        site,
        convertOutput.outputPath,
        convertOutput.relativePath,
      );
      await site.gitCommit(
        'File converted to JPG: ' +
          fileInfo.normalizedPath +
          ' -> ' +
          convertOutput.relativePath,
      );
      return res.status(200).send({
        status: 200,
        data: {
          operation: operation,
          source: fileInfo.normalizedPath,
          file: convertedFile,
        },
      });
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
        site,
        fileInfo.normalizedPath + '-' + operation,
        targetWidth,
        targetHeight,
      );
      await convertImageToJpg(
        fileInfo.resolvedPath,
        transformOutput.outputPath,
        operation,
      );
      const transformedFile = buildFileRecord(
        site,
        transformOutput.outputPath,
        transformOutput.relativePath,
      );
      await site.gitCommit(
        'File transformed (' +
          operation +
          '): ' +
          fileInfo.normalizedPath +
          ' -> ' +
          transformOutput.relativePath,
      );
      return res.status(200).send({
        status: 200,
        data: {
          operation: operation,
          source: fileInfo.normalizedPath,
          file: transformedFile,
        },
      });
    }
    const presetData = getScalePreset(req.body ? req.body.size : '');
    const scaleOutput = getImgOpsOutputPath(
      site,
      fileInfo.normalizedPath,
      presetData.preset.width,
      presetData.preset.height,
    );
    await scaleImageToPreset(
      fileInfo.resolvedPath,
      scaleOutput.outputPath,
      presetData.preset.width,
      presetData.preset.height,
    );
    const scaledFile = buildFileRecord(site, scaleOutput.outputPath, scaleOutput.relativePath);
    await site.gitCommit(
      'File scaled (' +
        presetData.key +
        '): ' +
        fileInfo.normalizedPath +
        ' -> ' +
        scaleOutput.relativePath,
    );
    return res.status(200).send({
      status: 200,
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
    });
  } catch (e) {
    return failed(
      res,
      e && e.status ? e.status : 500,
      e && e.message ? e.message : 'Unable to complete file operation',
    );
  }
}

module.exports = fileOperation;
