const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('node-html-parser');
const { escapeHTMLAttribute } = require('./sanitizeContent.js');

// inline image types that HAXCMSFile accepts as uploads
const EXTENSION_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const BASE64_DATA_URI = /^data:([^;,]+)[^,]*;base64,(.+)$/is;

/**
 * Save inline base64 images (such as mammoth's docx output) as site files and
 * render them as media-image, since sanitizeHTMLForStorage strips data: URIs.
 * Images that cannot be saved become image placeholders.
 */
async function materializeInlineImages(html, site) {
  if (typeof html !== 'string') {
    return html;
  }
  const saved = new Map();
  let result = '';
  let last = 0;
  // only real img elements are replaced, by source position, so comments,
  // attribute text, inert template markup and every other byte are untouched
  for (const img of parse(html).querySelectorAll('img')) {
    if (!img.range || isInertMarkup(img)) {
      continue;
    }
    const replacement = await materializeImage(img, site, saved);
    if (replacement === null) {
      continue;
    }
    result += html.slice(last, img.range[0]) + replacement;
    last = img.range[1];
  }
  return result + html.slice(last);
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

/** Replacement markup for one img, or null to leave it as it is. */
async function materializeImage(img, site, saved) {
  const src = (img.getAttribute('src') || '').trim();
  if (!/^data:/i.test(src)) {
    return null;
  }
  const alt = escapeHTMLAttribute(img.getAttribute('alt') || '');
  const match = BASE64_DATA_URI.exec(src);
  const extension = match && EXTENSION_BY_MIME[match[1].toLowerCase()];
  if (extension) {
    // an image repeated on the page is the same data URI, so it is saved once;
    // HAXCMSFile keeps the saved names unique
    if (!saved.has(src)) {
      saved.set(src, await saveImage(Buffer.from(match[2], 'base64'), `image.${extension}`, site));
    }
    if (saved.get(src)) {
      return `<media-image source="${saved.get(src)}" alt="${alt}"></media-image>`;
    }
  }
  return `<place-holder type="image" text="${alt}"></place-holder>`;
}

/** Save through HAXCMSFile, which validates the file and records it in files.json. */
async function saveImage(buffer, name, site) {
  // required here to avoid a HAXCMS -> HAXCMSFile -> HAXCMS require cycle
  const { HAXCMS } = require('./HAXCMS.js');
  const HAXCMSFile = require('./HAXCMSFile.js');
  const tmpPath = path.join(HAXCMS.configDirectory, 'tmp', `inline-image-${crypto.randomUUID()}`);
  try {
    fs.outputFileSync(tmpPath, buffer);
    const result = await new HAXCMSFile().save({ path: tmpPath, originalname: name, size: buffer.length }, site);
    return result && Number(result.status) === 200 ? result.data.file.url : null;
  } catch (e) {
    console.warn(`materializeInlineImages: unable to save ${name}: ${e.message}`);
    return null;
  } finally {
    // a successful save moved the file, so this only cleans up failures
    fs.removeSync(tmpPath);
  }
}

module.exports = { materializeInlineImages };
