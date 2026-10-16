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
 * Security (review 2026-10): linear replacement for the lazy-span regexes
 * stripMSWord used, e.g. /<!--(\s|.)*?-->/gim. Each of those rescans to the
 * end of the string for every opener that has no closer after it, so a few
 * hundred KB of "<!--" took tens of seconds (180 KB -> 10.7 s+). This scans
 * once: find the opener, then each closer in turn (nearest match, the same
 * span a lazy quantifier picks). If a closer is missing, no later opener can
 * match either, so scanning stops. When `crossLines` is false the span may
 * not contain a line terminator (regex `.` semantics); hitting one fails this
 * opener and every opener before that terminator, so scanning resumes after it.
 *
 * @param {string} input
 * @param {RegExp} opener global regex for the literal start of the span
 * @param {string[]} closers literal strings matched in order after the opener
 * @param {object} [options] { replacement = '', ignoreCase = false, crossLines = true }
 */
function stripLazySpans(input, opener, closers, options) {
  const opts = options || {};
  const replacement = typeof opts.replacement === 'string' ? opts.replacement : '';
  const crossLines = opts.crossLines !== false;
  const flags = 'g' + (opts.ignoreCase ? 'i' : '');
  const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const closerRes = closers.map((closer) => new RegExp(
    escapeRe(closer) + (crossLines ? '' : '|[\\r\\n\\u2028\\u2029]'),
    flags,
  ));
  const startRe = new RegExp(opener.source, flags);
  let out = '';
  let last = 0;
  let match;
  while ((match = startRe.exec(input)) !== null) {
    let pos = match.index + match[0].length;
    let failedAt = -1;
    let missing = false;
    for (let i = 0; i < closerRes.length; i++) {
      const re = closerRes[i];
      re.lastIndex = pos;
      const found = re.exec(input);
      if (!found) {
        missing = true;
        break;
      }
      if (!crossLines && /^[\r\n\u2028\u2029]$/.test(found[0])) {
        failedAt = found.index;
        break;
      }
      pos = found.index + found[0].length;
    }
    if (missing) {
      break;
    }
    if (failedAt !== -1) {
      startRe.lastIndex = failedAt + 1;
      continue;
    }
    out += input.slice(last, match.index) + replacement;
    last = pos;
    startRe.lastIndex = pos;
  }
  return out + input.slice(last);
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
  // Security (review 2026-10): the lazy-span regexes below were quadratic on
  // unterminated openers; stripLazySpans is a linear equivalent.
  output = stripLazySpans(output, /<!--/, ['-->']);
  output = stripLazySpans(output, /<!\?/, ['>']);
  output = stripLazySpans(
    output,
    /<(\/)*(meta|link|title|html|head|body|font|br|\\\\?xml:|xml|st1:|o:|w:|m:|v:)/,
    ['>'],
    { ignoreCase: true },
  );
  output = output.replace(/<span[^>]*>([\s\S]*?)<\/span>/gim, '$1');
  const badTags = ['style', 'script', 'applet', 'embed', 'noframes', 'noscript'];
  for (let i in badTags) {
    // was /<tag(s|.)*?tag(.*?)>/gim: neither span crosses a line terminator
    output = stripLazySpans(output, new RegExp('<' + badTags[i]), [badTags[i], '>'], {
      ignoreCase: true,
      crossLines: false,
    });
  }
  output = stripLazySpans(output, / style='/, ["'"], { ignoreCase: true });
  output = stripLazySpans(output, / style="/, ['"'], { ignoreCase: true });
  output = stripLazySpans(output, / face="/, ['"'], { ignoreCase: true });
  output = stripLazySpans(output, / align=/, [' '], { crossLines: false });
  output = stripLazySpans(output, / start='/, ["'"], { crossLines: false });
  output = stripLazySpans(output, /line-height:/, ['"'], { crossLines: false, replacement: '"' });
  output = stripLazySpans(output, /line-height:/, [';'], { crossLines: false });
  output = output.replace(/font-weight:normal;/g, '');
  output = output.replace(/text-decoration:none;/g, '');
  output = stripLazySpans(output, /margin-/, [':', '"'], { crossLines: false, replacement: '"' });
  output = stripLazySpans(output, /margin-/, [':', ';'], { crossLines: false });
  output = output.replace(/ style=\"\"/g, '');
  output = stripLazySpans(output, / id="/, ['"'], { ignoreCase: true });
  output = stripLazySpans(output, / dir="/, ['"'], { ignoreCase: true });
  output = stripLazySpans(output, / role="/, ['"'], { ignoreCase: true });
  output = stripLazySpans(output, / contenteditable="/, ['"'], { ignoreCase: true });
  output = stripLazySpans(output, / data-/, ['"', '"'], { ignoreCase: true });
  output = stripLazySpans(output, / class="/, ['"'], { ignoreCase: true });
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
  const styledTags = ['p', 'ul', 'ol', 'li', 'td', 'tr'];
  for (let k = 0; k < styledTags.length; k++) {
    output = stripLazySpans(output, new RegExp('<' + styledTags[k] + ' style="'), ['">'], {
      crossLines: false,
      replacement: '<' + styledTags[k] + '>',
    });
  }
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
  output = stripLazySpans(output, / data-hax-ray="/, ['"'], { ignoreCase: true });
  output = output.replace(/ class=\"\"/gim, '');
  output = output.replace(/ class=\"hax-active\"/gim, '');
  output = stripLazySpans(output, / contenteditable="/, ['"'], { ignoreCase: true });
  output = stripLazySpans(output, / t="/, ['"'], { ignoreCase: true });
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
  // audio (mp3 / wav / ogg / m4a / flac / aac / mid / midi)
  else if (
    validURL(textValue) &&
    (textValue.toLowerCase().includes('.mp3') ||
      textValue.toLowerCase().includes('.wav') ||
      textValue.toLowerCase().includes('.ogg') ||
      textValue.toLowerCase().includes('.m4a') ||
      textValue.toLowerCase().includes('.flac') ||
      textValue.toLowerCase().includes('.aac') ||
      textValue.toLowerCase().includes('.mid') ||
      textValue.toLowerCase().includes('.midi'))
  ) {
    return `<audio-player source="${textValue}"></audio-player>`;
  }
  // pdf
  else if (
    validURL(textValue) &&
    textValue.toLowerCase().includes('.pdf')
  ) {
    return `<pdf-browser-viewer file="${textValue}" width="100%"></pdf-browser-viewer>`;
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
    // audio (mp3 / wav / ogg / m4a / flac / aac / mid / midi)
    else if (
      validURL(textValue) &&
      (textValue.toLowerCase().includes('.mp3') ||
        textValue.toLowerCase().includes('.wav') ||
        textValue.toLowerCase().includes('.ogg') ||
        textValue.toLowerCase().includes('.m4a') ||
        textValue.toLowerCase().includes('.flac') ||
        textValue.toLowerCase().includes('.aac') ||
        textValue.toLowerCase().includes('.mid') ||
        textValue.toLowerCase().includes('.midi'))
    ) {
      return `<audio-player source="${textValue}"></audio-player>`;
    }
    // pdf
    else if (
      validURL(textValue) &&
      textValue.toLowerCase().includes('.pdf')
    ) {
      return `<pdf-browser-viewer file="${textValue}" width="100%"></pdf-browser-viewer>`;
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
    // Wait for network to be idle (images/fonts loaded) before printing,
    // otherwise relative images resolved via <base> may not have rendered yet.
    await page.setContent(sanitized, { waitUntil: 'networkidle0', timeout: 30000 });
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
