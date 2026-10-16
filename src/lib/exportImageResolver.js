'use strict';

// Security (review 2026-10): resolve every <img src> in export HTML to bytes
// BEFORE the HTML reaches a converter (html-to-docx, epub-gen-memory,
// Puppeteer). Those engines fetch image URLs themselves with no SSRF guard
// (html-to-docx and epub-gen-memory use a bundled node-fetch; epub-gen-memory
// also reads file:// URLs; Chrome fetches anything), so an authored
// <img src="http://169.254.169.254/..."> made the server fetch cloud metadata
// and embed the response in the export. Here:
//   - data: URIs are decoded, checked to really be an image, and re-encoded;
//   - site-relative srcs are read from disk, confined to the site directory
//     (mirrors PHP ExportConverters::resolveLocalImageFile);
//   - remote http(s) srcs go through safeFetch (DNS-pinned, private/reserved
//     ranges rejected, per-image byte cap) and are kept only when the bytes
//     are an image;
//   - everything else is dropped.
// The converters then only ever see data: URIs (or placeholders the caller
// maps to bytes), so they never perform a network or filesystem fetch.

const fs = require('fs');
const path = require('path');
const { parse } = require('node-html-parser');
// reached through the module object so the network boundary can be stubbed in tests
const safeFetchLib = require('./safeFetch.js');

const DEFAULT_EXPORT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
// total bytes of images one export may inline, so a page with thousands of
// large images cannot exhaust memory
const DEFAULT_EXPORT_IMAGE_TOTAL_BYTES = 256 * 1024 * 1024;
const EXPORT_IMAGE_FETCH_TIMEOUT_MS = 15000;
const EXPORT_IMAGE_CONCURRENCY = 8;

const IMAGE_EXTENSION_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/**
 * Identify image bytes by their magic number. Returns the MIME type or null.
 * Content-Type headers are not trusted: an HTML error page served as
 * image/png must not be embedded.
 */
function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 4) {
    return null;
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.slice(0, 4).toString('ascii') === 'GIF8') {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }
  // SVG: text that starts (after an optional BOM, XML prolog, comments or
  // doctype) with an <svg element
  const head = buffer.slice(0, 1024).toString('utf8').replace(/^﻿/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return 'image/svg+xml';
  }
  return null;
}

function toDataUri(buffer, mime) {
  return 'data:' + mime + ';base64,' + buffer.toString('base64');
}

function isAbsoluteHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

/**
 * Strip a known base prefix (site base path such as /sites/demo/ or the
 * absolute PDF base http://host/sites/demo/) from a src so it becomes
 * site-relative. Returns { relative, matched }.
 */
function stripBasePrefix(src, basePaths) {
  const value = String(src || '');
  const list = Array.isArray(basePaths) ? basePaths : [];
  for (let i = 0; i < list.length; i++) {
    let base = String(list[i] || '');
    if (base === '' || base === '/') {
      continue;
    }
    if (base.charAt(base.length - 1) !== '/') {
      base += '/';
    }
    if (value.indexOf(base) === 0) {
      return { relative: value.slice(base.length), matched: true };
    }
  }
  return { relative: value, matched: false };
}

/**
 * Resolve a relative or site-relative image src to a real file inside the
 * site directory. Returns the realpath, or '' when the file does not exist,
 * is not a regular file, or escapes the site directory.
 * Mirrors PHP ExportConverters::resolveLocalImageFile.
 */
function resolveLocalExportImageFile(src, basePaths, siteDirectory) {
  let value = String(src || '').trim();
  if (value === '' || value.indexOf('\0') !== -1 || !siteDirectory) {
    return '';
  }
  let realSiteDir;
  try {
    realSiteDir = fs.realpathSync(String(siteDirectory));
  } catch (e) {
    return '';
  }
  // drop a query string / fragment, then any base prefix
  value = value.split(/[?#]/)[0];
  let relative = stripBasePrefix(value, basePaths).relative;
  try {
    relative = decodeURIComponent(relative);
  } catch (e) {
    return '';
  }
  relative = relative.replace(/^\/+/, '');
  if (relative === '' || relative.indexOf('..') !== -1 || relative.indexOf('\0') !== -1) {
    return '';
  }
  const candidates = [
    path.join(realSiteDir, relative),
    path.join(realSiteDir, 'files', relative),
  ];
  for (let i = 0; i < candidates.length; i++) {
    let realCandidate;
    try {
      realCandidate = fs.realpathSync(candidates[i]);
    } catch (e) {
      continue;
    }
    if (realCandidate !== realSiteDir && realCandidate.indexOf(realSiteDir + path.sep) !== 0) {
      continue;
    }
    try {
      if (!fs.statSync(realCandidate).isFile()) {
        continue;
      }
    } catch (e) {
      continue;
    }
    return realCandidate;
  }
  return '';
}

function decodeDataUri(src, maxBytes) {
  const match = /^data:([^,]*?),(.*)$/is.exec(String(src || '').trim());
  if (!match) {
    return null;
  }
  const isBase64 = /;base64$/i.test(match[1]);
  let buffer;
  try {
    buffer = isBase64
      ? Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
      : Buffer.from(decodeURIComponent(match[2]), 'utf8');
  } catch (e) {
    return null;
  }
  if (!buffer.length || buffer.length > maxBytes) {
    return null;
  }
  const mime = sniffImageMime(buffer);
  return mime ? { buffer: buffer, mime: mime } : null;
}

function readLocalImage(filePath, maxBytes) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) {
      return null;
    }
    const buffer = fs.readFileSync(filePath);
    const mime = sniffImageMime(buffer);
    return mime ? { buffer: buffer, mime: mime } : null;
  } catch (e) {
    return null;
  }
}

async function fetchRemoteImage(url, maxBytes) {
  try {
    const response = await safeFetchLib.safeFetch(url, {
      maxBytes: maxBytes,
      timeoutMs: EXPORT_IMAGE_FETCH_TIMEOUT_MS,
      headers: { accept: 'image/*' },
    });
    if (!response || !response.ok) {
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > maxBytes) {
      return null;
    }
    const mime = sniffImageMime(buffer);
    return mime ? { buffer: buffer, mime: mime } : null;
  } catch (e) {
    // SSRF rejection, byte cap, timeout, DNS failure: the image is dropped
    return null;
  }
}

/**
 * Load the bytes behind one <img src>. Returns { buffer, mime } or null.
 *
 * options:
 *  - siteDirectory: site root for site-relative srcs (omit for no local reads)
 *  - basePaths: prefixes that mark a src as site-relative (site base path,
 *    absolute export base URL)
 *  - baseUrl: absolute http(s) URL relative srcs resolve against when they
 *    are not found on disk (system html-to-pdf route's user-supplied base)
 *  - maxBytes: per-image byte cap
 *  - allowRemote: false to never fetch (defaults to true)
 */
async function loadExportImage(src, options) {
  const opts = options || {};
  const maxBytes = opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_EXPORT_IMAGE_MAX_BYTES;
  const allowRemote = opts.allowRemote !== false;
  const value = String(src || '').trim();
  if (value === '') {
    return null;
  }
  if (/^data:/i.test(value)) {
    return decodeDataUri(value, maxBytes);
  }
  const stripped = stripBasePrefix(value, opts.basePaths);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  const isProtocolRelative = value.indexOf('//') === 0;
  if (stripped.matched || (!hasScheme && !isProtocolRelative)) {
    if (opts.siteDirectory) {
      const localFile = resolveLocalExportImageFile(value, opts.basePaths, opts.siteDirectory);
      if (localFile) {
        return readLocalImage(localFile, maxBytes);
      }
    }
    // not on disk: a relative src may still be resolvable against an
    // explicit absolute base URL (fetched through the guard below)
    if (!hasScheme && !isProtocolRelative && isAbsoluteHttpUrl(opts.baseUrl)) {
      let absolute;
      try {
        absolute = new URL(value, opts.baseUrl).toString();
      } catch (e) {
        return null;
      }
      return allowRemote ? fetchRemoteImage(absolute, maxBytes) : null;
    }
    if (!stripped.matched || !isAbsoluteHttpUrl(value)) {
      return null;
    }
  }
  let remoteUrl = value;
  if (isProtocolRelative) {
    remoteUrl = 'https:' + value;
  }
  if (!isAbsoluteHttpUrl(remoteUrl) || !allowRemote) {
    // file:, javascript:, ftp:, blob: ... are never followed
    return null;
  }
  return fetchRemoteImage(remoteUrl, maxBytes);
}

/**
 * Run async work over a list with bounded concurrency.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await fn(items[current], current);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Rewrite every <img> in an HTML string so its src is a value the converter
 * can embed without fetching: by default a data: URI; with options.rewrite
 * (img element, loaded {buffer, mime, ext}) => string, whatever the caller
 * maps (EPUB placeholders). <img> elements whose bytes cannot be resolved
 * safely are removed. srcset/sizes are dropped, and <source> elements (which
 * a browser would fetch) are removed. Loads are deduplicated per src and
 * bounded by options.maxTotalBytes.
 */
async function inlineExportImages(html, options) {
  const opts = options || {};
  if (!html) {
    return html;
  }
  const htmlString = String(html);
  const trimmed = htmlString.trim().toLowerCase();
  const isFullDocument = trimmed.indexOf('<!doctype') === 0 || trimmed.indexOf('<html') === 0;
  const doc = isFullDocument
    ? parse(htmlString)
    : parse('<div id="haxcms-export-image-wrapper">' + htmlString + '</div>');
  const sources = doc.querySelectorAll('source');
  for (let i = 0; i < sources.length; i++) {
    sources[i].remove();
  }
  const images = doc.querySelectorAll('img');
  const maxTotalBytes = opts.maxTotalBytes > 0 ? opts.maxTotalBytes : DEFAULT_EXPORT_IMAGE_TOTAL_BYTES;
  const cache = opts.cache instanceof Map ? opts.cache : new Map();
  let totalBytes = 0;
  await mapWithConcurrency(images, EXPORT_IMAGE_CONCURRENCY, async (img) => {
    const src = String(img.getAttribute('src') || '').trim();
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    if (src === '') {
      img.remove();
      return;
    }
    if (!cache.has(src)) {
      cache.set(src, loadExportImage(src, opts));
    }
    const loaded = await cache.get(src);
    if (!loaded || totalBytes + loaded.buffer.length > maxTotalBytes) {
      img.remove();
      return;
    }
    totalBytes += loaded.buffer.length;
    const withExt = {
      buffer: loaded.buffer,
      mime: loaded.mime,
      ext: IMAGE_EXTENSION_BY_MIME[loaded.mime] || 'bin',
    };
    const newSrc = typeof opts.rewrite === 'function'
      ? opts.rewrite(img, withExt, src)
      : toDataUri(withExt.buffer, withExt.mime);
    if (!newSrc) {
      img.remove();
      return;
    }
    img.setAttribute('src', newSrc);
  });
  if (isFullDocument) {
    return doc.toString();
  }
  const wrapper = doc.querySelector('#haxcms-export-image-wrapper');
  return wrapper ? wrapper.innerHTML : '';
}

/**
 * Fallback when the resolver itself fails: remove every <img>/<source> so the
 * converter still cannot fetch anything.
 */
function stripAllImages(html) {
  return String(html || '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<source\b[^>]*>/gi, '');
}

module.exports = {
  inlineExportImages,
  loadExportImage,
  resolveLocalExportImageFile,
  sniffImageMime,
  stripAllImages,
  toDataUri,
  DEFAULT_EXPORT_IMAGE_MAX_BYTES,
  DEFAULT_EXPORT_IMAGE_TOTAL_BYTES,
  IMAGE_EXTENSION_BY_MIME,
};
