const path = require('path');
const fs = require('fs-extra');
const Axios = require('axios')
const { HAXCMS } = require('./HAXCMS.js');
const { buildFilePublicUrl } = require('./siteFileUrl.js');
const { readMediaSettings } = require('./mediaSettings.js');
const sharp = require('sharp');
const dns = require('dns');

const ALLOWED_UPLOAD_EXTENSION_PATTERN = /\.(jpg|jpeg|png|gif|webm|webp|mp4|mp3|mov|csv|ppt|pptx|xlsx|doc|xls|docx|pdf|rtf|txt|vtt|html|md)$/i;
const ALLOWED_MIME_BY_EXTENSION = {
  'jpg': ['image/jpeg'],
  'jpeg': ['image/jpeg'],
  'png': ['image/png'],
  'gif': ['image/gif'],
  'webp': ['image/webp'],
  'webm': ['video/webm', 'audio/webm'],
  'mp4': ['video/mp4'],
  'mp3': ['audio/mpeg', 'audio/mp3'],
  'mov': ['video/quicktime'],
  'csv': ['text/csv', 'text/plain'],
  'ppt': ['application/vnd.ms-powerpoint', 'application/x-ole-storage', 'application/octet-stream'],
  'pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'],
  'xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
  'doc': ['application/msword', 'application/x-ole-storage', 'application/octet-stream'],
  'xls': ['application/vnd.ms-excel', 'application/x-ole-storage', 'application/octet-stream'],
  'docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  'pdf': ['application/pdf'],
  'rtf': ['application/rtf', 'text/rtf', 'text/plain'],
  'txt': ['text/plain'],
  'vtt': ['text/vtt', 'text/plain'],
  'html': ['text/html', 'application/xhtml+xml'],
  'md': ['text/markdown', 'text/plain'],
  'css': ['text/css'],
  'js': ['text/javascript', 'application/javascript', 'application/x-javascript', 'text/ecmascript'],
  'svg': ['image/svg+xml'],
  'woff': ['font/woff', 'application/font-woff'],
  'woff2': ['font/woff2', 'application/font-woff2'],
  'ttf': ['font/ttf', 'application/font-sfnt', 'application/x-font-ttf'],
  'eot': ['application/vnd.ms-fontobject', 'application/octet-stream']
};
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const MIN_JPEG_QUALITY = 1;
const MAX_JPEG_QUALITY = 100;
const EXECUTABLE_FILE_EXTENSIONS = [
  'php',
  'php3',
  'php4',
  'php5',
  'php7',
  'php8',
  'phtml',
  'phar',
  'phpt',
  'cgi',
  'pl',
  'py',
  'rb',
  'sh',
  'bash',
  'zsh',
  'ksh',
  'csh',
  'tcsh',
  'asp',
  'aspx',
  'jsp',
  'exe',
  'dll',
  'com',
  'bat',
  'cmd',
  'msi'
];

function stripExecutableExtensionPatterns(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    return '';
  }
  const parsedName = path.parse(fileName);
  const parts = parsedName.base.split('.');
  if (parts.length <= 1) {
    return parsedName.base;
  }
  const safeParts = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) {
      continue;
    }
    if (i > 0) {
      const normalizedPart = part.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (EXECUTABLE_FILE_EXTENSIONS.includes(normalizedPart)) {
        continue;
      }
    }
    safeParts.push(part);
  }
  if (!safeParts.length) {
    return '';
  }
  const sanitizedBaseName = safeParts.join('.');
  if (parsedName.dir && parsedName.dir !== '.') {
    return path.join(parsedName.dir, sanitizedBaseName);
  }
  return sanitizedBaseName;
}

function normalizeFilenameExtensionCasing(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    return '';
  }
  const parsedName = path.parse(fileName);
  if (!parsedName.ext) {
    return fileName;
  }
  const normalizedBaseName = parsedName.name + parsedName.ext.toLowerCase();
  if (parsedName.dir && parsedName.dir !== '.') {
    return path.join(parsedName.dir, normalizedBaseName);
  }
  return normalizedBaseName;
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

function getTemporaryJpegPath(sourcePath) {
  const sourceDirectory = path.dirname(sourcePath);
  const sourceExtension = path.extname(sourcePath);
  const sourceBaseName = path.basename(sourcePath, sourceExtension);
  return path.join(
    sourceDirectory,
    sourceBaseName + '-jpeg-quality-' + Date.now() + sourceExtension,
  );
}

async function applyConfiguredJpegUploadQuality(filePath) {
  let mediaSettings = {};
  try {
    mediaSettings = await readMediaSettings(HAXCMS);
  }
  catch (e) {
    return;
  }
  if (
    !mediaSettings ||
    typeof mediaSettings !== 'object' ||
    Array.isArray(mediaSettings)
  ) {
    return;
  }
  const configuredQuality = normalizeJpegQualityValue(mediaSettings.jpegQuality);
  if (configuredQuality === null) {
    return;
  }
  const temporaryPath = getTemporaryJpegPath(filePath);
  try {
    await sharp(filePath)
      .rotate()
      .jpeg({ quality: configuredQuality, mozjpeg: true })
      .toFile(temporaryPath);
    fs.moveSync(temporaryPath, filePath, { overwrite: true });
  }
  catch (e) {
    if (fs.pathExistsSync(temporaryPath)) {
      fs.removeSync(temporaryPath);
    }
    throw e;
  }
}

function mimeMatchesAllowed(actualMime, allowedMimes) {
  for (let i = 0; i < allowedMimes.length; i++) {
    const allowedMime = String(allowedMimes[i]).toLowerCase();
    if (allowedMime.endsWith('/*')) {
      const prefix = allowedMime.slice(0, -1);
      if (actualMime.startsWith(prefix)) {
        return true;
      }
    }
    else if (actualMime === allowedMime) {
      return true;
    }
  }
  return false;
}

function readFileSample(filePath, sampleSize = 8192) {
  if (!filePath || !fs.existsSync(filePath)) {
    return Buffer.alloc(0);
  }
  const fileDescriptor = fs.openSync(filePath, 'r');
  const sample = Buffer.alloc(sampleSize);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fileDescriptor, sample, 0, sampleSize, 0);
  }
  finally {
    fs.closeSync(fileDescriptor);
  }
  return sample.slice(0, bytesRead);
}

function isLikelyTextContent(buffer) {
  if (!buffer || !buffer.length) {
    return false;
  }
  let printableBytes = 0;
  for (let i = 0; i < buffer.length; i++) {
    const value = buffer[i];
    if (value === 0) {
      return false;
    }
    if (value === 9 || value === 10 || value === 13 || value >= 32) {
      printableBytes++;
    }
  }
  return printableBytes / buffer.length >= 0.85;
}

function detectMimeTypeFromContent(filePath) {
  const sample = readFileSample(filePath);
  if (!sample.length) {
    return 'application/octet-stream';
  }
  if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    sample.length >= 8 &&
    sample[0] === 0x89 &&
    sample[1] === 0x50 &&
    sample[2] === 0x4e &&
    sample[3] === 0x47 &&
    sample[4] === 0x0d &&
    sample[5] === 0x0a &&
    sample[6] === 0x1a &&
    sample[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    sample.length >= 6 &&
    sample.toString('ascii', 0, 3) === 'GIF' &&
    (sample.toString('ascii', 3, 6) === '87a' || sample.toString('ascii', 3, 6) === '89a')
  ) {
    return 'image/gif';
  }
  if (
    sample.length >= 12 &&
    sample.toString('ascii', 0, 4) === 'RIFF' &&
    sample.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    sample.length >= 4 &&
    sample[0] === 0x1a &&
    sample[1] === 0x45 &&
    sample[2] === 0xdf &&
    sample[3] === 0xa3 &&
    sample.toString('utf8').toLowerCase().indexOf('webm') !== -1
  ) {
    return 'video/webm';
  }
  if (sample.length >= 12 && sample.toString('ascii', 4, 8) === 'ftyp') {
    const majorBrand = sample.toString('ascii', 8, 12);
    if (majorBrand === 'qt  ') {
      return 'video/quicktime';
    }
    return 'video/mp4';
  }
  if (
    sample.length >= 2 &&
    sample[0] === 0xff &&
    (sample[1] & 0xe0) === 0xe0
  ) {
    return 'audio/mpeg';
  }
  if (sample.length >= 3 && sample.toString('ascii', 0, 3) === 'ID3') {
    return 'audio/mpeg';
  }
  if (sample.length >= 5 && sample.toString('ascii', 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  if (
    sample.length >= 4 &&
    sample[0] === 0x50 &&
    sample[1] === 0x4b &&
    (sample[2] === 0x03 || sample[2] === 0x05 || sample[2] === 0x07) &&
    (sample[3] === 0x04 || sample[3] === 0x06 || sample[3] === 0x08)
  ) {
    return 'application/zip';
  }
  if (
    sample.length >= 8 &&
    sample[0] === 0xd0 &&
    sample[1] === 0xcf &&
    sample[2] === 0x11 &&
    sample[3] === 0xe0 &&
    sample[4] === 0xa1 &&
    sample[5] === 0xb1 &&
    sample[6] === 0x1a &&
    sample[7] === 0xe1
  ) {
    return 'application/x-ole-storage';
  }
  const lowerText = sample.toString('utf8').toLowerCase();
  if (lowerText.indexOf('{\\rtf') === 0 || lowerText.indexOf('{\\rtf') === 1) {
    return 'application/rtf';
  }
  if (
    lowerText.indexOf('<!doctype html') !== -1 ||
    lowerText.indexOf('<html') !== -1 ||
    lowerText.indexOf('<body') !== -1
  ) {
    return 'text/html';
  }
  if (isLikelyTextContent(sample)) {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

async function verifyImageContent(filePath) {
  try {
    const imageData = await sharp(filePath).metadata();
    if (!imageData || !imageData.width || !imageData.height) {
      return false;
    }
    return true;
  }
  catch (e) {
    return false;
  }
}

async function validateUploadMimeAndContent(filePath, fileName) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      valid: false,
      message: 'Uploaded file is missing'
    };
  }
  const extension = path.extname(fileName).replace('.', '').toLowerCase();
  if (!extension || !ALLOWED_MIME_BY_EXTENSION[extension]) {
    return {
      valid: false,
      message: 'File type not allowed'
    };
  }
  const detectedMime = detectMimeTypeFromContent(filePath);
  if (!detectedMime) {
    return {
      valid: false,
      message: 'Unable to determine uploaded file MIME type'
    };
  }
  if (!mimeMatchesAllowed(detectedMime.toLowerCase(), ALLOWED_MIME_BY_EXTENSION[extension])) {
    return {
      valid: false,
      message: 'Detected MIME type ' + detectedMime + ' does not match allowed type for .' + extension
    };
  }
  if (IMAGE_EXTENSIONS.includes(extension)) {
    const isValidImage = await verifyImageContent(filePath);
    if (!isValidImage) {
      return {
        valid: false,
        message: 'Invalid image file content'
      };
    }
  }
  return {
    valid: true,
    detectedMime: detectedMime.toLowerCase()
  };
}
function getBulkImportStagingRootPath() {
  const stagingRoot = path.join(HAXCMS.configDirectory, 'tmp', 'imports');
  if (!fs.pathExistsSync(stagingRoot)) {
    return null;
  }
  try {
    const resolvedRoot = fs.realpathSync(stagingRoot);
    if (!resolvedRoot) {
      return null;
    }
    return resolvedRoot;
  }
  catch (e) {
    return null;
  }
}

function isPathWithinRoot(resolvedPath, resolvedRoot) {
  if (!resolvedPath || !resolvedRoot) {
    return false;
  }
  if (resolvedPath === resolvedRoot) {
    return true;
  }
  return resolvedPath.indexOf(resolvedRoot + path.sep) === 0;
}

function isValidBulkImportStagedPath(inputPath) {
  if (typeof inputPath !== 'string') {
    return false;
  }
  const normalizedSource = inputPath.trim();
  if (normalizedSource === '' || normalizedSource.indexOf('\0') !== -1) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+\.\-]*:/.test(normalizedSource) && !/^[a-zA-Z]:[\\/]/.test(normalizedSource)) {
    return false;
  }
  if (!path.isAbsolute(normalizedSource)) {
    return false;
  }
  if (!fs.pathExistsSync(normalizedSource)) {
    return false;
  }
  // reject symlinks to prevent TOCTOU attacks
  try {
    var lstats = fs.lstatSync(normalizedSource);
    if (lstats.isSymbolicLink()) {
      return false;
    }
  }
  catch (e) {
    return false;
  }
  let resolvedSource = null;
  try {
    resolvedSource = fs.realpathSync(normalizedSource);
  }
  catch (e) {
    return false;
  }
  if (!resolvedSource) {
    return false;
  }
  let sourceStats = null;
  try {
    sourceStats = fs.statSync(resolvedSource);
  }
  catch (e) {
    return false;
  }
  if (!sourceStats || !sourceStats.isFile()) {
    return false;
  }
  const stagingRoot = getBulkImportStagingRootPath();
  if (!stagingRoot) {
    return false;
  }
  return isPathWithinRoot(resolvedSource, stagingRoot);
}

/**
 * Check if an IPv4 address is in a private, reserved, loopback, link-local,
 * carrier-grade NAT, or cloud-metadata range.
 *
 * Security (HAX-SEC-007): includes 100.64.0.0/10 (CGNAT / RFC 6598) which was
 * previously missing in both backends and is reachable in some cloud/LAN
 * topologies. Split out from isPrivateOrReservedIP so the IPv4-mapped IPv6
 * normalization below can reuse it.
 */
function isPrivateOrReservedIPv4(ip) {
  if (!ip || typeof ip !== 'string') {
    return true;
  }
  if (ip === '0.0.0.0') {
    return true;
  }
  if (ip.startsWith('127.')) {
    return true;
  }
  // link-local / cloud metadata (169.254.169.254)
  if (ip.startsWith('169.254.')) {
    return true;
  }
  if (ip.startsWith('10.')) {
    return true;
  }
  if (ip.startsWith('192.168.')) {
    return true;
  }
  // private Class B (172.16.0.0/12)
  if (ip.startsWith('172.')) {
    var parts172 = ip.split('.');
    var secondOctet172 = parseInt(parts172[1], 10);
    if (secondOctet172 >= 16 && secondOctet172 <= 31) {
      return true;
    }
  }
  // carrier-grade NAT (100.64.0.0/10, RFC 6598)
  if (ip.startsWith('100.')) {
    var parts100 = ip.split('.');
    var secondOctet100 = parseInt(parts100[1], 10);
    if (secondOctet100 >= 64 && secondOctet100 <= 127) {
      return true;
    }
  }
  return false;
}

/**
 * Pack a textual IPv6 address into a 16-byte Buffer, or return null if the
 * input is not a valid IPv6 address (including plain IPv4, which has no ':').
 * Handles '::' compression and a trailing dotted-quad group
 * (::ffff:127.0.0.1) so the caller can inspect the canonical bytes.
 *
 * Node has no built-in inet_pton; this parser is the dependency-free
 * equivalent used by isPrivateOrReservedIP to detect IPv4-mapped and
 * IPv4-compatible forms by their 12-byte prefix regardless of whether the
 * embedded IPv4 is written as a dotted-quad or as hex groups.
 */
function ipv6ToBuffer(ip) {
  if (!ip || typeof ip !== 'string' || ip.indexOf(':') === -1) {
    return null;
  }
  var idx = ip.indexOf('::');
  var leftPart = '';
  var rightPart = '';
  if (idx === -1) {
    leftPart = ip;
  } else {
    // at most one '::' is allowed
    if (ip.indexOf('::', idx + 1) !== -1) {
      return null;
    }
    leftPart = ip.slice(0, idx);
    rightPart = ip.slice(idx + 2);
  }
  var left = leftPart === '' ? [] : leftPart.split(':');
  var right = rightPart === '' ? [] : rightPart.split(':');
  // a trailing dotted-quad group occupies 2 group slots but is 1 array element
  var hasDotted = right.length > 0 && right[right.length - 1].indexOf('.') !== -1;
  var groupCount = left.length + right.length + (hasDotted ? 1 : 0);
  if (idx === -1) {
    if (groupCount !== 8) {
      return null;
    }
  } else if (groupCount > 8) {
    return null;
  }
  var groups = left.slice();
  if (idx !== -1) {
    var fill = 8 - groupCount;
    for (var f = 0; f < fill; f++) {
      groups.push('0');
    }
  }
  for (var r = 0; r < right.length; r++) {
    groups.push(right[r]);
  }
  var out = Buffer.alloc(16);
  var bytePos = 0;
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (g === '') {
      return null;
    }
    if (g.indexOf('.') !== -1) {
      // dotted-quad must be the last 4 bytes (groups 6+7)
      if (bytePos !== 12) {
        return null;
      }
      var octets = g.split('.');
      if (octets.length !== 4) {
        return null;
      }
      for (var j = 0; j < 4; j++) {
        var ov = parseInt(octets[j], 10);
        if (isNaN(ov) || ov < 0 || ov > 255 || String(ov) !== octets[j]) {
          return null;
        }
        out[bytePos + j] = ov;
      }
      bytePos += 4;
    } else {
      if (bytePos >= 16) {
        return null;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
        return null;
      }
      var n = parseInt(g, 16);
      out[bytePos] = (n >> 8) & 0xff;
      out[bytePos + 1] = n & 0xff;
      bytePos += 2;
    }
  }
  if (bytePos !== 16) {
    return null;
  }
  return out;
}

/**
 * Check if an IP address is in a private, reserved, loopback, link-local,
 * cloud-metadata, or carrier-grade NAT range.
 *
 * Security (HAX-SEC-007 / SSRF hex-form bypass): normalizes IPv4-mapped
 * (::ffff:0:0/96) and IPv4-compatible (::/96) IPv6 addresses to their
 * embedded IPv4 form before checking. dns.lookup(..., {all:true}) returns
 * mapped/compat addresses verbatim, and an attacker-published AAAA record
 * (or a literal IP in a URL) of ::ffff:7f00:1 / ::ffff:a9fe:a9fe would
 * otherwise bypass the check and reach loopback/internal/metadata targets.
 *
 * The previous text-based match only recognized the dotted-quad spelling
 * (::ffff:127.0.0.1) and fed substr to isPrivateOrReservedIPv4, which matched
 * no private prefix for the hex spelling (::ffff:7f00:1 -> "7f00:1"). The
 * packed-byte approach canonicalizes every equivalent spelling to the same 16
 * bytes via ipv6ToBuffer, then decodes the trailing 4 bytes (inet_ntop
 * equivalent) and re-checks. The prefix test (bytes 0-9 zero + bytes 10-11 =
 * 0xffff for mapped; bytes 0-11 zero for compat) avoids touching legitimate
 * public v6 like 2001:db8::1.2.3.4, whose trailing 4 bytes happen to look
 * like an IPv4 address but whose prefix is not the mapped/compat prefix.
 * Mirrors PHP SsrfGuard::isPrivateOrReservedIP so both backends share the
 * same posture.
 */
function isPrivateOrReservedIP(ip) {
  if (!ip || typeof ip !== 'string') {
    return true;
  }
  var packed = ipv6ToBuffer(ip);
  if (packed) {
    // IPv6 unspecified (::) and loopback (::1) — matched on packed bytes so
    // every equivalent spelling (::, ::0001, 0:0:0:0:0:0:0:1, ::0.0.0.1) is
    // caught, not just the canonical text forms.
    var allZero = true;
    for (var z = 0; z < 16; z++) {
      if (packed[z] !== 0) { allZero = false; break; }
    }
    if (allZero) {
      return true;
    }
    var isLoopback = true;
    for (var l = 0; l < 15; l++) {
      if (packed[l] !== 0) { isLoopback = false; break; }
    }
    if (isLoopback && packed[15] === 1) {
      return true;
    }
    var lowerIP = ip.toLowerCase();
    // IPv6 unique local (fc00::/7)
    if (lowerIP.startsWith('fc') || lowerIP.startsWith('fd')) {
      return true;
    }
    // IPv6 link-local (fe80::/10)
    if (lowerIP.startsWith('fe80')) {
      return true;
    }
    // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96, deprecated):
    // decode the trailing 4 bytes to dotted-quad and re-check.
    var prefixZero = true;
    for (var p = 0; p < 10; p++) {
      if (packed[p] !== 0) { prefixZero = false; break; }
    }
    var isMapped = prefixZero && packed[10] === 0xff && packed[11] === 0xff;
    var isCompat = prefixZero && packed[10] === 0 && packed[11] === 0;
    if (isMapped || isCompat) {
      var v4 = packed[12] + '.' + packed[13] + '.' + packed[14] + '.' + packed[15];
      return isPrivateOrReservedIPv4(v4);
    }
    // any other IPv6 is treated as a public v6 address
    return false;
  }
  // not IPv6 -> treat as IPv4
  return isPrivateOrReservedIPv4(ip);
}

/**
 * Validate that a URL does not resolve to an internal/private/metadata IP.
 * Returns true if the URL is safe to fetch, false otherwise.
 *
 * Security (HAX-SEC-007): checks ALL resolved DNS records (not just the
 * first) so a hostname that round-robins to an internal address is rejected.
 * Matches safeFetch.js assertUrlNotSSRF behavior; the hardened
 * isPrivateOrReservedIP predicate is shared by both paths.
 */
async function validateUrlNotSSRF(urlString) {
  var parsed;
  try {
    parsed = new URL(urlString);
  }
  catch (e) {
    return false;
  }
  var protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return false;
  }
  var hostname = parsed.hostname;
  if (!hostname) {
    return false;
  }
  try {
    var records = await dns.promises.lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      return false;
    }
    for (var i = 0; i < records.length; i++) {
      if (isPrivateOrReservedIP(records[i].address)) {
        return false;
      }
    }
  }
  catch (e) {
    return false;
  }
  return true;
}

// a site object
class HAXCMSFile
{
  /**
   * Save file into this site, optionally updating reference inside the page
   */
  async save(tmpFile, site, page = null, imageOps = null)
  { 
    var returnData = {};
    // check for a file upload
    if (tmpFile['path']) {
      // get contents of the file if it was uploaded into a variable
      let filedata = tmpFile['path'];
      const isBulkImport = !!tmpFile['bulk-import'];
      let pathPart = site.siteDirectory + '/files/';
      // ensure this path exists
      if (!fs.existsSync(pathPart)) {
        fs.mkdirSync(pathPart);
      }
      let incomingName = '';
      if (tmpFile.originalname) {
        incomingName = tmpFile.originalname;
      }
      else if (tmpFile.name) {
        incomingName = tmpFile.name;
      }
      let sanitizedIncomingName = normalizeFilenameExtensionCasing(
        stripExecutableExtensionPatterns(incomingName)
      );
      // ensure file is an image, video, docx, pdf, etc. of safe file types to allow uploading
      if (!sanitizedIncomingName || !ALLOWED_UPLOAD_EXTENSION_PATTERN.test(sanitizedIncomingName)) {
        return {
          'status' : 500,
          'data' : {
            'message' : 'File type not allowed',
          }
        };
      }
      // Security (HAX-SEC-004): enforce the configured maxUploadSizeMb as an
      // app-layer cap. multer's boot-time fileSize limit (1GB) is a separate
      // hard cap; this enforces the site's configured limit (if smaller) using
      // the multer-reported tmpFile.size. The remote-download path is checked
      // separately after the download completes.
      if (typeof tmpFile['size'] === 'number' && tmpFile['size'] > 0) {
        try {
          var sizeSettings = await readMediaSettings(HAXCMS);
          if (sizeSettings && typeof sizeSettings.maxUploadSizeMb === 'number' && sizeSettings.maxUploadSizeMb > 0) {
            var maxBytes = sizeSettings.maxUploadSizeMb * 1024 * 1024;
            if (tmpFile['size'] > maxBytes) {
              return {
                'status': 500,
                'data': {
                  'message': 'File exceeds the maximum upload size of ' + sizeSettings.maxUploadSizeMb + 'MB',
                }
              };
            }
          }
        }
        catch (e) {}
      }
      let newFilename = sanitizedIncomingName.replace(/[\/\\?%*:|"<>]/g, '-').replace(/\s+/g, '-');
      const { name, ext } = path.parse(newFilename);
      let counter = 1;
      while (fs.existsSync(path.join(pathPart, newFilename))) {
        newFilename = `${name}_${counter}${ext}`;
        counter++;
      }
      let sourcePath = filedata;
      let remoteDownloadPath = null;
      if (isBulkImport && !isValidBulkImportStagedPath(filedata)) {
        return {
          'status' : 500,
          'data' : {
            'message' : 'Invalid bulk import source',
          }
        };
      }
      if (!isBulkImport && (filedata.startsWith('https://') || filedata.startsWith('http://'))) {
        // SSRF guard: block requests to internal/private/metadata IPs
        var isUrlSafe = await validateUrlNotSSRF(filedata);
        if (!isUrlSafe) {
          return {
            'status' : 500,
            'data' : {
              'message' : 'URL target is not allowed',
            }
          };
        }
        remoteDownloadPath = path.join(
          HAXCMS.configDirectory,
          'tmp',
          'haxcms-upload-' + Date.now() + '-' + Math.floor(Math.random() * 1000000)
        );
        try {
          await downloadAndSaveFile(filedata, remoteDownloadPath);
          sourcePath = remoteDownloadPath;
          // Security (HAX-SEC-004): enforce the configured maxUploadSizeMb on
          // the downloaded file so URL imports cannot bypass the size cap.
          try {
            var dlStats = fs.statSync(remoteDownloadPath);
            var dlSizeSettings = await readMediaSettings(HAXCMS);
            if (dlSizeSettings && typeof dlSizeSettings.maxUploadSizeMb === 'number' && dlSizeSettings.maxUploadSizeMb > 0) {
              var dlMaxBytes = dlSizeSettings.maxUploadSizeMb * 1024 * 1024;
              if (dlStats.size > dlMaxBytes) {
                fs.removeSync(remoteDownloadPath);
                return {
                  'status': 500,
                  'data': {
                    'message': 'Downloaded file exceeds the maximum upload size of ' + dlSizeSettings.maxUploadSizeMb + 'MB',
                  }
                };
              }
            }
          }
          catch (sizeErr) {}
        }
        catch (err) {
          console.warn(err);
          return {
            'status' : 500,
            'data' : {
              'message' : 'Failed to download remote file source',
            }
          };
        }
      }
      const mimeValidation = await validateUploadMimeAndContent(sourcePath, newFilename);
      if (!mimeValidation.valid) {
        if (remoteDownloadPath && fs.existsSync(remoteDownloadPath)) {
          fs.removeSync(remoteDownloadPath);
        }
        return {
          'status' : 500,
          'data' : {
            'message' : mimeValidation.message,
          }
        };
      }
      const detectedMimeType = mimeValidation.detectedMime;
      let fullpath = path.join(pathPart, newFilename);
      // TOCTOU defense: verify bulk import source is not a symlink right before move
      if (isBulkImport) {
        try {
          var preMoveStats = fs.lstatSync(sourcePath);
          if (preMoveStats.isSymbolicLink()) {
            return {
              'status': 500,
              'data': {
                'message': 'Bulk import source replaced with symlink',
              }
            };
          }
        }
        catch (e) {
          return {
            'status': 500,
            'data': {
              'message': 'Unable to verify bulk import source',
            }
          };
        }
      }
      try {
        fs.moveSync(sourcePath, fullpath);
      }
      catch(err) {
        console.warn(err);
        return {
          status: 500,
          data: {
            message: 'Unable to save file to target location',
          }
        };
      }
      if (detectedMimeType === 'image/jpeg') {
        try {
          await applyConfiguredJpegUploadQuality(fullpath);
        }
        catch (e) {
          console.warn(e);
        }
      }
      //@todo make a way of defining these as returns as well as number to take
      // specialized support for images to do scale and crop stuff automatically
      if (['image/png',
        'image/jpeg',
        'image/gif',
        'image/webp'
        ].includes(detectedMimeType)
      ) {
        // ensure folders exist
        // @todo comment this all in once we have a better way of doing it
        // front end should dictate stuff like this happening and probably
        // can actually accomplish much of it on its own
        /*try {
            fs.mkdir(path + 'scale-50');
            fs.mkdir(path + 'crop-sm');
        } catch (IOExceptionInterface exopenapiception) {
            echo "An error occurred while creating your directory at " +
                exception.getPath();
        }
        image = new ImageResize(fullpath);
        image
            .scale(50)
            .save(path + 'scale-50/' + upload['name'])
            .crop(100, 100)
            .save(path + 'crop-sm/' + upload['name']);*/
        // fake the file object creation stuff from CMS land
        returnData = {
          'file': {
            'path': 'files/' + newFilename,
            'fullUrl': buildFilePublicUrl(site, 'files/' + newFilename),
            'url' : 'files/' + newFilename,
            'type' : detectedMimeType,
            'name' : newFilename,
            'size' : tmpFile['size']
          }
        };
      }
      else {
        // fake the file object creation stuff from CMS land
        returnData = {
            'file':{
                'path': 'files/' + newFilename,
                'fullUrl' : buildFilePublicUrl(site, 'files/' + newFilename),
                'url': 'files/' + newFilename,
                'type': detectedMimeType,
                'name': newFilename,
                'size': tmpFile['size']
            }
        };
      }
      // perform page level reference saving if available
      if (page != null) {
        // now update the page's metadata to suggest it uses this file. FTW!
        if (!(page.metadata.files)) {
          page.metadata.files = [];
        }
        page.metadata.files.push(returnData['file']);
        await site.updateNode(page);
      }
      // perform scale / crop operations if requested
      if (imageOps != null) {
        switch (imageOps) {
          case 'thumbnail':
            const image = await sharp(fullpath)
            .metadata()
            .then(({ width }) => sharp(fullpath)
              .resize({
                width: 250,
                height: 250,
                fit: sharp.fit.cover,
                position: sharp.strategy.entropy
              })
              .toFile(fullpath)
            );
          break;
        }
      }
      return {
          'status': 200,
          'data': returnData
      };
    }
  }
}

async function downloadAndSaveFile(url, filepath) {
  // Security (HAX-SEC-007): do not follow HTTP redirects so an attacker cannot
  // redirect from a validated public IP to a metadata/internal endpoint
  // mid-request. Matches PHP SsrfGuard's max_redirects=0 / FOLLOWLOCATION=false.
  // The SSRF pre-check in HAXCMSFile.save() (validateUrlNotSSRF) already
  // validates the initial URL; this closes the redirect-rebinding variant.
  const response = await Axios({
      url,
      method: 'GET',
      responseType: 'stream',
      maxRedirects: 0
  });
  return new Promise((resolve, reject) => {
      response.data.pipe(fs.createWriteStream(filepath))
          .on('error', reject)
          .once('close', () => resolve(filepath)); 
  });
}

HAXCMSFile.stripExecutableExtensionPatterns = stripExecutableExtensionPatterns;
HAXCMSFile.normalizeFilenameExtensionCasing = normalizeFilenameExtensionCasing;
HAXCMSFile.isValidBulkImportStagedPath = isValidBulkImportStagedPath;
HAXCMSFile.getBulkImportStagingRootPath = getBulkImportStagingRootPath;
HAXCMSFile.isPathWithinRoot = isPathWithinRoot;
HAXCMSFile.isPrivateOrReservedIP = isPrivateOrReservedIP;
HAXCMSFile.validateUrlNotSSRF = validateUrlNotSSRF;
HAXCMSFile.mimeMatchesAllowed = mimeMatchesAllowed;
HAXCMSFile.detectMimeTypeFromContent = detectMimeTypeFromContent;
HAXCMSFile.ALLOWED_MIME_BY_EXTENSION = ALLOWED_MIME_BY_EXTENSION;
module.exports = HAXCMSFile;
