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
 *   - data:image/(png|jpeg|gif|webp|bmp);base64 -> kept (re-validated; svg+xml
 *       only when allowSvg, i.e. for the PDF renderer)
 *   - relative / site paths (and absolute URLs on the site's own origin)
 *       -> resolved to a regular file inside the site directory (port of PHP
 *          ExportConverters::resolveLocalImageFile: NUL and '..' rejected,
 *          realpath must stay inside realpath(siteDir), tries <site>/<rel>
 *          then <site>/files/<rel>) and embedded; dropped if outside/missing
 *   - remote http(s) / protocol-relative -> fetched through safeFetch (SSRF
 *       guard + pinned IP + byte cap + timeout) and embedded; dropped on any
 *       failure
 *   - any other scheme -> dropped
 * Only bytes whose magic number is an allowlisted image type are embedded
 * (png/jpeg/gif/webp/bmp; svg only for the PDF renderer). srcset/sizes are
 * removed and <img> keeps only src/alt/width/height/title.
 *
 * Parsing uses htmlparser2 — the tokenizer html-to-docx (via html-to-vdom)
 * and epub-gen-memory use — so markup such as <img/src=...> or <IMG SRC=...>
 * is seen as an image exactly as the consumers see it. finalizeExportHtml()
 * then re-parses the serialised result with each consumer's OWN htmlparser2
 * build immediately before the hand-off and fails closed (plus a regex
 * backstop on the final string).
 *
 * A per-export budget (default 50 MB, HAXCMS_EXPORT_IMAGE_MAX_TOTAL_BYTES)
 * bounds the total embedded bytes; images past the budget are dropped.
 *
 * Output is a data: URI (DOCX, PDF) or a file:// URL to a copy written in a
 * caller-owned temp directory (EPUB: epub-gen-memory derives the media type
 * from the URL extension and cannot type data: URIs).
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const htmlparser2 = require('htmlparser2');
const renderDom = require('dom-serializer').default;
const safeFetchLib = require('./safeFetch.js');

const EXPORT_IMAGE_FETCH_TIMEOUT_MS = 8000;
const EXPORT_IMAGE_CONCURRENCY = 8;
// Per-export budget on the total bytes embedded (all chapters of an EPUB
// share one budget). Parity with PHP: 50 MB default. Override with
// HAXCMS_EXPORT_IMAGE_MAX_TOTAL_BYTES (same style as the safeFetch cap).
const EXPORT_IMAGE_DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const EXPORT_IMAGE_MAX_TOTAL_BYTES = EXPORT_IMAGE_DEFAULT_MAX_TOTAL_BYTES;

function getExportImageMaxTotalBytes() {
  var fromEnv = parseInt(process.env.HAXCMS_EXPORT_IMAGE_MAX_TOTAL_BYTES || '', 10);
  if (!isNaN(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return EXPORT_IMAGE_DEFAULT_MAX_TOTAL_BYTES;
}

/**
 * Create a byte budget shared by every resolveExportImages /
 * resolveExportImageToFileUrl call of one export.
 */
function createExportImageBudget(maxTotalBytes) {
  var total = typeof maxTotalBytes === 'number' && maxTotalBytes > 0
    ? maxTotalBytes
    : getExportImageMaxTotalBytes();
  return { remaining: total, total: total };
}

function takeFromBudget(budget, size) {
  if (!budget || size > budget.remaining) {
    return false;
  }
  budget.remaining -= size;
  return true;
}

// raster types every consumer may embed (PHP parity drops svg for docx/epub)
const RASTER_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];

function isEmbeddableMime(mime, options) {
  if (RASTER_IMAGE_MIMES.indexOf(mime) !== -1) {
    return true;
  }
  return mime === 'image/svg+xml' && !!(options && options.allowSvg);
}

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
  catch {
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
    catch {
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
    catch {
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
  catch {
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
  catch {
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
    catch {
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
  catch {
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
      if (!data || data.buffer.length > maxBytes || !isEmbeddableMime(data.mime, opts)) {
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
      return localMime && isEmbeddableMime(localMime, opts) ? { buffer: localBuffer, mime: localMime } : null;
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
      return remoteMime && isEmbeddableMime(remoteMime, opts) ? { buffer: remoteBuffer, mime: remoteMime } : null;
    }
  }
  catch {
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

// attributes an <img> may keep after the rewrite (anything else could carry a
// URL a consumer might fetch, e.g. lowsrc, dynsrc, longdesc, data-src)
const IMG_KEEP_ATTRIBUTES = ['alt', 'width', 'height', 'title'];

function findElements(nodes, predicate) {
  return htmlparser2.DomUtils.findAll(predicate, nodes);
}

// attribute values kept on <img> are reduced to plain text without the
// characters that could end a quoted attribute or a tag in any serializer
function cleanKeptAttributeValue(value) {
  return String(value).replace(/[<>"\u0000-\u001f]/g, ' ');
}

/**
 * Remove a node from its tree. htmlparser2 3.x (html-to-vdom) leaves
 * top-level nodes with parent === null, where DomUtils.removeElement only
 * unlinks siblings; splice those out of the root array instead.
 */
function removeNode(node, rootNodes) {
  var siblings = node.parent && node.parent.children ? node.parent.children : rootNodes;
  if (node.prev) {
    node.prev.next = node.next;
  }
  if (node.next) {
    node.next.prev = node.prev;
  }
  var index = siblings ? siblings.indexOf(node) : -1;
  if (index !== -1) {
    siblings.splice(index, 1);
  }
  node.parent = null;
  node.prev = null;
  node.next = null;
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
 *   allowSvg       also embed image/svg+xml (PDF only)
 *   maxBytes       per-image cap (default safeFetch 20 MB)
 *   budget         shared per-export budget (createExportImageBudget); when
 *                  omitted a fresh one is created from maxTotalBytes
 *   maxTotalBytes  budget size when no budget is passed (default 50 MB)
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
  var budget = opts.budget || createExportImageBudget(opts.maxTotalBytes);
  var doc;
  try {
    // default options = what epub-gen-memory uses; html-to-vdom only differs
    // in keeping attribute-name case, which this pass normalises away
    doc = htmlparser2.parseDocument(String(html));
  }
  catch {
    // fail closed: if we cannot rewrite images, strip every <img> tag
    return String(html).replace(/<img(?![a-z0-9_:.-])[^>]*(?:>|$)/gi, '');
  }
  // srcset / sizes would let the library (or Chrome) fetch other candidates
  var all = findElements(doc.children, function () { return true; });
  for (var a = 0; a < all.length; a++) {
    var attribs = all[a].attribs || {};
    var names = Object.keys(attribs);
    for (var n = 0; n < names.length; n++) {
      var lower = names[n].toLowerCase();
      if (lower === 'srcset' || lower === 'sizes') {
        delete attribs[names[n]];
      }
    }
  }
  var images = findElements(doc.children, function (el) {
    return String(el.name || '').toLowerCase() === 'img';
  });
  var counter = 0;
  await mapWithConcurrency(images, EXPORT_IMAGE_CONCURRENCY, async function (img) {
    var src = img.attribs && Object.prototype.hasOwnProperty.call(img.attribs, 'src') ? img.attribs.src : '';
    var resolved = await resolveExportImageSource(src, opts);
    if (!resolved || !takeFromBudget(budget, resolved.buffer.length)) {
      removeNode(img, doc.children);
      return;
    }
    counter += 1;
    var newSrc = '';
    try {
      newSrc = materializeImage(resolved, opts, counter);
    }
    catch {
      newSrc = '';
    }
    if (!newSrc) {
      removeNode(img, doc.children);
      return;
    }
    var kept = { src: newSrc };
    for (var k = 0; k < IMG_KEEP_ATTRIBUTES.length; k++) {
      var keepName = IMG_KEEP_ATTRIBUTES[k];
      if (img.attribs && typeof img.attribs[keepName] === 'string') {
        kept[keepName] = cleanKeptAttributeValue(img.attribs[keepName]);
      }
    }
    img.attribs = kept;
  });
  // emptyAttrs: alt="" stays alt="" (the final pass expects name="value")
  return renderDom(doc, { emptyAttrs: true });
}

/**
 * Resolve a single image reference (e.g. the EPUB cover) to a file:// URL in
 * tempDir, or '' when it cannot be resolved safely. Counts against
 * options.budget when given.
 */
async function resolveExportImageToFileUrl(src, options) {
  var opts = Object.assign({}, options || {}, { output: 'file' });
  opts.realSiteDir = getRealSiteDir(opts.siteDir);
  if (!opts.realSiteDir) {
    opts.siteDir = null;
  }
  var budget = opts.budget || createExportImageBudget(opts.maxTotalBytes);
  var resolved = await resolveExportImageSource(src, opts);
  if (!resolved || !takeFromBudget(budget, resolved.buffer.length)) {
    return '';
  }
  try {
    return materializeImage(resolved, opts, 'cover');
  }
  catch {
    return '';
  }
}

// --- final fail-closed pass -------------------------------------------------

// Each consumer's own htmlparser2 build, resolved from the consumer's
// location so the guard tokenises exactly as the library will.
function loadConsumerParser(consumer) {
  // html-to-vdom is resolved the way html-to-docx itself resolves it
  var anchor = consumer === 'docx'
    ? require.resolve('html-to-vdom/lib/parse-html.js', { paths: [path.dirname(require.resolve('html-to-docx'))] })
    : require.resolve('epub-gen-memory');
  var parserPath = require.resolve('htmlparser2', { paths: [path.dirname(anchor)] });
  return require(parserPath);
}

function parseLikeConsumer(consumer, html) {
  var lib = loadConsumerParser(consumer);
  if (consumer === 'docx') {
    // html-to-vdom/lib/parse-html.js (htmlparser2 3.x)
    var handler = new lib.DomHandler();
    var parser = new lib.Parser(handler, { lowerCaseAttributeNames: false });
    parser.parseComplete(html);
    return {
      nodes: handler.dom,
      render: function (nodes) { return lib.DomUtils.getOuterHTML(nodes); },
      domUtils: lib.DomUtils,
    };
  }
  // epub-gen-memory/dist/lib/util/html-parse.js (htmlparser2 7.x)
  var doc = lib.parseDocument(html);
  var serializerPath = require.resolve('dom-serializer', { paths: [path.dirname(require.resolve('epub-gen-memory'))] });
  var serialize = require(serializerPath).default;
  return {
    nodes: doc.children,
    render: function () { return serialize(doc, { emptyAttrs: true }); },
    domUtils: lib.DomUtils,
  };
}

function isAllowedFinalImageSrc(value, options) {
  var opts = options || {};
  var src = String(value || '');
  var mimes = opts.allowSvg ? RASTER_IMAGE_MIMES.concat(['image/svg+xml']) : RASTER_IMAGE_MIMES;
  var dataMatch = /^data:(image\/[a-z+]+);base64,[A-Za-z0-9+/=]+$/.exec(src);
  if (dataMatch) {
    return mimes.indexOf(dataMatch[1]) !== -1;
  }
  if (opts.tempDir && src.indexOf('file://') === 0) {
    var filePath;
    try {
      filePath = require('url').fileURLToPath(src);
    }
    catch {
      return false;
    }
    var base = path.basename(filePath);
    if (!/^export-image-[A-Za-z0-9-]+\.(png|jpg|gif|webp|bmp)$/.test(base)) {
      return false;
    }
    if (path.join(opts.tempDir, base) !== filePath || pathToFileURL(filePath).toString() !== src) {
      return false;
    }
    try {
      return fs.lstatSync(filePath).isFile();
    }
    catch {
      return false;
    }
  }
  return false;
}

// tags removed outright before hand-off (they can reference external
// resources and nothing in an export needs them)
const FINAL_REMOVE_TAGS = ['image', 'object', 'embed', 'link'];

/**
 * Security (SEC-SSRF): last pass on the exact string handed to html-to-docx
 * (consumer 'docx') or epub-gen-memory (consumer 'epub'). Re-parses with that
 * consumer's own htmlparser2 and removes every <img> whose src (any case of
 * the attribute name) is not an allowed data: URI or one of our temp files,
 * every srcset attribute, <image>/<object>/<embed>/<link>/<input type=image>,
 * and <video poster>. Then a regex backstop removes any remaining
 * `<img` tag text that is not in the exact canonical shape this pass emits.
 * Never throws: on any error every <img ...> is stripped.
 */
function finalizeExportHtml(html, options) {
  var opts = options || {};
  var consumer = opts.consumer === 'docx' ? 'docx' : 'epub';
  var output;
  try {
    var parsed = parseLikeConsumer(consumer, String(html || ''));
    var DomUtils = parsed.domUtils;
    var elements = DomUtils.findAll(function () { return true; }, parsed.nodes);
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var tag = String(el.name || '').toLowerCase();
      var attribs = el.attribs || {};
      var names = Object.keys(attribs);
      var lowerMap = {};
      for (var n = 0; n < names.length; n++) {
        var lower = names[n].toLowerCase();
        if (lower === 'srcset' || (tag === 'video' && lower === 'poster')) {
          delete attribs[names[n]];
          continue;
        }
        (lowerMap[lower] = lowerMap[lower] || []).push(names[n]);
      }
      var isImageInput = tag === 'input' && lowerMap.type &&
        lowerMap.type.some(function (name) { return String(attribs[name]).trim().toLowerCase() === 'image'; });
      if (FINAL_REMOVE_TAGS.indexOf(tag) !== -1 || isImageInput) {
        removeNode(el, parsed.nodes);
        continue;
      }
      if (tag === 'img') {
        var srcNames = lowerMap.src || [];
        var ok = srcNames.length === 1 && srcNames[0] === 'src' && isAllowedFinalImageSrc(attribs.src, opts);
        if (!ok) {
          removeNode(el, parsed.nodes);
          continue;
        }
        // canonical shape for the regex backstop
        var canonical = { src: attribs.src };
        for (var k = 0; k < IMG_KEEP_ATTRIBUTES.length; k++) {
          var keepName = IMG_KEEP_ATTRIBUTES[k];
          // empty values are dropped: some serializers (dom-serializer 0.2,
          // used by html-to-vdom's htmlparser2) emit them as bare names
          if (typeof attribs[keepName] === 'string' && attribs[keepName] !== '') {
            canonical[keepName] = cleanKeptAttributeValue(attribs[keepName]);
          }
        }
        el.attribs = canonical;
      }
    }
    output = parsed.render(parsed.nodes);
  }
  catch {
    return String(html || '').replace(/<img(?![a-z0-9_:.-])[^>]*(?:>|$)/gi, '');
  }
  // Regex backstop: any "<img" that starts a tag (case-insensitive, followed
  // by a non-name character such as whitespace, '/', '>' or end of input) must
  // be exactly <img src="ALLOWED"( name="value")*> or it is removed.
  return output.replace(/<img(?![a-z0-9_:.-])[^>]*(?:>|$)/gi, function (tagText) {
    var m = /^<img src="([^"<>]*)"((?: (?:alt|width|height|title)="[^"<>]*")*)\s*\/?>$/.exec(tagText);
    if (!m) {
      return '';
    }
    var src = m[1].replace(/&amp;/g, '&');
    return isAllowedFinalImageSrc(src, opts) ? tagText : '';
  });
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
    catch {
      // request already handled / page closed
    }
  });
}

module.exports = {
  resolveExportImages,
  finalizeExportHtml,
  createExportImageBudget,
  isAllowedFinalImageSrc,
  resolveExportImageSource,
  resolveExportImageToFileUrl,
  resolveLocalImageFile,
  classifyImageSource,
  sniffImageMime,
  isAllowedPdfRequestUrl,
  installPdfRequestFilter,
  EXPORT_IMAGE_MAX_TOTAL_BYTES,
  EXPORT_IMAGE_DEFAULT_MAX_TOTAL_BYTES,
};
