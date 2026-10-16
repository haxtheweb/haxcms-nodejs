const { parse } = require('node-html-parser');
const HTMLtoDOCX = require('html-to-docx');
const exportImageResolver = require('./exportImageResolver.js');

/**
 * Security (review 2026-10): pre-resolve every <img> to a data: URI through
 * exportImageResolver (site-confined local reads, SSRF-guarded + byte-capped
 * remote fetches, image magic-byte check) so the converter never fetches a
 * URL or reads a path itself. If the resolver fails, all images are removed
 * rather than falling back to the raw HTML.
 */
async function inlineImagesForExport(html, options) {
  try {
    return await exportImageResolver.inlineExportImages(html, options || {});
  } catch (e) {
    return exportImageResolver.stripAllImages(html);
  }
}

/**
 * Convert HTML string to a DOCX Buffer.
 * Shared between the system route handler and site export.
 *
 * imageOptions (all optional):
 *  - siteDirectory: site root used to embed site-relative images
 *  - basePaths: prefixes (site base path) marking a src as site-relative
 */
async function convertHtmlToDocxBuffer(html, imageOptions = {}) {
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

  // Security (review 2026-10): html-to-docx downloads every http(s) <img src>
  // with its bundled node-fetch (no SSRF guard, no byte cap) and base64-embeds
  // the bytes, so an authored <img src="http://169.254.169.254/..."> leaked
  // internal responses into the document. The old pre-check
  // (isRemoteImageUrl) also fetched through raw axios with redirects. Every
  // image is now resolved here and handed over as a data: URI.
  sanitized = await inlineImagesForExport(sanitized, {
    siteDirectory: imageOptions && imageOptions.siteDirectory ? imageOptions.siteDirectory : '',
    basePaths: imageOptions && Array.isArray(imageOptions.basePaths) ? imageOptions.basePaths : [],
  });

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
 * Security (review 2026-10): request filter for PDF rendering. Every
 * resource Chrome would load (img, link, object, CSS url(), fonts, fetch) is
 * aborted unless it is inline (data:) or the blank document itself
 * (about:). Images are pre-resolved to data: URIs by preparePdfHtml, so they
 * still render. Mirrors PHP dompdf isRemoteEnabled=false + chroot.
 */
function isAllowedPdfRequestUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  return value.indexOf('data:') === 0 || value.indexOf('about:') === 0;
}

/**
 * Sanitize HTML for PDF rendering and pre-resolve its images to data: URIs.
 * Split out of htmlToPdfBuffer so it can be tested without Chrome.
 *
 * options (all optional):
 *  - siteDirectory / basePaths: as for convertHtmlToDocxBuffer
 * An absolute http(s) base is also used to resolve relative srcs that are
 * not site files; those are fetched through the SSRF guard.
 */
async function preparePdfHtml(html, base = '/', options = {}) {
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
  const basePaths = options && Array.isArray(options.basePaths) ? options.basePaths.slice() : [];
  if (base && base !== '/' && basePaths.indexOf(base) === -1) {
    basePaths.push(base);
  }
  return inlineImagesForExport(sanitized, {
    siteDirectory: options && options.siteDirectory ? options.siteDirectory : '',
    basePaths: basePaths,
    baseUrl: /^https?:\/\//i.test(String(base || '')) ? base : '',
  });
}

/**
 * Convert HTML string to a PDF Buffer using puppeteer-core.
 * Requires Chrome/Chromium to be installed on the host.
 */
async function htmlToPdfBuffer(html, base = '/', options = {}) {
  const puppeteer = require('puppeteer-core');
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    throw new Error(
      'No Chrome/Chromium executable found. Install Chrome or set PUPPETEER_EXECUTABLE_PATH.',
    );
  }
  let sanitized = await preparePdfHtml(html, base, options);
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
    // Security (review 2026-10): Chrome previously fetched every <img>, <link>,
    // <object> and CSS url() in the export (SSRF to internal hosts / cloud
    // metadata, rendered into the PDF). JavaScript is off (scripts are
    // stripped anyway, this also stops inline handlers) and every request
    // that is not data:/about: is aborted.
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (isAllowedPdfRequestUrl(request.url())) {
        request.continue();
      } else {
        request.abort();
      }
    });
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
  preparePdfHtml,
  isAllowedPdfRequestUrl,
  sanitizeUntrustedHtml,
};
