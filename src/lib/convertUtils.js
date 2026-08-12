const { parse } = require('node-html-parser');
const HTMLtoDOCX = require('html-to-docx');

/**
 * Run async work over a list with bounded concurrency, so validating a large
 * number of remote images (e.g. an entire site export) doesn't open hundreds
 * of simultaneous connections.
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
 * Check whether a remote URL actually resolves to image bytes. Authored
 * content can reference URLs that 200-redirect into an unrelated HTML page
 * (e.g. an auth/login flow) rather than 404ing, which would otherwise reach
 * html-to-docx's image embedder and throw an opaque "unsupported file type:
 * undefined" error that aborts the entire export.
 */
async function isRemoteImageUrl(url, timeoutMs = 8000) {
  try {
    const axios = require('axios');
    const response = await axios.get(url, {
      timeout: timeoutMs,
      maxRedirects: 5,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      return false;
    }
    const contentType = String(
      (response.headers && response.headers['content-type']) || '',
    ).toLowerCase();
    return contentType.indexOf('image/') === 0;
  } catch (e) {
    return false;
  }
}

/**
 * Remove <img> tags whose remote src does not resolve to actual image bytes,
 * so a single broken/redirected image reference cannot abort the whole DOCX
 * conversion. Local/data-URI images are left untouched.
 */
async function stripUnreachableRemoteImages(html) {
  if (!html) {
    return html;
  }
  let doc;
  try {
    doc = parse(html);
  } catch (e) {
    return html;
  }
  const images = doc.querySelectorAll('img').filter((img) =>
    /^https?:\/\//i.test(img.getAttribute('src') || ''),
  );
  if (images.length === 0) {
    return html;
  }
  await mapWithConcurrency(images, 8, async (img) => {
    const valid = await isRemoteImageUrl(img.getAttribute('src'));
    if (!valid) {
      img.remove();
    }
  });
  return doc.toString();
}

/**
 * Convert HTML string to a DOCX Buffer.
 * Shared between the system route handler and site export.
 */
async function convertHtmlToDocxBuffer(html) {
  let sanitized = String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\x00/g, '')
    .trim();

  if (!sanitized) {
    sanitized = '<p>No content available</p>';
  }

  try {
    sanitized = await stripUnreachableRemoteImages(sanitized);
  } catch (e) {
    // Non-fatal: fall through with the original HTML if the validation pass
    // itself fails for any reason.
  }

  const options = {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  };

  try {
    return await HTMLtoDOCX(sanitized, null, options);
  } catch (error) {
    console.error('HTMLtoDOCX conversion error:', error.message);
    const fallbackHtml =
      '<div><h1>Document Export</h1><p>The original document could not be fully converted. Please try exporting individual pages instead of the entire site.</p></div>';
    return await HTMLtoDOCX(fallbackHtml, null, {
      table: { row: { cantSplit: true } },
    });
  }
}

/**
 * Strip Microsoft Word generated HTML artifacts.
 * Based on the open-apis htmlScrubbers.js utility.
 */
function stripMSWord(input) {
  if (typeof input !== 'string') {
    return '';
  }
  let output = input
    .split('\n\r')
    .join('\n')
    .split('\r')
    .join('\n')
    .split('\n\n')
    .join('\n')
    .split('\n\n')
    .join('\n')
    .split('\n\n')
    .join('\n')
    .split('\n')
    .join(' ')
    .replace(/( class=\")?Mso[a-zA-Z]+(\")?/g, '');
  output = output.replace(/<!--(\s|.)*?-->/gim, '');
  output = output.replace(/<!\?(\s|.)*?>/gim, '');
  output = output.replace(
    /<(\/)*(meta|link|title|html|head|body|font|br|\\\\?xml:|xml|st1:|o:|w:|m:|v:)(\s|.)*?>/gim,
    '',
  );
  output = output.replace(/<span[^>]*>([\s\S]*?)<\/span>/gim, '$1');
  const badTags = ['style', 'script', 'applet', 'embed', 'noframes', 'noscript'];
  for (let i in badTags) {
    let tagStripper = new RegExp(
      '<' + badTags[i] + '(s|.)*?' + badTags[i] + '(.*?)>',
      'gim',
    );
    output = output.replace(tagStripper, '');
  }
  output = output.replace(/ style='(\s|.)*?'/gim, '');
  output = output.replace(/ style=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ face=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ align=.*? /g, '');
  output = output.replace(/ start='.*?'/g, '');
  output = output.replace(/line-height:.*?\"/g, '"');
  output = output.replace(/line-height:.*?;/g, '');
  output = output.replace(/font-weight:normal;/g, '');
  output = output.replace(/text-decoration:none;/g, '');
  output = output.replace(/margin-.*?:.*?\"/g, '"');
  output = output.replace(/margin-.*?:.*?;/g, '');
  output = output.replace(/ style=\"\"/g, '');
  output = output.replace(/ id=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ dir=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ role=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ contenteditable=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ data-(\s|.)*?\"(\s|.)*?\"/gim, '');
  output = output.replace(/ class=\"(\s|.)*?\"/gim, '');
  output = output.replace(/<pstyle/gm, '<p style');
  output = output.replace(/<a name=\"_GoBack\"><\/a>/gm, '');
  output = output.replace(/&nbsp;/gm, ' ');
  output = output.replace(/<section>/gm, '<p>');
  output = output.replace(/<\/section>/gm, '</p>');
  output = output.replace(/<p><p>/gm, '<p>');
  output = output.replace(/<p><p>/gm, '<p>');
  output = output.replace(/<\/p><\/p>/gm, '</p>');
  output = output.replace(/<\/p><\/p>/gm, '</p>');
  output = output.replace(/<br \/>/gm, '<br/>');
  output = output.replace(/<p><br \/><b>/gm, '<p><b>');
  output = output.replace(/<\/p><br \/><\/b>/gm, '</p></b>');
  output = output.replace(/<b><p>/gm, '<p>');
  output = output.replace(/<\/p><\/b>/gm, '</p>');
  output = output.replace(/<b>/gm, '<strong>');
  output = output.replace(/<\/b>/gm, '</strong>');
  output = output.replace(/<p style=\".*?\">/gm, '<p>');
  output = output.replace(/<ul style=\".*?\">/gm, '<ul>');
  output = output.replace(/<ol style=\".*?\">/gm, '<ol>');
  output = output.replace(/<li style=\".*?\">/gm, '<li>');
  output = output.replace(/<td style=\".*?\">/gm, '<td>');
  output = output.replace(/<tr style=\".*?\">/gm, '<tr>');
  output = output.replace(/<li><p>/gm, '<li>');
  output = output.replace(/<\/p><\/li>/gm, '</li>');
  output = output.replace(/<b><ul>/gm, '<ul>');
  output = output.replace(/<\/ul><\/b>/gm, '</ul>');
  output = output.replace(/<b><ol>/gm, '<ol>');
  output = output.replace(/<\/ol><\/b>/gm, '</ol>');
  output = output.replace(/<span><p>/gm, '<p>');
  output = output.replace(/<\/p><\/span>/gm, '</p>');
  output = output.replace(/<p>(\s*)<\/p>/gm, ' ');
  output = output.replace(/<p><\/p>/gm, '');
  output = output.replace(/<p>&nbsp;<\/p>/gm, ' ');
  output = output.replace(/<p><br\/><\/p>/gm, '');
  output = output.replace(/<p><br><\/p>/gm, '');
  output = output.replace(/<\/p>(\s*)<p>/gm, '</p><p>');
  output = output.replace(/ data-hax-ray=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ class=\"\"/gim, '');
  output = output.replace(/ class=\"hax-active\"/gim, '');
  output = output.replace(/ contenteditable=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ t=\"(\s|.)*?\"/gim, '');
  for (let j in badTags) {
    let emptyTagRemove = new RegExp(
      '<' + badTags[j] + '></' + badTags[j] + '>',
      'gi',
    );
    output = output.replace(emptyTagRemove, '');
  }
  output = output.trim();
  return output;
}

/**
 * Validate that a string is a valid URL.
 */
function validURL(str) {
  let url;
  try {
    url = new URL(str);
  } catch (_) {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * Convert an element from parsed mammoth HTML into a single HTML string.
 * This replaces tabs, supports single-line video player calls, and handles
 * placeholder conventions.
 */
function htmlFromEl(el) {
  let textValue = el.innerText.trim();
  if (
    validURL(textValue) &&
    (textValue.includes('youtube.com') ||
      textValue.includes('youtu.be') ||
      textValue.includes('youtube-nocookie.com') ||
      textValue.includes('vimeo.com') ||
      textValue.toLowerCase().includes('.mp4'))
  ) {
    return `<video-player source="${textValue}"></video-player>`;
  }
  else if (
    validURL(textValue) &&
    (textValue.toLowerCase().includes('.jpg') ||
      textValue.toLowerCase().includes('.jpeg') ||
      textValue.toLowerCase().includes('.png') ||
      textValue.toLowerCase().includes('.webp'))
  ) {
    return `<img src="${textValue}" loading="lazy" decoding="async" fetchpriority="high" alt="" />`;
  }
  else if (
    validURL(textValue) &&
    textValue.toLowerCase().includes('.gif')
  ) {
    return `<a11y-gif-player src="${textValue}" style="width: 300px;">
      <simple-img width="300" src="${textValue}"></simple-img>
    </a11y-gif-player>`;
  }
  else if (textValue.startsWith('[') && textValue.endsWith(']')) {
    let tmp = textValue.split(':');
    if (tmp.length > 1) {
      let type = tmp.shift().replace('[', '');
      let text = tmp.join(':').replace(']', '').trim();
      switch (type) {
        case 'math':
        case 'mathjax':
          return `<lrn-math>${text}</lrn-math>`;
        case 'video':
        case 'audio':
        case 'document':
        case 'text':
        case 'image':
          return `<place-holder type="${type}" text="${text}"></place-holder>`;
      }
    }
    textValue = textValue.replace('[', '').replace(']', '').trim();
    if (
      validURL(textValue) &&
      (textValue.includes('youtube.com') ||
        textValue.includes('youtu.be') ||
        textValue.includes('youtube-nocookie.com') ||
        textValue.includes('vimeo.com') ||
        textValue.includes('twitch.tv') ||
        textValue.toLowerCase().includes('.mp4'))
    ) {
      return `<video-player source="${textValue}"></video-player>`;
    }
    else if (
      validURL(textValue) &&
      (textValue.toLowerCase().includes('.jpg') ||
        textValue.toLowerCase().includes('.jpeg') ||
        textValue.toLowerCase().includes('.png') ||
        textValue.toLowerCase().includes('.webp'))
    ) {
      return `<img src="${textValue}" loading="lazy" decoding="async" fetchpriority="high" alt="" />`;
    }
    else if (
      validURL(textValue) &&
      textValue.toLowerCase().includes('.gif')
    ) {
      return `<a11y-gif-player src="${textValue}" style="width: 300px;">
        <simple-img width="300" src="${textValue}"></simple-img>
      </a11y-gif-player>`;
    }
    else {
      return `<place-holder type="text" text="${textValue}"></place-holder>`;
    }
  }
  else if (textValue.startsWith('!') && textValue.includes('-')) {
    let tag = textValue.replace('!', '').trim();
    return `<${tag}></${tag}>`;
  }
  let content = el.outerHTML
    .replace(/\t/g, '')
    .trim()
    .replace(/\[math:(.*?)\]/g, '<lrn-math>$1</lrn-math>');
  return content;
}

/**
 * Process the raw HTML from mammoth, walking the wrapper children and
 * converting each element into an HTML string.
 */
function processDocxHtml(html) {
  const doc = parse(`<div id="docx-import-wrapper">${html}</div>`);
  const wrapper = doc.querySelector('#docx-import-wrapper');
  if (!wrapper) {
    return html;
  }
  let content = '';
  for (const child of wrapper.childNodes) {
    if (child && child.tagName) {
      content += htmlFromEl(child);
    }
  }
  return content !== '' ? content : html;
}

const fs = require('fs');

function findChromeExecutable() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Convert HTML string to a PDF Buffer using puppeteer-core.
 * Requires Chrome/Chromium to be installed on the host.
 */
async function htmlToPdfBuffer(html, base = '/') {
  const puppeteer = require('puppeteer-core');
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    throw new Error(
      'No Chrome/Chromium executable found. Install Chrome or set PUPPETEER_EXECUTABLE_PATH.',
    );
  }
  let sanitized = String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\x00/g, '')
    .trim();
  if (!sanitized) {
    sanitized = '<p>No content available</p>';
  }
  let browser = null;
  try {
    // Security (L3): enable Chromium's OS-level sandbox when not running as
    // root. --no-sandbox is only required for containerized/CI runs as root
    // where the setuid sandbox cannot engage; production should run Chrome as
    // a non-root user so the sandbox is active. Keeping the root branch
    // preserves existing CI/E2E behavior unchanged.
    var launchArgs = [];
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      launchArgs.push('--no-sandbox', '--disable-setuid-sandbox');
    }
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: launchArgs,
    });
    const page = await browser.newPage();
    if (base && base !== '/') {
      // Security (L4): full HTML-attribute escape as defense-in-depth even
      // though the route validates base as a URL. Escaping &, ", <, > ensures
      // the value can never break out of the double-quoted href attribute.
      var escapedBase = base.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const baseTag = `<base href="${escapedBase}" />`;
      sanitized = sanitized.replace(/<head>/i, `<head>${baseTag}`);
      if (!sanitized.includes('<head>')) {
        sanitized = `<head>${baseTag}</head>${sanitized}`;
      }
    }
    await page.setContent(sanitized, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '40px', right: '40px', bottom: '40px', left: '40px' },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Strip scripts, styles, and other dangerous content from untrusted HTML.
 */
function sanitizeUntrustedHtml(html) {
  if (typeof html !== 'string') {
    return '';
  }
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\x00/g, '')
    .trim();
}

module.exports = {
  stripMSWord,
  validURL,
  htmlFromEl,
  processDocxHtml,
  convertHtmlToDocxBuffer,
  htmlToPdfBuffer,
  sanitizeUntrustedHtml,
};
