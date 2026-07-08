const { parse } = require('node-html-parser');
const HTMLtoDOCX = require('html-to-docx');

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

module.exports = {
  stripMSWord,
  validURL,
  htmlFromEl,
  processDocxHtml,
  convertHtmlToDocxBuffer,
};
