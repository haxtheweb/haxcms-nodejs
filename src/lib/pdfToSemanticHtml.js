const { getResolvedPDFJS } = require('unpdf');

const DEFAULT_FONT_SIZE = 12;
const HEADING_TOLERANCE = 0.75;
const Y_ALIGNMENT_TOLERANCE = 2;
const MAX_HEADING_WORDS = 16;
const MAX_HEADING_LENGTH = 140;

async function convertPdfBufferToHtml(buffer) {
  let loadingTask = null;
  try {
    const pdfjs = await getResolvedPDFJS();
    const getDocument = pdfjs.getDocument;
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
      disableFontFace: true,
      stopAtErrors: false,
      useSystemFonts: true,
    });
    const pdf = await loadingTask.promise;
    const pages = [];
    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
      const page = await pdf.getPage(pageIndex);
      const textContent = await page.getTextContent();
      const lines = normalizeTextItemsToLines(textContent.items);
      pages.push(lines);
    }
    return linesToSemanticHtml(pages);
  }
  catch (e) {
    throw new Error(`Unable to parse PDF: ${e.message}`);
  }
  finally {
    if (loadingTask && typeof loadingTask.destroy === 'function') {
      try {
        await loadingTask.destroy();
      }
      catch (e) {
        // no-op
      }
    }
  }
}

function normalizeTextItemsToLines(textItems) {
  const items = [];
  for (const item of textItems) {
    if (!item || typeof item.str !== 'string') {
      continue;
    }
    const cleanText = normalizeWhitespace(item.str);
    if (cleanText === '') {
      continue;
    }
    const transform = Array.isArray(item.transform) ? item.transform : [0, 0, 0, 0, 0, 0];
    let x = Number(transform[4]);
    let y = Number(transform[5]);
    let width = Number(item.width);
    if (!Number.isFinite(x)) {
      x = 0;
    }
    if (!Number.isFinite(y)) {
      y = 0;
    }
    if (!Number.isFinite(width) || width <= 0) {
      width = cleanText.length * (DEFAULT_FONT_SIZE * 0.5);
    }
    items.push({
      text: cleanText,
      x: x,
      y: y,
      width: width,
      fontSize: getItemFontSize(item),
    });
  }

  items.sort((a, b) => {
    if (Math.abs(b.y - a.y) > Y_ALIGNMENT_TOLERANCE) {
      return b.y - a.y;
    }
    return a.x - b.x;
  });

  const rows = [];
  for (const item of items) {
    let row = null;
    for (const candidate of rows) {
      if (Math.abs(candidate.y - item.y) <= Y_ALIGNMENT_TOLERANCE) {
        row = candidate;
        break;
      }
    }
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }

  rows.sort((a, b) => b.y - a.y);
  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let lineText = '';
    let previous = null;
    let lineFontSize = DEFAULT_FONT_SIZE;
    for (const item of row.items) {
      lineFontSize = Math.max(lineFontSize, item.fontSize);
      if (previous) {
        const previousRightEdge = previous.x + previous.width;
        const gap = item.x - previousRightEdge;
        if (gap > item.fontSize * 0.2 && !lineText.endsWith(' ')) {
          lineText += ' ';
        }
      }
      lineText += item.text;
      previous = item;
    }
    lineText = normalizeWhitespace(lineText);
    if (lineText !== '') {
      lines.push({
        text: lineText,
        fontSize: lineFontSize,
      });
    }
  }
  return lines;
}

function linesToSemanticHtml(pages) {
  const fontStats = buildFontStats(pages);
  const bodyFontSize = getBodyFontSize(fontStats);
  const headingSizes = getHeadingSizes(fontStats, bodyFontSize);
  const htmlParts = [];

  for (const lines of pages) {
    let paragraphBuffer = '';
    let activeListType = null;
    for (const line of lines) {
      const lineInfo = getLineInfo(line, headingSizes);
      if (lineInfo.type === 'paragraph') {
        if (activeListType) {
          htmlParts.push(`</${activeListType}>`);
          activeListType = null;
        }
        if (paragraphBuffer === '') {
          paragraphBuffer = lineInfo.content;
        }
        else if (shouldMergeParagraph(paragraphBuffer, lineInfo.content)) {
          paragraphBuffer += ` ${lineInfo.content}`;
        }
        else {
          htmlParts.push(`<p>${escapeHtml(paragraphBuffer)}</p>`);
          paragraphBuffer = lineInfo.content;
        }
      }
      else {
        if (paragraphBuffer !== '') {
          htmlParts.push(`<p>${escapeHtml(paragraphBuffer)}</p>`);
          paragraphBuffer = '';
        }
        if (lineInfo.type === 'list') {
          if (activeListType !== lineInfo.listType) {
            if (activeListType) {
              htmlParts.push(`</${activeListType}>`);
            }
            activeListType = lineInfo.listType;
            htmlParts.push(`<${activeListType}>`);
          }
          htmlParts.push(`<li>${escapeHtml(lineInfo.content)}</li>`);
        }
        else {
          if (activeListType) {
            htmlParts.push(`</${activeListType}>`);
            activeListType = null;
          }
          htmlParts.push(`<${lineInfo.type}>${escapeHtml(lineInfo.content)}</${lineInfo.type}>`);
        }
      }
    }
    if (paragraphBuffer !== '') {
      htmlParts.push(`<p>${escapeHtml(paragraphBuffer)}</p>`);
    }
    if (activeListType) {
      htmlParts.push(`</${activeListType}>`);
    }
  }

  if (htmlParts.length === 0) {
    return '<p></p>';
  }
  return htmlParts.join('\n');
}

function getLineInfo(line, headingSizes) {
  const rawText = line.text.trim();
  const listMatch = getListMatch(rawText);
  if (listMatch) {
    return {
      type: 'list',
      listType: listMatch.listType,
      content: listMatch.content,
    };
  }

  const headingLevel = getHeadingLevel(line.fontSize, headingSizes);
  if (headingLevel && looksLikeHeading(rawText)) {
    return {
      type: headingLevel,
      content: rawText,
    };
  }

  return {
    type: 'paragraph',
    content: rawText,
  };
}

function getListMatch(text) {
  if (/^[-\u2022\u25CF\u25AA\u25E6]\s+/.test(text)) {
    return {
      listType: 'ul',
      content: text.replace(/^[-\u2022\u25CF\u25AA\u25E6]\s+/, ''),
    };
  }
  if (/^\(?\d+[\.\)]\s+/.test(text)) {
    return {
      listType: 'ol',
      content: text.replace(/^\(?\d+[\.\)]\s+/, ''),
    };
  }
  return null;
}

function buildFontStats(pages) {
  const stats = {};
  for (const lines of pages) {
    for (const line of lines) {
      const size = normalizeFontSize(line.fontSize);
      if (!stats[size]) {
        stats[size] = 0;
      }
      stats[size] += Math.max(1, line.text.length);
    }
  }
  return stats;
}

function getBodyFontSize(fontStats) {
  let size = DEFAULT_FONT_SIZE;
  let weight = 0;
  for (const key in fontStats) {
    if (fontStats[key] > weight) {
      weight = fontStats[key];
      size = Number(key);
    }
  }
  return size;
}

function getHeadingSizes(fontStats, bodyFontSize) {
  const headingCandidates = Object.keys(fontStats)
    .map((size) => Number(size))
    .filter((size) => size > bodyFontSize * 1.15)
    .sort((a, b) => b - a);
  const headingSizes = {};
  if (headingCandidates[0]) {
    headingSizes.h1 = headingCandidates[0];
  }
  if (headingCandidates[1]) {
    headingSizes.h2 = headingCandidates[1];
  }
  if (headingCandidates[2]) {
    headingSizes.h3 = headingCandidates[2];
  }
  return headingSizes;
}

function getHeadingLevel(fontSize, headingSizes) {
  const normalized = normalizeFontSize(fontSize);
  if (headingSizes.h1 && Math.abs(normalized - headingSizes.h1) <= HEADING_TOLERANCE) {
    return 'h1';
  }
  if (headingSizes.h2 && Math.abs(normalized - headingSizes.h2) <= HEADING_TOLERANCE) {
    return 'h2';
  }
  if (headingSizes.h3 && Math.abs(normalized - headingSizes.h3) <= HEADING_TOLERANCE) {
    return 'h3';
  }
  return null;
}

function looksLikeHeading(text) {
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) {
    return false;
  }
  if (words.length > MAX_HEADING_WORDS) {
    return false;
  }
  if (text.length > MAX_HEADING_LENGTH) {
    return false;
  }
  if (/[.!?]$/.test(text)) {
    return false;
  }
  return true;
}

function shouldMergeParagraph(currentText, nextText) {
  if (!/[.!?:;]$/.test(currentText)) {
    return true;
  }
  if (/^[a-z]/.test(nextText)) {
    return true;
  }
  return false;
}

function normalizeWhitespace(value) {
  return value
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFontSize(fontSize) {
  return Math.round(fontSize * 10) / 10;
}

function getItemFontSize(item) {
  let size = Number(item.height);
  if (!Number.isFinite(size) || size <= 0) {
    if (Array.isArray(item.transform)) {
      const transform = item.transform;
      const xScale = Number(transform[0]);
      const yScale = Number(transform[3]);
      if (Number.isFinite(yScale) && yScale !== 0) {
        size = Math.abs(yScale);
      }
      else if (Number.isFinite(xScale) && xScale !== 0) {
        size = Math.abs(xScale);
      }
    }
  }
  if (!Number.isFinite(size) || size <= 0) {
    size = DEFAULT_FONT_SIZE;
  }
  return size;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  convertPdfBufferToHtml,
};
