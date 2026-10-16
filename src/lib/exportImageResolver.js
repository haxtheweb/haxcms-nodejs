'use strict';

/**
 * Security (SEC-SSRF): export image resolution.
 *
 * The DOCX (html-to-docx), EPUB (epub-gen-memory) and PDF (puppeteer)
 * exporters all fetch every <img src> they are handed with their own HTTP
 * clients — no SSRF guard, no IP pinning, no byte cap — and epub-gen-memory
 * also reads file:// URLs. Authored page content therefore controlled
 * server-side requests to loopback / LAN / cloud-metadata addresses whose
 * bytes were then embedded in a downloadable document.
 *
 * resolveExportImages() rewrites every <img> BEFORE the HTML reaches an
 * export library so the library never fetches anything itself:
 *   - data:image/(png|jpeg|gif|webp|bmp|svg+xml);base64 -> kept (re-validated)
 *   - relative / site paths (and absolute URLs on the site's own origin)
 *       -> resolved to a regular file inside the site directory (port of PHP
 *          ExportConverters::resolveLocalImageFile: NUL and '..' rejected,
 *          realpath must stay inside realpath(siteDir), tries <site>/<rel>
 *          then <site>/files/<rel>) and embedded; dropped if outside/missing
 *   - remote http(s) / protocol-relative -> fetched through safeFetch (SSRF
 *       guard + pinned IP + byte cap + timeout) and embedded; dropped on any
 *       failure
 *   - any other scheme -> dropped
 * Only bytes whose magic number is an allowlisted image type are embedded.
 * srcset/sizes are removed (the libraries would otherwise fetch them).
 *
 * Output is a data: URI (DOCX, PDF) or a file:// URL to a copy written in a
 * caller-owned temp directory (EPUB: epub-gen-memory derives the media type
 * from the URL extension and cannot type data: URIs).
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { parse } = require('node-html-parser');
const safeFetchLib = require('./safeFetch.js');

const EXPORT_IMAGE_FETCH_TIMEOUT_MS = 8000;
const EXPORT_IMAGE_CONCURRENCY = 8;
// Node-side guard on the total bytes embedded into a single export document so
// a page with hundreds of large images cannot exhaust memory.
const EXPORT_IMAGE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

const ALLOWED_IMAGE_MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/**
 * Identify an allowlisted image type from its leading bytes. Returns the
 * mime type or null. Declared Content-Type / file extensions are ignored.
 */
function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 4) {
    return null;
  }
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6) {
    var gifHeader = buffer.toString('ascii', 0, 6);
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
      return 'image/gif';
    }
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d && buffer.length >= 26) {
    return 'image/bmp';
  }
  var head = buffer.toString('utf8', 0, Math.min(buffer.length, 1024)).replace(/^﻿/, '').trimStart();
  if (head.charAt(0) === '<' && /<svg[\s>]/i.test(head)) {
    return 'image/svg+xml';
  }
  return null;
}

function normalizeBasePath(basePath) {
  var value = String(basePath || '/').trim();
  if (value === '') {
    return '/';
  }
  if (value.charAt(0) !== '/') {
    value = '/' + value;
  }
  if (value.charAt(value.length - 1) !== '/') {
    value += '/';
  }
  return value;
}

/**
 * Port of PHP ExportConverters::resolveLocalImageFile. Resolve a relative or
 * site-relative image path to a realpath inside realSiteDir, or '' when it
 * cannot be found, is not a regular file, or escapes the site directory.
 */
function resolveLocalImageFile(src, normalizedBase, realSiteDir) {
  var value = String(src || '').trim();
  if (value === '' || value.indexOf('\0') !== -1 || !realSiteDir) {
    return '';
  }
  // drop query / fragment, then percent-decode (files/my%20image.png)
  value = value.replace(/[?#].*$/, '');
  try {
    value = decodeURIComponent(value);
  }
  catch (e) {
    return '';
  }
  if (value.indexOf('\0') !== -1 || value.indexOf('\\') !== -1) {
    return '';
  }
  var relative = value;
  var base = normalizeBasePath(normalizedBase);
  if (base !== '/' && relative.indexOf(base) === 0) {
    relative = relative.substring(base.length);
  }
  relative = relative.replace(/^\/+/, '');
  if (relative === '' || relative.indexOf('..') !== -1) {
    return '';
  }
  var candidates = [
    path.join(realSiteDir, relative),
    path.join(realSiteDir, 'files', relative),
  ];
  for (var i = 0; i < candidates.length; i++) {
    var realCandidate;
    try {
      realCandidate = fs.realpathSync(candidates[i]);
    }
    catch (e) {
      continue;
    }
    if (realCandidate !== realSiteDir && realCandidate.indexOf(realSiteDir + path.sep) !== 0) {
      continue;
    }
    try {
      if (!fs.statSync(realCandidate).isFile()) {
        continue;
      }
    }
    catch (e) {
      continue;
    }
    return realCandidate;
  }
  return '';
}

function stripControlAndWhitespace(value) {
  // browsers ignore embedded tab/CR/LF and leading C0/space in URLs
  return String(value || '').replace(/[\u0000- \u007f]+/g, '');
}

function parseImageDataUri(value) {
  var match = /^data:(image\/(?:png|jpeg|jpg|gif|webp|bmp|svg\+xml))(?:;[a-z0-9=._-]+)*;base64,([a-z0-9+/=]+)$/i.exec(value);
  if (!match) {
    return null;
  }
  var buffer;
  try {
    buffer = Buffer.from(match[2], 'base64');
  }
  catch (e) {
    return null;
  }
  var mime = sniffImageMime(buffer);
  if (!mime) {
    return null;
  }
  return { buffer: buffer, mime: mime };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  }
  catch (e) {
    return false;
  }
}

/**
 * Classify one src value. Returns { kind: 'data'|'local'|'remote'|'drop', value }.
 */
function classifyImageSource(src, options) {
  var opts = options || {};
  var value = stripControlAndWhitespace(src);
  if (value === '') {
    return { kind: 'drop', value: '' };
  }
  if (/^data:/i.test(value)) {
    return { kind: 'data', value: value };
  }
  if (value.indexOf('//') === 0) {
    value = 'https:' + value;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (!isHttpUrl(value)) {
      return { kind: 'drop', value: value };
    }
    // An absolute URL on the site's own origin is a local file reference
    // (normalizeHtmlForDocumentExport absolutises PDF srcs against it); never
    // fetch our own host over the network.
    if (opts.selfBaseUrl && opts.siteDir && sameOrigin(value, opts.selfBaseUrl)) {
      var parsedSelf = new URL(value);
      return { kind: 'local', value: parsedSelf.pathname };
    }
    return { kind: 'remote', value: value };
  }
  if (opts.siteDir) {
    return { kind: 'local', value: value };
  }
  if (opts.remoteBaseUrl && isHttpUrl(opts.remoteBaseUrl)) {
    try {
      return { kind: 'remote', value: new URL(value, opts.remoteBaseUrl).toString() };
    }
    catch (e) {
      return { kind: 'drop', value: value };
    }
  }
  return { kind: 'drop', value: value };
}

function getRealSiteDir(siteDir) {
  if (!siteDir) {
    return '';
  }
  try {
    var real = fs.realpathSync(String(siteDir));
    return fs.statSync(real).isDirectory() ? real : '';
  }
  catch (e) {
    return '';
  }
}

function resolveMaxBytes(value) {
  if (typeof value === 'number' && value > 0) {
    return value;
  }
  return safeFetchLib.SAFE_FETCH_DEFAULT_MAX_BYTES;
}

/**
 * Resolve one image src to embeddable bytes. Returns { buffer, mime } or null
 * (caller drops the image). Never throws.
 */
async function resolveExportImageSource(src, options) {
  var opts = options || {};
  var maxBytes = resolveMaxBytes(opts.maxBytes);
  var classified = classifyImageSource(src, opts);
  try {
    if (classified.kind === 'data') {
      var data = parseImageDataUri(classified.value);
      if (!data || data.buffer.length > maxBytes) {
        return null;
      }
      return data;
    }
    if (classified.kind === 'local') {
      var realSiteDir = opts.realSiteDir || getRealSiteDir(opts.siteDir);
      var filePath = resolveLocalImageFile(classified.value, opts.siteBasePath || '/', realSiteDir);
      if (!filePath) {
        return null;
      }
      if (fs.statSync(filePath).size > maxBytes) {
        return null;
      }
      var localBuffer = fs.readFileSync(filePath);
      var localMime = sniffImageMime(localBuffer);
      return localMime ? { buffer: localBuffer, mime: localMime } : null;
    }
    if (classified.kind === 'remote') {
      var response = await safeFetchLib.safeFetch(classified.value, {
        maxBytes: maxBytes,
        timeoutMs: opts.fetchTimeoutMs || EXPORT_IMAGE_FETCH_TIMEOUT_MS,
        headers: { accept: 'image/*' },
      });
      if (!response || !response.ok) {
        return null;
      }
      var remoteBuffer = Buffer.from(await response.arrayBuffer());
      var remoteMime = sniffImageMime(remoteBuffer);
      return remoteMime ? { buffer: remoteBuffer, mime: remoteMime } : null;
    }
  }
  catch (e) {
    return null;
  }
  return null;
}

/**
 * Turn resolved bytes into the src the export library receives.
 */
function materializeImage(resolved, options, counter) {
  var opts = options || {};
  if (opts.output === 'file') {
    if (!opts.tempDir) {
      return '';
    }
    var ext = ALLOWED_IMAGE_MIME_EXTENSIONS[resolved.mime] || 'img';
    // unique per file: the same tempDir is shared by every chapter of an EPUB
    var target = path.join(opts.tempDir, 'export-image-' + counter + '-' + crypto.randomBytes(8).toString('hex') + '.' + ext);
    fs.writeFileSync(target, resolved.buffer, { mode: 0o600, flag: 'wx' });
    return pathToFileURL(target).toString();
  }
  return 'data:' + resolved.mime + ';base64,' + resolved.buffer.toString('base64');
}

async function mapWithConcurrency(items, limit, fn) {
  var cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      var current = cursor;
      cursor += 1;
      await fn(items[current], current);
    }
  }
  var workers = [];
  var count = Math.max(1, Math.min(limit, items.length));
  for (var i = 0; i < count; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

/**
 * Rewrite every <img> in html as described in the module comment.
 *
 * options:
 *   siteDir        site directory; enables local resolution (site exports)
 *   siteBasePath   site base path stripped from site-absolute srcs ('/sites/x/')
 *   selfBaseUrl    absolute URL of the site; same-origin srcs are local
 *   remoteBaseUrl  without siteDir: resolve relative srcs against this http(s)
 *                  URL and fetch them through safeFetch (system convert routes)
 *   output         'data-uri' (default) or 'file' (requires tempDir)
 *   tempDir        directory for output 'file'
 *   maxBytes       per-image cap (default safeFetch 20 MB)
 *   maxTotalBytes  per-document cap (default 100 MB); later images dropped
 */
async function resolveExportImages(html, options) {
  if (!html) {
    return html;
  }
  var opts = Object.assign({}, options || {});
  opts.realSiteDir = getRealSiteDir(opts.siteDir);
  if (!opts.realSiteDir) {
    opts.siteDir = null;
  }
  var maxTotalBytes = typeof opts.maxTotalBytes === 'number' && opts.maxTotalBytes > 0
    ? opts.maxTotalBytes
    : EXPORT_IMAGE_MAX_TOTAL_BYTES;
  var htmlString = String(html);
  var trimmed = htmlString.trim().toLowerCase();
  var isFullDocument = trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
  var doc;
  try {
    doc = isFullDocument
      ? parse(htmlString)
      : parse('<div id="haxcms-export-image-wrapper">' + htmlString + '</div>');
  }
  catch (e) {
    // fail closed: if we cannot rewrite images, strip every <img> tag
    return htmlString.replace(/<img\b[^>]*>/gi, '');
  }
  // srcset / sizes would let the library (or Chrome) fetch other candidates
  var withSrcset = doc.querySelectorAll('[srcset]');
  for (var s = 0; s < withSrcset.length; s++) {
    withSrcset[s].removeAttribute('srcset');
    withSrcset[s].removeAttribute('sizes');
  }
  var images = doc.querySelectorAll('img');
  var totalBytes = 0;
  var counter = 0;
  await mapWithConcurrency(images, EXPORT_IMAGE_CONCURRENCY, async function (img) {
    var resolved = await resolveExportImageSource(img.getAttribute('src'), opts);
    if (!resolved || totalBytes + resolved.buffer.length > maxTotalBytes) {
      img.remove();
      return;
    }
    totalBytes += resolved.buffer.length;
    counter += 1;
    var newSrc = '';
    try {
      newSrc = materializeImage(resolved, opts, counter);
    }
    catch (e) {
      newSrc = '';
    }
    if (!newSrc) {
      img.remove();
      return;
    }
    img.setAttribute('src', newSrc);
  });
  if (isFullDocument) {
    return doc.toString();
  }
  var wrapper = doc.querySelector('#haxcms-export-image-wrapper');
  return wrapper ? wrapper.innerHTML : '';
}

/**
 * Resolve a single image reference (e.g. the EPUB cover) to a file:// URL in
 * tempDir, or '' when it cannot be resolved safely.
 */
async function resolveExportImageToFileUrl(src, options) {
  var opts = Object.assign({}, options || {}, { output: 'file' });
  opts.realSiteDir = getRealSiteDir(opts.siteDir);
  if (!opts.realSiteDir) {
    opts.siteDir = null;
  }
  var resolved = await resolveExportImageSource(src, opts);
  if (!resolved) {
    return '';
  }
  try {
    return materializeImage(resolved, opts, 'cover');
  }
  catch (e) {
    return '';
  }
}

/**
 * Security (SEC-SSRF): request filter for the PDF renderer. After image
 * inlining nothing in the document needs the network, so Chrome may only
 * load data: URIs and about:blank/about:srcdoc; every other request
 * (http(s), file:, ws:, CSS url(), <link>, <object>, fonts ...) is aborted.
 */
function isAllowedPdfRequestUrl(url) {
  var value = String(url || '').trim().toLowerCase();
  if (value.indexOf('data:') === 0) {
    return true;
  }
  return value === 'about:blank' || value === 'about:srcdoc';
}

/**
 * Enable puppeteer request interception on page and abort everything that
 * isAllowedPdfRequestUrl rejects.
 */
async function installPdfRequestFilter(page) {
  await page.setRequestInterception(true);
  page.on('request', function (request) {
    try {
      if (isAllowedPdfRequestUrl(request.url())) {
        request.continue();
      }
      else {
        request.abort('blockedbyclient');
      }
    }
    catch (e) {
      // request already handled / page closed
    }
  });
}

module.exports = {
  resolveExportImages,
  resolveExportImageSource,
  resolveExportImageToFileUrl,
  resolveLocalImageFile,
  classifyImageSource,
  sniffImageMime,
  isAllowedPdfRequestUrl,
  installPdfRequestFilter,
  EXPORT_IMAGE_MAX_TOTAL_BYTES,
};
