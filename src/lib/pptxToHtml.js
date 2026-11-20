const JSZip = require("jszip");
const { boundZipBuffer } = require("./boundedZip.js");
const { parseDocument } = require("htmlparser2");

/**
 * PowerPoint (.pptx) to semantic HTML, one page per slide.
 *
 * Each slide becomes `<h1>title</h1>` plus its content, the same shape the
 * .odp importer gives: the title placeholder (else the slide's first line of
 * text, taken out of the body, else "Slide N"); body text as paragraphs, or
 * as nested <ul>/<ol> lists where the paragraphs are bulleted or numbered;
 * tables; pictures as data URI <img> (createNode / addPage turn them into
 * files); runs with bold / italic / underline / strike / super / sub as
 * strong / em / em / del / sup / sub (the .docx importer's map); external
 * links as <a>. Slide numbers, dates, headers, footers and speaker notes are
 * left out. Slides come in presentation order.
 *
 * The output is built only from tags and attributes this file writes, with
 * every text node and attribute value escaped, so it is trusted markup (like
 * the PDF importer's); content is still sanitized when it is stored.
 *
 * Parity: haxcms-php ports this file as lib/PptxToHtml.php. The walk, limits
 * and output strings are kept identical so both backends produce the same
 * HTML for the same deck.
 */

// Security (SEC-UPLOAD): per-entry limits. The archive is inflated by
// boundZipBuffer first, so the sizes checked against these are true sizes.
const MAX_XML_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_SLIDES = 2000;
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
// placeholders that are not slide content
const SKIP_PLACEHOLDERS = new Set(["sldNum", "dt", "ftr", "hdr", "sldImg"]);
const TITLE_PLACEHOLDERS = new Set(["title", "ctrTitle"]);
// placeholders whose paragraphs are bulleted unless a paragraph says not
const BULLET_PLACEHOLDERS = new Set(["obj", "body"]);

function escapeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

function elementChildren(node) {
  return (node && node.children ? node.children : []).filter(
    (child) => child.type === "tag",
  );
}

function child(node, name) {
  return elementChildren(node).find((item) => item.name === name) || null;
}

/** first element named `name` below node, in document order */
function findFirst(node, name) {
  for (const item of elementChildren(node)) {
    if (item.name === name) {
      return item;
    }
    const found = findFirst(item, name);
    if (found) {
      return found;
    }
  }
  return null;
}

function attr(node, name) {
  return node && node.attribs && typeof node.attribs[name] === "string"
    ? node.attribs[name]
    : "";
}

function textOf(node) {
  if (!node) {
    return "";
  }
  if (node.type === "text") {
    return node.data;
  }
  return (node.children || []).map(textOf).join("");
}

function safeHref(href) {
  const value = String(href || "").trim();
  if (/^(https?:|mailto:)/i.test(value) || value.startsWith("#")) {
    return value;
  }
  return "";
}

/** text, or an image, once the tags are taken out (never output) */
function hasContent(html) {
  if (/<img\s/i.test(html)) {
    return true;
  }
  let text = "";
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open === -1) {
      text += html.slice(at);
      break;
    }
    const close = html.indexOf(">", open);
    if (close === -1) {
      text += html.slice(at);
      break;
    }
    text += html.slice(at, open);
    at = close + 1;
  }
  return text.replace(/&nbsp;|\u00a0/g, " ").trim() !== "";
}

/** a zip path for `target` relative to the folder `baseDir` */
function resolvePath(baseDir, target) {
  const parts = target.startsWith("/")
    ? []
    : baseDir.split("/").filter((part) => part !== "");
  for (const part of target.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function dirOf(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function entryUncompressedSize(entry) {
  // JSZip keeps the central directory's uncompressed size on the entry
  return entry &&
    entry._data &&
    typeof entry._data.uncompressedSize === "number"
    ? entry._data.uncompressedSize
    : 0;
}

async function readXml(zip, path, required) {
  const entry = zip.file(path);
  if (!entry) {
    if (required) {
      throw new Error(`The .pptx file has no ${path}.`);
    }
    return null;
  }
  if (entryUncompressedSize(entry) > MAX_XML_BYTES) {
    throw new Error(`The .pptx file's ${path} is too large to import.`);
  }
  const xml = await entry.async("string");
  if (xml.length > MAX_XML_BYTES) {
    throw new Error(`The .pptx file's ${path} is too large to import.`);
  }
  // Security: no DTD / entity declarations (billion laughs); OOXML never needs them
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error(`The .pptx file's ${path} is not valid PowerPoint XML.`);
  }
  return parseDocument(xml, { xmlMode: true });
}

/** Relationship Id -> { target (zip path or URL), external } */
async function readRels(zip, partPath) {
  const relsPath = `${dirOf(partPath)}/_rels/${partPath.split("/").pop()}.rels`;
  const doc = await readXml(zip, relsPath, false);
  const rels = {};
  if (!doc) {
    return rels;
  }
  const root = findFirst(doc, "Relationships");
  for (const rel of elementChildren(root)) {
    if (rel.name !== "Relationship") {
      continue;
    }
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (id === "") {
      continue;
    }
    const external = attr(rel, "TargetMode") === "External";
    rels[id] = {
      target: external ? target : resolvePath(dirOf(partPath), target),
      external: external,
    };
  }
  return rels;
}

class PptxConverter {
  constructor(zip) {
    this.zip = zip;
    this.imageBytes = 0;
    this.images = {};
    // nodes already used elsewhere (a slide's fallback title)
    this.skipNodes = new Set();
  }

  async loadImage(path) {
    if (Object.prototype.hasOwnProperty.call(this.images, path)) {
      return;
    }
    this.images[path] = null;
    const ext = path.split(".").pop().toLowerCase();
    const entry = this.zip.file(path);
    if (!IMAGE_MIME[ext] || !entry) {
      return;
    }
    const size = entryUncompressedSize(entry);
    if (
      size > MAX_IMAGE_BYTES ||
      this.imageBytes + size > MAX_TOTAL_IMAGE_BYTES
    ) {
      return;
    }
    const data = await entry.async("nodebuffer");
    this.imageBytes += data.length;
    this.images[path] =
      `data:${IMAGE_MIME[ext]};base64,${data.toString("base64")}`;
  }

  /** read every picture a slide shows, before the sync walk */
  async loadSlideImages(spTree, rels) {
    const visit = async (node) => {
      for (const item of elementChildren(node)) {
        if (item.name === "a:blip") {
          const rel = rels[attr(item, "r:embed")];
          if (rel && !rel.external) {
            await this.loadImage(rel.target);
          }
        }
        await visit(item);
      }
    };
    await visit(spTree);
  }

  inline(paragraph, rels) {
    let out = "";
    for (const item of elementChildren(paragraph)) {
      if (item.name === "a:br") {
        out += "<br>";
        continue;
      }
      if (item.name !== "a:r" && item.name !== "a:fld") {
        continue;
      }
      const textNode = child(item, "a:t");
      const text = textOf(textNode);
      if (text === "") {
        continue;
      }
      const props = child(item, "a:rPr");
      const link = props ? child(props, "a:hlinkClick") : null;
      let href = "";
      if (link) {
        const rel = rels[attr(link, "r:id")];
        if (rel && rel.external) {
          href = safeHref(rel.target);
        }
      }
      let html = escapeText(text).replace(/\u000b/g, "<br>");
      const baseline = parseInt(attr(props, "baseline") || "0", 10) || 0;
      if (baseline > 0) {
        html = `<sup>${html}</sup>`;
      } else if (baseline < 0) {
        html = `<sub>${html}</sub>`;
      }
      const strike = attr(props, "strike");
      if (strike !== "" && strike !== "noStrike") {
        html = `<del>${html}</del>`;
      }
      const underline = attr(props, "u");
      const italic = attr(props, "i") === "1" || attr(props, "i") === "true";
      // underline is how links look, not emphasis
      if (italic || (underline !== "" && underline !== "none" && !href)) {
        html = `<em>${html}</em>`;
      }
      if (attr(props, "b") === "1" || attr(props, "b") === "true") {
        html = `<strong>${html}</strong>`;
      }
      out += href ? `<a href="${escapeAttr(href)}">${html}</a>` : html;
    }
    return out;
  }

  /**
   * A text body's paragraphs as HTML: plain paragraphs as <p>, bulleted or
   * numbered ones grouped into nested <ul>/<ol>.
   */
  textBody(body, bulleted, rels) {
    let out = "";
    // open lists: [{ tag, level, items: [html] }]
    let stack = [];
    const closeTo = (level) => {
      while (stack.length && stack[stack.length - 1].level > level) {
        const done = stack.pop();
        const html = `<${done.tag}>${done.items.map((item) => `<li>${item}</li>`).join("")}</${done.tag}>`;
        if (stack.length) {
          const parent = stack[stack.length - 1];
          parent.items[parent.items.length - 1] += html;
        } else {
          out += `${html}\n`;
        }
      }
    };
    for (const paragraph of elementChildren(body)) {
      if (paragraph.name !== "a:p" || this.skipNodes.has(paragraph)) {
        continue;
      }
      const inner = this.inline(paragraph, rels).trim();
      if (!hasContent(inner)) {
        continue;
      }
      const props = child(paragraph, "a:pPr");
      let level = parseInt(attr(props, "lvl") || "0", 10) || 0;
      level = Math.min(Math.max(level, 0), 8);
      let tag = bulleted ? "ul" : "";
      if (props && child(props, "a:buNone")) {
        tag = "";
      } else if (props && child(props, "a:buAutoNum")) {
        tag = "ol";
      } else if (
        props &&
        (child(props, "a:buChar") || child(props, "a:buBlip"))
      ) {
        tag = "ul";
      }
      if (tag === "") {
        closeTo(-1);
        out += `<p>${inner}</p>\n`;
        continue;
      }
      // a deeper level than the list open now nests one level down
      if (stack.length && level > stack[stack.length - 1].level) {
        level = stack[stack.length - 1].level + 1;
      } else if (!stack.length) {
        level = 0;
      }
      closeTo(level);
      const top = stack.length ? stack[stack.length - 1] : null;
      if (top && top.level === level && top.tag === tag) {
        top.items.push(inner);
      } else if (top && top.level === level) {
        // same level, other list type: close it and open the new one
        closeTo(level - 1);
        stack.push({ tag: tag, level: level, items: [inner] });
      } else {
        stack.push({ tag: tag, level: level, items: [inner] });
      }
    }
    closeTo(-1);
    return out;
  }

  table(tbl, rels) {
    const props = child(tbl, "a:tblPr");
    const firstRow =
      attr(props, "firstRow") === "1" || attr(props, "firstRow") === "true";
    const rows = elementChildren(tbl).filter((item) => item.name === "a:tr");
    const rowHtml = (row, cellTag) => {
      let cells = "";
      for (const cell of elementChildren(row)) {
        if (cell.name !== "a:tc") {
          continue;
        }
        // covered by a merged neighbour
        if (attr(cell, "hMerge") === "1" || attr(cell, "vMerge") === "1") {
          continue;
        }
        let attrs = "";
        const colspan = parseInt(attr(cell, "gridSpan") || "1", 10);
        const rowspan = parseInt(attr(cell, "rowSpan") || "1", 10);
        if (colspan > 1) {
          attrs += ` colspan="${Math.min(colspan, 1000)}"`;
        }
        if (rowspan > 1) {
          attrs += ` rowspan="${Math.min(rowspan, 1000)}"`;
        }
        const body = child(cell, "a:txBody");
        let inner = "";
        if (body) {
          const blocks = this.textBody(body, false, rels).trim();
          // one plain paragraph: its text alone
          const single = /^<p>([\s\S]*)<\/p>$/.exec(blocks);
          inner =
            single && blocks.indexOf("<p>", 1) === -1 ? single[1] : blocks;
        }
        cells += `<${cellTag}${attrs}>${inner}</${cellTag}>`;
      }
      return `<tr>${cells}</tr>`;
    };
    if (!rows.length) {
      return "";
    }
    let html = "<table>";
    let bodyRows = rows;
    if (firstRow) {
      html += `<thead>${rowHtml(rows[0], "th")}</thead>`;
      bodyRows = rows.slice(1);
    }
    html += `<tbody>${bodyRows.map((row) => rowHtml(row, "td")).join("")}</tbody>`;
    return `${html}</table>\n`;
  }

  picture(pic, rels) {
    const blip = findFirst(pic, "a:blip");
    const rel = blip ? rels[attr(blip, "r:embed")] : null;
    const src = rel && !rel.external ? this.images[rel.target] : null;
    if (!src) {
      return "";
    }
    const info = findFirst(pic, "p:cNvPr");
    const alt = attr(info, "descr").trim();
    return `<p><img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"></p>\n`;
  }

  /** a slide's shapes in document order, groups opened */
  shapes(node, list) {
    for (const item of elementChildren(node)) {
      if (item.name === "p:grpSp") {
        this.shapes(item, list);
      } else if (item.name === "mc:AlternateContent") {
        const fallback = child(item, "mc:Fallback");
        if (fallback) {
          this.shapes(fallback, list);
        }
      } else if (
        item.name === "p:sp" ||
        item.name === "p:pic" ||
        item.name === "p:graphicFrame"
      ) {
        const ph = findFirst(child(item, "p:nvSpPr"), "p:ph");
        const type = ph ? attr(ph, "type") || "obj" : "";
        if (!SKIP_PLACEHOLDERS.has(type)) {
          list.push({ node: item, placeholder: type });
        }
      }
    }
    return list;
  }

  shapeHtml(shape, rels) {
    const node = shape.node;
    if (node.name === "p:pic") {
      return this.picture(node, rels);
    }
    if (node.name === "p:graphicFrame") {
      const tbl = findFirst(node, "a:tbl");
      return tbl ? this.table(tbl, rels) : "";
    }
    const body = child(node, "p:txBody");
    if (!body) {
      return "";
    }
    return this.textBody(
      body,
      BULLET_PLACEHOLDERS.has(shape.placeholder),
      rels,
    );
  }

  slide(doc, rels, number) {
    const spTree = findFirst(doc, "p:spTree");
    if (!spTree) {
      return "";
    }
    const shapes = this.shapes(spTree, []);
    let title = "";
    for (const shape of shapes) {
      if (!TITLE_PLACEHOLDERS.has(shape.placeholder)) {
        continue;
      }
      const body = child(shape.node, "p:txBody");
      const lines = [];
      for (const paragraph of elementChildren(body)) {
        if (paragraph.name !== "a:p") {
          continue;
        }
        const inner = this.inline(paragraph, rels).trim();
        if (hasContent(inner)) {
          lines.push(inner);
        }
      }
      if (lines.length) {
        title = lines.join(" ");
        break;
      }
    }
    if (title === "") {
      for (const shape of shapes) {
        if (
          TITLE_PLACEHOLDERS.has(shape.placeholder) ||
          shape.node.name !== "p:sp"
        ) {
          continue;
        }
        const body = child(shape.node, "p:txBody");
        for (const paragraph of elementChildren(body)) {
          if (paragraph.name !== "a:p") {
            continue;
          }
          const inner = this.inline(paragraph, rels).trim();
          if (hasContent(inner)) {
            title = inner;
            this.skipNodes.add(paragraph);
            break;
          }
        }
        if (title !== "") {
          break;
        }
      }
    }
    let bodyHtml = "";
    for (const shape of shapes) {
      if (TITLE_PLACEHOLDERS.has(shape.placeholder)) {
        continue;
      }
      bodyHtml += this.shapeHtml(shape, rels);
    }
    if (title === "" && bodyHtml === "") {
      return "";
    }
    if (title === "") {
      title = `Slide ${number}`;
    }
    return `<h1>${title}</h1>\n${bodyHtml}`;
  }
}

/**
 * True when a buffer starts with the ZIP local file header signature.
 * @param {Buffer} buffer
 */
function hasZipSignature(buffer) {
  return (
    !!buffer &&
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

/**
 * Convert a .pptx buffer to HTML: one `<h1>` per slide, then its content.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function convertPptxBufferToHtml(buffer) {
  if (!hasZipSignature(buffer)) {
    throw new Error(
      "Uploaded file is not a valid .pptx file (missing ZIP signature).",
    );
  }
  let zip;
  try {
    // Security (SEC-DOS, SEC-UPLOAD): inflate under real byte limits first,
    // so the per-entry size checks below read true sizes
    zip = await JSZip.loadAsync(await boundZipBuffer(buffer, "pptx"));
  } catch (e) {
    if (e && e.code === "ZIP_BUDGET") {
      throw e;
    }
    throw new Error(
      "Uploaded file is not a valid .pptx file (unreadable ZIP).",
    );
  }
  const presentationPath = "ppt/presentation.xml";
  const presentation = await readXml(zip, presentationPath, false);
  const presentationRels = presentation
    ? await readRels(zip, presentationPath)
    : {};
  const slidePaths = [];
  const list = presentation ? findFirst(presentation, "p:sldIdLst") : null;
  for (const slideId of elementChildren(list)) {
    if (slideId.name !== "p:sldId") {
      continue;
    }
    const rel = presentationRels[attr(slideId, "r:id")];
    if (rel && !rel.external && slidePaths.indexOf(rel.target) === -1) {
      slidePaths.push(rel.target);
    }
  }
  if (!slidePaths.length) {
    // no slide list to follow: the slide parts in number order
    const numbered = [];
    for (const name of Object.keys(zip.files)) {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
      if (match) {
        numbered.push({ name: name, number: parseInt(match[1], 10) });
      }
    }
    numbered.sort((a, b) => a.number - b.number);
    for (const entry of numbered) {
      slidePaths.push(entry.name);
    }
  }
  if (slidePaths.length > MAX_SLIDES) {
    throw new Error("The .pptx file has too many slides to import.");
  }
  const converter = new PptxConverter(zip);
  let html = "";
  let number = 0;
  for (const path of slidePaths) {
    number += 1;
    const doc = await readXml(zip, path, false);
    if (!doc) {
      continue;
    }
    const rels = await readRels(zip, path);
    const spTree = findFirst(doc, "p:spTree");
    if (spTree) {
      await converter.loadSlideImages(spTree, rels);
    }
    html += converter.slide(doc, rels, number);
  }
  return html.trim();
}

module.exports = { convertPptxBufferToHtml, hasZipSignature };
