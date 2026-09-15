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
// an img tag, allowing ">" inside quoted attribute values
const IMG_TAG = /<img(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/**
 * Save inline base64 images (such as mammoth's docx output) into the site's
 * files/ and point each img at its saved file, since sanitizeHTMLForStorage
 * strips data: URIs. Images that cannot be saved become image placeholders.
 */
async function materializeInlineImages(html, site) {
  if (typeof html !== 'string') {
    return html;
  }
  const saved = new Map();
  let result = '';
  let last = 0;
  // only img tags are rewritten so the rest of the markup is kept byte for byte
  for (const match of html.matchAll(IMG_TAG)) {
    result += html.slice(last, match.index) + await materializeImage(match[0], site, saved);
    last = match.index + match[0].length;
  }
  return result + html.slice(last);
}

async function materializeImage(tag, site, saved) {
  const img = parse(tag).querySelector('img');
  const src = (img.getAttribute('src') || '').trim();
  if (!/^data:/i.test(src)) {
    return tag;
  }
  const match = BASE64_DATA_URI.exec(src);
  const extension = match && EXTENSION_BY_MIME[match[1].toLowerCase()];
  if (extension) {
    const buffer = Buffer.from(match[2], 'base64');
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    // an image repeated on the page is saved once
    if (!saved.has(hash)) {
      saved.set(hash, await saveImage(buffer, `image-${hash}.${extension}`, site));
    }
    if (saved.get(hash)) {
      img.setAttribute('src', saved.get(hash));
      if (!img.hasAttribute('alt')) {
        img.setAttribute('alt', '');
      }
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      return img.toString();
    }
  }
  const text = escapeHTMLAttribute(img.getAttribute('alt') || '');
  return `<place-holder type="image" text="${text}"></place-holder>`;
}

/** Save through HAXCMSFile for its type, content and size checks; returns the files/ url or null. */
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
