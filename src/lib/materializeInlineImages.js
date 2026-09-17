const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { parse } = require('node-html-parser');
const { escapeHTMLAttribute } = require('./sanitizeContent.js');

const BASE64_DATA_URI = /^data:([^;,]+)[^,]*;base64,(.+)$/is;

// Match files.js IMAGE_SCALE_PRESETS.xl — largest recommended display size.
const MAX_INLINE_IMAGE_WIDTH = 1200;
const MAX_INLINE_IMAGE_HEIGHT = 900;
// Docx imports are not web-optimized; compress aggressively at save time.
const INLINE_IMAGE_QUALITY = 90;

// Inline-image MIME -> extension, derived from HAXCMSFile's allow-list so this
// pre-filter cannot drift from what HAXCMSFile.save actually accepts. Built
// lazily on first use because HAXCMSFile requires HAXCMS, and this module is
// itself required by HAXCMS.js: a module-scope require would form a
// HAXCMS -> materializeInlineImages -> HAXCMSFile -> HAXCMS cycle that leaves
// siteFileUrl's HAXCMS reference unfinished.
let extensionByMimeCache = null;
function buildExtensionByMime(HAXCMSFile) {
  const map = {};
  const exts = HAXCMSFile.IMAGE_EXTENSIONS || [];
  for (let i = 0; i < exts.length; i++) {
    const ext = exts[i];
    const mimes = HAXCMSFile.ALLOWED_MIME_BY_EXTENSION[ext] || [];
    for (let j = 0; j < mimes.length; j++) {
      const mt = String(mimes[j]).toLowerCase();
      // first declared extension wins (jpg before jpeg)
      if (!map[mt]) {
        map[mt] = ext;
      }
    }
  }
  return map;
}

/**
 * Clean a page title into a filesystem-safe base name for imported images.
 * Mirrors HAXCMS.cleanTitle(title, false) enough for file names without
 * pulling HAXCMS in at module scope.
 */
function fileNameBaseFromPageTitle(pageTitle) {
  let base = '';
  if (typeof pageTitle === 'string') {
    base = pageTitle.trim().toLowerCase();
    base = base.replace(/ /g, '-');
    base = base.replace(/[^\w\-\/]+/gu, '-');
    base = base.replace(/\/+/g, '-');
    base = base.replace(/-+/g, '-');
    base = base.replace(/^-+|-+$/g, '');
  }
  if (!base) {
    base = 'page';
  }
  // Keep names readable in the files admin without being enormous
  if (base.length > 64) {
    base = base.slice(0, 64).replace(/-+$/g, '');
  }
  if (!base) {
    base = 'page';
  }
  return base;
}

/**
 * Resize to the largest recommended preset, convert non-JPG rasters to JPG,
 * and compress at 90% quality. Docx-sourced images (often PNG/print-sized)
 * are forced into a web-friendly JPEG before HAXCMSFile stores them.
 *
 * Returns { buffer, extension } so callers always save as .jpg after success.
 * On failure, returns the original buffer + extension unchanged.
 */
async function optimizeInlineImageBuffer(buffer, extension) {
  try {
    // flatten alpha onto white so PNG/WebP/GIF transparency becomes a real JPG
    let pipeline = sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({
        width: MAX_INLINE_IMAGE_WIDTH,
        height: MAX_INLINE_IMAGE_HEIGHT,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: INLINE_IMAGE_QUALITY, mozjpeg: true });
    const out = await pipeline.toBuffer();
    return { buffer: out, extension: 'jpg' };
  }
  catch (e) {
    // Fall back to the original bytes if sharp cannot process the payload;
    // HAXCMSFile.save will still validate MIME/content before accepting it.
    return { buffer: buffer, extension: extension };
  }
}

/**
 * Save inline base64 images (such as mammoth's docx output) as site files and
 * render them as media-image, since sanitizeHTMLForStorage strips data: URIs.
 * Images that cannot be saved become image placeholders.
 *
 * @param {string} html
 * @param {object} site
 * @param {object} [options]
 * @param {string} [options.pageTitle] Cleaned into the saved file base name so
 *   imports are identifiable per page (e.g. intro-to-hax.jpg) instead of a
 *   generic image.jpg / image_1.jpg series. Non-JPG sources are converted to
 *   JPG during optimize.
 *
 * Returns { html, uuids }: html is the rewritten content, uuids is the deduped
 * list of FileEntity uuids for the files saved this call. Callers set
 * page.metadata.files from uuids so imported files are referenced by their
 * entity uuid (the same source saveNode uses) rather than a content re-scan.
 */
async function materializeInlineImages(html, site, options) {
  if (typeof html !== 'string') {
    return { html: html, uuids: [] };
  }
  const opts = options && typeof options === 'object' ? options : {};
  const nameBase = fileNameBaseFromPageTitle(opts.pageTitle);
  const images = [];
  const savedPaths = new Map();
  // only real img elements are replaced, by source position, so comments,
  // attribute text, inert template markup and every other byte are untouched
  for (const img of parse(html).querySelectorAll('img')) {
    if (!img.range || isInertMarkup(img)) {
      continue;
    }
    const src = (img.getAttribute('src') || '').trim();
    if (!/^data:/i.test(src)) {
      continue;
    }
    images.push({ img: img, src: src });
    // an image repeated on the page is the same data URI, so it is saved once;
    // HAXCMSFile keeps the saved names unique across different images
    if (!savedPaths.has(src)) {
      savedPaths.set(src, await saveImage(src, site, nameBase));
    }
  }
  if (images.length === 0) {
    return { html: html, uuids: [] };
  }
  const entities = await loadSavedEntities(savedPaths, site);
  const uuids = [];
  let result = '';
  let last = 0;
  for (const image of images) {
    const entity = entities.get(image.src);
    const alt = escapeHTMLAttribute(image.img.getAttribute('alt') || '');
    let replacement = `<place-holder type="image" text="${alt}"></place-holder>`;
    if (entity) {
      // record the entity uuid once per saved file
      if (uuids.indexOf(entity.getUuid()) === -1) {
        uuids.push(entity.getUuid());
      }
      const source = escapeHTMLAttribute(entity.getPath());
      replacement = `<media-image source="${source}" alt="${alt}"></media-image>`;
    }
    result += html.slice(last, image.img.range[0]) + replacement;
    last = image.img.range[1];
  }
  return { html: result + html.slice(last), uuids: uuids };
}

/** Markup inside a template is escaped as code by the sanitizer, so leave it alone. */
function isInertMarkup(node) {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (parent.rawTagName && parent.rawTagName.toLowerCase() === 'template') {
      return true;
    }
  }
  return false;
}

/**
 * Save one data URI through HAXCMSFile, which validates the file, writes the
 * bytes and records it in files.json. Returns the saved path, used only to
 * locate the entity after collision-safe renaming, or null.
 */
async function saveImage(src, site, nameBase) {
  // required here to avoid the HAXCMS -> HAXCMSFile -> HAXCMS require cycle
  const { HAXCMS } = require('./HAXCMS.js');
  const HAXCMSFile = require('./HAXCMSFile.js');
  if (!extensionByMimeCache) {
    extensionByMimeCache = buildExtensionByMime(HAXCMSFile);
  }
  const match = BASE64_DATA_URI.exec(src);
  const extension = match && extensionByMimeCache[match[1].toLowerCase()];
  if (!extension) {
    return null;
  }
  const base = nameBase || 'page';
  let buffer = Buffer.from(match[2], 'base64');
  // Always convert allowed non-JPG rasters (png/gif/webp) to jpg and apply
  // the xl resize + 90% compression rules for web-friendly docx imports.
  const optimized = await optimizeInlineImageBuffer(buffer, extension);
  buffer = optimized.buffer;
  const outputExtension = optimized.extension || 'jpg';
  const name = base + '.' + outputExtension;
  const tmpPath = path.join(
    HAXCMS.configDirectory,
    'tmp',
    'inline-image-' + crypto.randomUUID(),
  );
  try {
    fs.outputFileSync(tmpPath, buffer);
    const result = await new HAXCMSFile().save(
      { path: tmpPath, originalname: name, size: buffer.length },
      site,
    );
    if (!result || Number(result.status) !== 200 || !result.data || !result.data.file) {
      return null;
    }
    return result.data.file.path || result.data.file.url;
  } catch (e) {
    console.warn(`materializeInlineImages: unable to save ${name}: ${e.message}`);
    return null;
  } finally {
    // a successful save moved the file, so this only cleans up failures
    fs.removeSync(tmpPath);
  }
}

/**
 * Load each saved file back through the Entity API (EntityRegistry ->
 * FileStorage -> FileEntity), so the path and uuid come from the files.json
 * record rather than HAXCMSFile.save's response envelope. One FileStorage per
 * call, created after every image is saved: FilesDataStore reads files.json
 * once per instance, so one created before the saves would return a stale
 * uuid for a reused path and could write that stale copy back over records
 * saved in the meantime.
 */
async function loadSavedEntities(savedPaths, site) {
  const entities = new Map();
  let fileStorage = null;
  for (const [src, savedPath] of savedPaths) {
    if (!savedPath) {
      continue;
    }
    if (!fileStorage) {
      // required here for the same load cycle: FileStorage -> FilesDataStore -> siteFileUrl -> HAXCMS
      const EntityRegistry = require('./EntityRegistry.js');
      const FileStorage = require('./FileStorage.js');
      fileStorage = FileStorage.registerOn(new EntityRegistry(site));
    }
    const uuid = await fileStorage.getDataStore().resolveUuidByPath(savedPath);
    const entity = uuid ? fileStorage.load(uuid) : null;
    if (entity) {
      entities.set(src, entity);
    }
  }
  return entities;
}

module.exports = {
  materializeInlineImages,
  fileNameBaseFromPageTitle,
  optimizeInlineImageBuffer,
  MAX_INLINE_IMAGE_WIDTH,
  MAX_INLINE_IMAGE_HEIGHT,
  INLINE_IMAGE_QUALITY,
};
