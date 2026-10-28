const { getResolvedPDFJS, extractImages } = require("unpdf");
const sharp = require("sharp");
const crypto = require("crypto");

const DEFAULT_FONT_SIZE = 12;
const HEADING_TOLERANCE = 0.75;
const Y_ALIGNMENT_TOLERANCE = 2;
const MAX_HEADING_WORDS = 16;
const MAX_HEADING_LENGTH = 140;
// Below this size (either dimension) an extracted image is almost always a
// decorative artifact or gradient fill rather than real page content.
const MIN_IMAGE_DIMENSION = 16;
const IMAGE_QUALITY = 90;
// Imported images are downscaled to this longest edge (pixels). PDF exports
// embed photos at print resolution (e.g. 1536x2048), far more than a page
// ever displays, and each one is stored inline in the page HTML.
const MAX_IMAGE_EDGE = 1600;
// Display box for an imported image: a portrait photo scaled to full column
// width fills several screens, so cap the rendered width by orientation.
const MAX_DISPLAY_WIDTH = 800;
const MAX_DISPLAY_HEIGHT = 600;

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
    // An image taller than a page is drawn on every page it spans (same
    // image object, clipped per page), and pdf.js hands back the whole image
    // each time; remember what we already extracted so it imports once.
    const seenImages = new Set();
    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
      const page = await pdf.getPage(pageIndex);
      const textContent = await page.getTextContent();
      const lines = normalizeTextItemsToLines(textContent.items);
      const imageTops = await getPageImageTops(page, pdfjs.OPS);
      const images = await extractPageImages(
        pdf,
        pageIndex,
        seenImages,
        imageTops,
      );
      pages.push({ lines: lines, images: images });
    }
    return linesToSemanticHtml(pages);
  } catch (e) {
    throw new Error(`Unable to parse PDF: ${e.message}`);
  } finally {
    if (loadingTask && typeof loadingTask.destroy === "function") {
      try {
        await loadingTask.destroy();
      } catch {
        // no-op
      }
    }
  }
}

/**
 * Extract embedded raster images for a single page and re-encode them as
 * base64 JPEG data URIs. A page whose images pdf.js cannot decode (rare)
 * must not fail the whole import, so every failure here is swallowed and
 * simply yields no images for that page.
 */
/**
 * Walk a page's operator list tracking the current transform matrix and
 * return, per image key, the top edge (PDF user space, larger = higher on
 * the page) of each paint of that image, in paint order. Lets images be
 * placed between the text lines they sat between instead of all being
 * appended after the page's text. Best effort: any failure yields an empty
 * map and images fall back to the end of the page.
 */
async function getPageImageTops(page, OPS) {
  const tops = new Map();
  if (!OPS) {
    return tops;
  }
  try {
    const operatorList = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const multiply = (m, n) => [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5],
    ];
    for (let i = 0; i < operatorList.fnArray.length; i++) {
      const op = operatorList.fnArray[i];
      const args = operatorList.argsArray[i];
      if (op === OPS.save) {
        stack.push(ctm);
      } else if (op === OPS.restore) {
        if (stack.length > 0) {
          ctm = stack.pop();
        }
      } else if (op === OPS.transform && Array.isArray(args)) {
        ctm = multiply(ctm, args);
      } else if (op === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (args && Array.isArray(args[0]) && args[0].length === 6) {
          ctm = multiply(ctm, args[0]);
        }
      } else if (op === OPS.paintFormXObjectEnd) {
        if (stack.length > 0) {
          ctm = stack.pop();
        }
      } else if (op === OPS.paintImageXObject && args && args[0]) {
        // images paint into the unit square; its top is the larger y of
        // the transformed corners
        const top = Math.max(
          ctm[5],
          ctm[3] + ctm[5],
          ctm[1] + ctm[5],
          ctm[1] + ctm[3] + ctm[5],
        );
        const key = String(args[0]);
        if (!tops.has(key)) {
          tops.set(key, []);
        }
        tops.get(key).push(top);
      }
    }
  } catch {
    return new Map();
  }
  return tops;
}

async function extractPageImages(pdf, pageIndex, seenImages, imageTops) {
  const extracted = [];
  try {
    const images = await extractImages(pdf, pageIndex);
    for (const image of images) {
      if (
        !image ||
        image.width < MIN_IMAGE_DIMENSION ||
        image.height < MIN_IMAGE_DIMENSION
      ) {
        continue;
      }
      try {
        const raw = Buffer.from(image.data);
        let top = null;
        const keyTops =
          imageTops && image.key ? imageTops.get(image.key) : null;
        if (keyTops && keyTops.length > 0) {
          top = keyTops.shift();
        }
        if (seenImages) {
          const key =
            `${image.width}x${image.height}x${image.channels}:` +
            crypto.createHash("sha256").update(raw).digest("hex");
          if (seenImages.has(key)) {
            continue;
          }
          seenImages.add(key);
        }
        const { data: jpeg, info } = await sharp(raw, {
          raw: {
            width: image.width,
            height: image.height,
            channels: image.channels,
          },
        })
          .resize({
            width: MAX_IMAGE_EDGE,
            height: MAX_IMAGE_EDGE,
            fit: "inside",
            withoutEnlargement: true,
          })
          // pdf.js applies an /SMask as an alpha channel; JPEG has none, and
          // simply dropping it shows whatever the encoder stored under the
          // transparent pixels (black for Chrome), hiding dark line art.
          // Flatten onto white instead (haxcms-php parity).
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: IMAGE_QUALITY })
          .toBuffer({ resolveWithObject: true });
        extracted.push({
          src: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
          width: info.width,
          height: info.height,
          top: top,
        });
      } catch {
        // skip this image; a bad image can't fail the whole import
      }
    }
  } catch {
    // skip images for this page; a bad page can't fail the whole import
  }
  return extracted;
}

/**
 * Width (CSS px) to render an imported image at: its natural size, but no
 * wider than MAX_DISPLAY_WIDTH and no taller than MAX_DISPLAY_HEIGHT.
 */
function getImageDisplayWidth(width, height) {
  if (!(width > 0) || !(height > 0)) {
    return 0;
  }
  return Math.max(
    1,
    Math.round(
      Math.min(width, MAX_DISPLAY_WIDTH, (MAX_DISPLAY_HEIGHT * width) / height),
    ),
  );
}

function normalizeTextItemsToLines(textItems) {
  const items = [];
  for (const item of textItems) {
    if (!item || typeof item.str !== "string") {
      continue;
    }
    const cleanText = normalizeWhitespace(item.str);
    if (cleanText === "") {
      continue;
    }
    const transform = Array.isArray(item.transform)
      ? item.transform
      : [0, 0, 0, 0, 0, 0];
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
    let lineText = "";
    let previous = null;
    let lineFontSize = DEFAULT_FONT_SIZE;
    for (const item of row.items) {
      lineFontSize = Math.max(lineFontSize, item.fontSize);
      if (previous) {
        const previousRightEdge = previous.x + previous.width;
        const gap = item.x - previousRightEdge;
        if (gap > item.fontSize * 0.2 && !lineText.endsWith(" ")) {
          lineText += " ";
        }
      }
      lineText += item.text;
      previous = item;
    }
    lineText = normalizeWhitespace(lineText);
    if (lineText !== "") {
      lines.push({
        text: lineText,
        fontSize: lineFontSize,
        y: row.y,
      });
    }
  }
  return lines;
}

function imageToHtml(image) {
  const displayWidth = getImageDisplayWidth(image.width, image.height);
  return displayWidth > 0
    ? `<img src="${image.src}" width="${displayWidth}">`
    : `<img src="${image.src}">`;
}

function linesToSemanticHtml(pages) {
  const fontStats = buildFontStats(pages);
  const bodyFontSize = getBodyFontSize(fontStats);
  const headingSizes = getHeadingSizes(fontStats, bodyFontSize);
  const htmlParts = [];

  for (const page of pages) {
    const lines = page.lines;
    const images = page.images || [];
    // images with a known position go in reading order between the lines
    // around them; any without one keep the old place after the page text
    const placedImages = images
      .filter((image) => Number.isFinite(image.top))
      .sort((a, b) => b.top - a.top);
    const trailingImages = images.filter(
      (image) => !Number.isFinite(image.top),
    );
    let paragraphBuffer = "";
    let activeListType = null;
    for (const line of lines) {
      // an image whose top edge is above this line's baseline came first
      if (
        placedImages.length > 0 &&
        Number.isFinite(line.y) &&
        placedImages[0].top > line.y
      ) {
        if (paragraphBuffer !== "") {
          htmlParts.push(`<p>${escapeHtml(paragraphBuffer)}</p>`);
          paragraphBuffer = "";
        }
        if (activeListType) {
          htmlParts.push(`</${activeListType}>`);
          activeListType = null;
        }
        while (placedImages.length > 0 && placedImages[0].top > line.y) {
          htmlParts.push(imageToHtml(placedImages.shift()));
        }
      }
      const lineInfo = getLineInfo(line, headingSizes);
      if (lineInfo.type === "paragraph") {
        if (activeListType) {
          htmlParts.push(`</${activeListType}>`);
          activeListType = null;
        }
        if (paragraphBuffer === "") {
          paragraphBuffer = lineInfo.content;
        } else if (shouldMergeParagraph(paragraphBuffer, lineInfo.content)) {
          paragraphBuffer += ` ${lineInfo.content}`;
        } else {
          htmlParts.push(`<p>${escapeHtml(paragraphBuffer)}</p>`);
          paragraphBuffer = lineInfo.content;
        }
      } else {
        if (paragraphBuffer !== "") {
          htmlParts.push(`<p>${escapeHtml(paragraphBuffer)}</p>`);
          paragraphBuffer = "";
        }
        if (lineInfo.type === "list") {
          if (activeListType !== lineInfo.listType) {
            if (activeListType) {
              htmlParts.push(`</${activeListType}>`);
            }
            activeListType = lineInfo.listType;
            htmlParts.push(`<${activeListType}>`);
          }
          htmlParts.push(`<li>${escapeHtml(lineInfo.content)}</li>`);
        } else {
          if (activeListType) {
            htmlParts.push(`</${activeListType}>`);
            activeListType = null;
          }
          htmlParts.push(
            `<${lineInfo.type}>${escapeHtml(lineInfo.content)}</${lineInfo.type}>`,
          );
        }
      }
    }
    if (paragraphBuffer !== "") {
      htmlParts.push(`<p>${escapeHtml(paragraphBuffer)}</p>`);
    }
    if (activeListType) {
      htmlParts.push(`</${activeListType}>`);
    }
    for (const image of placedImages.concat(trailingImages)) {
      htmlParts.push(imageToHtml(image));
    }
  }

  if (htmlParts.length === 0) {
    return "<p></p>";
  }
  return htmlParts.join("\n");
}

function getLineInfo(line, headingSizes) {
  const rawText = line.text.trim();
  const listMatch = getListMatch(rawText);
  if (listMatch) {
    return {
      type: "list",
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
    type: "paragraph",
    content: rawText,
  };
}

function getListMatch(text) {
  if (/^[-\u2022\u25CF\u25AA\u25E6]\s+/.test(text)) {
    return {
      listType: "ul",
      content: text.replace(/^[-\u2022\u25CF\u25AA\u25E6]\s+/, ""),
    };
  }
  if (/^\(?\d+[.)]\s+/.test(text)) {
    return {
      listType: "ol",
      content: text.replace(/^\(?\d+[.)]\s+/, ""),
    };
  }
  return null;
}

function buildFontStats(pages) {
  const stats = {};
  for (const page of pages) {
    for (const line of page.lines) {
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
  if (
    headingSizes.h1 &&
    Math.abs(normalized - headingSizes.h1) <= HEADING_TOLERANCE
  ) {
    return "h1";
  }
  if (
    headingSizes.h2 &&
    Math.abs(normalized - headingSizes.h2) <= HEADING_TOLERANCE
  ) {
    return "h2";
  }
  if (
    headingSizes.h3 &&
    Math.abs(normalized - headingSizes.h3) <= HEADING_TOLERANCE
  ) {
    return "h3";
  }
  return null;
}

function looksLikeHeading(text) {
  const words = text.split(/\s+/).filter((word) => word !== "");
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
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
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
      } else if (Number.isFinite(xScale) && xScale !== 0) {
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
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = {
  convertPdfBufferToHtml,
};
