const { parse } = require('node-html-parser');
const HTMLtoDOCX = require('html-to-docx');
const {
  resolveExportImages,
  finalizeExportHtml,
  installPdfRequestFilter,
} = require('./exportImageResolver.js');

/**
 * Convert HTML string to a DOCX Buffer.
 * Shared between the system route handler and site export.
 *
 * imageOptions is passed to resolveExportImages (siteDir / siteBasePath /
 * selfBaseUrl for site exports; omitted for the system convert route, where
 * only remote http(s) images are fetched and relative ones are dropped).
 */
async function convertHtmlToDocxBuffer(html, imageOptions) {
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

  // Security (SEC-SSRF): html-to-docx downloads every http(s) <img src> with
  // its own unguarded client (no SSRF check, redirects followed, no size
  // cap). Resolve every image first (local site file / safeFetch with a byte
  // cap / dropped) and hand html-to-docx only data: URIs. This also keeps the
  // old behaviour of dropping images that do not resolve to real image bytes
  // so one broken reference cannot abort the whole conversion. Fail closed:
  // if the pass itself throws, strip all images rather than pass them on.
  try {
    sanitized = await resolveExportImages(sanitized, Object.assign({}, imageOptions || {}, { output: 'data-uri', allowSvg: false }));
  } catch (e) {
    sanitized = sanitized.replace(/<img(?![a-z0-9_:.-])[^>]*(?:>|$)/gi, '');
  }
  // Security (SEC-SSRF): fail-closed final pass on the exact string handed to
  // html-to-docx, parsed with html-to-vdom's own htmlparser2 build.
  sanitized = finalizeExportHtml(sanitized, { consumer: 'docx' });

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
 * Security (PR8-5): remove every non-overlapping `open ... close` span
 * (shortest match, like a lazy regex) in linear time. When an opener has no
 * closer after it, no later opener can have one either, so scanning stops and
 * the remainder is kept verbatim (same result as the regex, which leaves
 * unterminated openers untouched).
 */
function stripDelimitedSpans(input, open, close) {
  let result = '';
  let pos = 0;
  while (pos < input.length) {
    const start = input.indexOf(open, pos);
    if (start === -1) {
      break;
    }
    const end = input.indexOf(close, start + open.length);
    if (end === -1) {
      break;
    }
    result += input.substring(pos, start);
    pos = end + close.length;
  }
  return result + input.substring(pos);
}

/**
 * Security (PR8-5): linear-time equivalent of a global lazy regex shaped
 *   OPEN gap1 TOKEN1 gap2 TOKEN2 ...
 * where every gap is a lazy "anything" (`(\s|.)*?` / `[\s\S]*?` / `[^>]*`
 * before `>`), or a lazy `.*?` that cannot cross a line terminator
 * (lineBounded). Backtracking regexes of that shape are O(n^2) when many
 * openers have no closing token; here each step keeps a forward-only cache of
 * its next token occurrence so the whole scan is linear.
 *
 * Semantics match String.prototype.replace with the original regex: the
 * leftmost opener whose tokens can all be found wins, each token is its first
 * occurrence after the previous one (lazy), scanning resumes after the match,
 * and once any token has no further occurrence at all, no later opener can
 * match either, so the rest is copied verbatim.
 *
 * @param {string} input
 * @param {RegExp} openRe global regex for the opener (no unbounded parts; an
 *   occurrence must not start inside another one, which holds for every
 *   opener used here since each has a single leading anchor character/word)
 * @param {Array<{re: RegExp, lineBounded?: boolean}>} steps global regexes
 * @param {function(string, Array<{start:number,end:number}>): string} replacer
 *   receives the input and the [opener, ...tokens] spans
 */
function lazySequenceReplace(input, openRe, steps, replacer) {
  const lineTerminator = /[\n\r\u2028\u2029]/g;
  // forward-only caches: { from, start, end } is the first occurrence at or
  // after `from`; it answers any later query whose origin lies in
  // [from, start] (start === Infinity means no occurrence after `from`).
  const cache = steps.map(function () { return null; });
  let terminatorCache = null;
  function cachedFor(entry, from) {
    return entry !== null && entry.from <= from && entry.start >= from;
  }
  function nextOccurrence(i, from) {
    if (cachedFor(cache[i], from)) {
      return cache[i];
    }
    const re = steps[i].re;
    re.lastIndex = from;
    const m = re.exec(input);
    cache[i] = m
      ? { from: from, start: m.index, end: m.index + m[0].length }
      : { from: from, start: Infinity, end: Infinity };
    return cache[i];
  }
  function nextTerminator(from) {
    if (cachedFor(terminatorCache, from)) {
      return terminatorCache.start;
    }
    lineTerminator.lastIndex = from;
    const m = lineTerminator.exec(input);
    terminatorCache = { from: from, start: m ? m.index : Infinity };
    return terminatorCache.start;
  }
  let result = '';
  let copied = 0;
  let searchFrom = 0;
  while (searchFrom <= input.length) {
    openRe.lastIndex = searchFrom;
    const open = openRe.exec(input);
    if (!open) {
      break;
    }
    const spans = [{ start: open.index, end: open.index + open[0].length }];
    let cur = spans[0].end;
    let exhausted = false;
    let failed = false;
    for (let i = 0; i < steps.length; i++) {
      const hit = nextOccurrence(i, cur);
      if (hit.start === Infinity) {
        exhausted = true;
        break;
      }
      if (steps[i].lineBounded && nextTerminator(cur) < hit.start) {
        failed = true;
        break;
      }
      spans.push(hit);
      cur = hit.end;
    }
    if (exhausted) {
      break;
    }
    if (failed) {
      searchFrom = open.index + 1;
      continue;
    }
    result += input.substring(copied, open.index) + replacer(input, spans);
    copied = cur;
    // an empty match cannot happen (openers are non-empty), so always advance
    searchFrom = cur;
  }
  return result + input.substring(copied);
}

/**
 * Strip Microsoft Word generated HTML artifacts.
 * Based on the open-apis htmlScrubbers.js utility.
 */
function dropMatch() {
  return '';
}
function keepQuote() {
  return '"';
}
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
  // Security (PR8-5): the previous /<!--(\s|.)*?-->/ and /<!\?(\s|.)*?>/
  // regexes were O(n^2) on many unterminated openers (180 KB of `<!--` took
  // ~60 s, blocking the event loop). Same semantics, linear time.
  output = stripDelimitedSpans(output, '<!--', '-->');
  output = stripDelimitedSpans(output, '<!?', '>');
  // Security (PR8-5): every lazy "opener ... closer" pattern below that can
  // see many openers without a closer is routed through lazySequenceReplace
  // (linear) instead of a backtracking regex. Comments name the original.
  // was: /<(\/)*(meta|link|...|v:)(\s|.)*?>/gim -> ''
  output = lazySequenceReplace(
    output,
    /<(\/)*(meta|link|title|html|head|body|font|br|\\\\?xml:|xml|st1:|o:|w:|m:|v:)/gi,
    [{ re: />/g }],
    dropMatch,
  );
  // was: /<span[^>]*>([\s\S]*?)<\/span>/gim -> '$1'
  output = lazySequenceReplace(
    output,
    /<span/gi,
    [{ re: />/g }, { re: /<\/span>/gi }],
    function (str, spans) {
      return str.substring(spans[1].end, spans[2].start);
    },
  );
  const badTags = ['style', 'script', 'applet', 'embed', 'noframes', 'noscript'];
  for (let i in badTags) {
    // was: new RegExp('<' + tag + '(s|.)*?' + tag + '(.*?)>', 'gim') -> ''
    // ((s|.) and . both stop at line terminators)
    output = lazySequenceReplace(
      output,
      new RegExp('<' + badTags[i], 'gi'),
      [
        { re: new RegExp(badTags[i], 'gi'), lineBounded: true },
        { re: />/g, lineBounded: true },
      ],
      dropMatch,
    );
  }
  output = output.replace(/ style='(\s|.)*?'/gim, '');
  output = output.replace(/ style=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ face=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ align=.*? /g, '');
  output = output.replace(/ start='.*?'/g, '');
  // was: /line-height:.*?\"/g -> '"' and /line-height:.*?;/g -> ''
  output = lazySequenceReplace(output, /line-height:/g, [{ re: /"/g, lineBounded: true }], keepQuote);
  output = lazySequenceReplace(output, /line-height:/g, [{ re: /;/g, lineBounded: true }], dropMatch);
  output = output.replace(/font-weight:normal;/g, '');
  output = output.replace(/text-decoration:none;/g, '');
  // was: /margin-.*?:.*?\"/g -> '"' and /margin-.*?:.*?;/g -> ''
  output = lazySequenceReplace(
    output,
    /margin-/g,
    [{ re: /:/g, lineBounded: true }, { re: /"/g, lineBounded: true }],
    keepQuote,
  );
  output = lazySequenceReplace(
    output,
    /margin-/g,
    [{ re: /:/g, lineBounded: true }, { re: /;/g, lineBounded: true }],
    dropMatch,
  );
  output = output.replace(/ style=\"\"/g, '');
  output = output.replace(/ id=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ dir=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ role=\"(\s|.)*?\"/gim, '');
  output = output.replace(/ contenteditable=\"(\s|.)*?\"/gim, '');
  // was: / data-(\s|.)*?\"(\s|.)*?\"/gim -> ''
  output = lazySequenceReplace(output, / data-/gi, [{ re: /"/g }, { re: /"/g }], dropMatch);
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
  output = lazySequenceReplace(output, /<p style="/g, [{ re: /">/g, lineBounded: true }], function () { return '<p>'; });
  output = lazySequenceReplace(output, /<ul style="/g, [{ re: /">/g, lineBounded: true }], function () { return '<ul>'; });
  output = lazySequenceReplace(output, /<ol style="/g, [{ re: /">/g, lineBounded: true }], function () { return '<ol>'; });
  output = lazySequenceReplace(output, /<li style="/g, [{ re: /">/g, lineBounded: true }], function () { return '<li>'; });
  output = lazySequenceReplace(output, /<td style="/g, [{ re: /">/g, lineBounded: true }], function () { return '<td>'; });
  output = lazySequenceReplace(output, /<tr style="/g, [{ re: /">/g, lineBounded: true }], function () { return '<tr>'; });
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
 * Convert HTML string to a PDF Buffer using puppeteer-core.
 * Requires Chrome/Chromium to be installed on the host.
 */
async function htmlToPdfBuffer(html, base = '/', imageOptions) {
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
  // Security (SEC-SSRF): inline every image before Chrome sees the document
  // (local site files / safeFetch with a byte cap / dropped). Without site
  // context (system convert route) relative srcs resolve against an absolute
  // http(s) base and go through safeFetch too.
  const resolvedImageOptions = imageOptions
    ? Object.assign({}, imageOptions)
    : { remoteBaseUrl: /^https?:\/\//i.test(String(base || '')) ? String(base) : null };
  resolvedImageOptions.output = 'data-uri';
  // Chrome renders <img> SVG without script execution; DOCX/EPUB drop SVG
  resolvedImageOptions.allowSvg = true;
  try {
    sanitized = await resolveExportImages(sanitized, resolvedImageOptions);
  } catch (e) {
    sanitized = sanitized.replace(/<img(?![a-z0-9_:.-])[^>]*(?:>|$)/gi, '');
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
    // Security (SEC-SSRF): belt and braces — images are already inlined, so
    // abort every request that is not data:/about: (CSS url(), <link>,
    // <object>, fonts, anything the inlining pass did not cover).
    await installPdfRequestFilter(page);
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
    // Wait for network to be idle (inlined images decoded) before printing.
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
  stripDelimitedSpans,
  lazySequenceReplace,
  validURL,
  htmlFromEl,
  processDocxHtml,
  convertHtmlToDocxBuffer,
  htmlToPdfBuffer,
  sanitizeUntrustedHtml,
};
