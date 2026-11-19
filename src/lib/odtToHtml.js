const JSZip = require("jszip");
const { parseDocument } = require("htmlparser2");

/**
 * OpenDocument Text (.odt) to semantic HTML.
 *
 * Reads content.xml (and styles.xml for named styles) out of the ODT zip and
 * walks the ODF tree into plain HTML the shared import hierarchy builder
 * understands: text:h -> h1..h6, text:p -> p, text:list -> ul/ol,
 * table:table -> table, text:a -> a, bold/italic/underline/strike/super/sub
 * text styles -> strong/em/del/sup/sub (underline -> em, strike -> del, the
 * same map the .docx importer uses), embedded Pictures/* -> data URI <img>.
 *
 * The output is built only from tags and attributes this file writes, with
 * every text node and attribute value escaped, so it is trusted markup (like
 * the PDF importer's). Content is still sanitized when it is stored
 * (createNode / addPage run materializeInlineImages then the storage
 * sanitizer).
 *
 * Parity: haxcms-php ports this file as lib/OdtToHtml.php. The walk, skip
 * lists, limits and output strings are kept identical so both backends
 * produce the same HTML for the same document.
 */

const ODT_MIMETYPE = "application/vnd.oasis.opendocument.text";
// Security (SEC-UPLOAD): the zip directory states each entry's uncompressed
// size; refuse to inflate past these, so a small upload can't expand into a
// huge string or buffer (zip bomb).
const MAX_XML_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
// table:number-columns-repeated / rows-repeated can claim thousands of empty
// cells; render at most this many copies of one cell or row.
const MAX_REPEAT = 100;
// text:s c="n" (n spaces)
const MAX_SPACES = 100;
// parent-style-name chains
const MAX_STYLE_DEPTH = 10;
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
// generated or out-of-flow structures: tables of contents and indexes repeat
// the headings, notes and annotations are not body text
const SKIP_BLOCKS = new Set([
  "text:table-of-content",
  "text:alphabetical-index",
  "text:illustration-index",
  "text:table-index",
  "text:object-index",
  "text:user-index",
  "text:bibliography",
  "text:tracked-changes",
  "text:sequence-decls",
  "text:variable-decls",
  "text:user-field-decls",
  "text:dde-connection-decls",
  "office:forms",
  "office:annotation",
  "office:annotation-end",
  "text:soft-page-break",
  "table:table-columns",
  "table:table-column",
  "table:table-column-group",
  "table:table-header-columns",
]);
const SKIP_INLINE = new Set([
  "text:note",
  "office:annotation",
  "office:annotation-end",
  "text:bookmark",
  "text:bookmark-start",
  "text:bookmark-end",
  "text:reference-mark",
  "text:reference-mark-start",
  "text:reference-mark-end",
  "text:soft-page-break",
  "text:change",
  "text:change-start",
  "text:change-end",
  "text:toc-mark",
  "text:toc-mark-start",
  "text:toc-mark-end",
  "text:alphabetical-index-mark",
  "text:alphabetical-index-mark-start",
  "text:alphabetical-index-mark-end",
  "draw:custom-shape",
  "draw:rect",
  "draw:line",
  "draw:ellipse",
  "draw:connector",
]);

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

function findFirst(node, name) {
  for (const child of elementChildren(node)) {
    if (child.name === name) {
      return child;
    }
    const found = findFirst(child, name);
    if (found) {
      return found;
    }
  }
  return null;
}

function textContent(node) {
  if (!node) {
    return "";
  }
  if (node.type === "text") {
    return node.data;
  }
  return (node.children || []).map(textContent).join("");
}

function attr(node, name) {
  return node && node.attribs && typeof node.attribs[name] === "string"
    ? node.attribs[name]
    : "";
}

/**
 * Collect style:style (family text / paragraph) and text:list-style
 * definitions from an office:styles / office:automatic-styles container.
 */
function collectStyles(container, styles) {
  for (const child of elementChildren(container)) {
    if (child.name === "style:style") {
      const name = attr(child, "style:name");
      if (!name) {
        continue;
      }
      const props = elementChildren(child).find(
        (node) => node.name === "style:text-properties",
      );
      styles.text[name] = {
        parent: attr(child, "style:parent-style-name"),
        format: props ? formatFromProps(props) : {},
        outline: parseInt(attr(child, "style:default-outline-level"), 10) || 0,
      };
    } else if (child.name === "text:list-style") {
      const name = attr(child, "style:name");
      if (!name) {
        continue;
      }
      const levels = {};
      for (const level of elementChildren(child)) {
        const depth = parseInt(attr(level, "text:level") || "1", 10);
        if (level.name === "text:list-level-style-number") {
          const numFormat = attr(level, "style:num-format");
          levels[depth] = numFormat !== "" ? "ol" : "ul";
        } else if (
          level.name === "text:list-level-style-bullet" ||
          level.name === "text:list-level-style-image"
        ) {
          levels[depth] = "ul";
        }
      }
      styles.lists[name] = levels;
    }
  }
}

function formatFromProps(props) {
  const format = {};
  const weight = attr(props, "fo:font-weight");
  if (weight === "bold" || parseInt(weight, 10) >= 600) {
    format.bold = true;
  } else if (weight !== "") {
    format.bold = false;
  }
  const fontStyle = attr(props, "fo:font-style");
  if (fontStyle === "italic" || fontStyle === "oblique") {
    format.italic = true;
  } else if (fontStyle !== "") {
    format.italic = false;
  }
  const underline = attr(props, "style:text-underline-style");
  if (underline !== "") {
    format.underline = underline !== "none";
  }
  const strike = attr(props, "style:text-line-through-style");
  if (strike !== "") {
    format.strike = strike !== "none";
  }
  const position = attr(props, "style:text-position").trim();
  if (position !== "") {
    const first = position.split(/\s+/)[0];
    if (first === "super" || (/^\d/.test(first) && parseFloat(first) > 0)) {
      format.position = "sup";
    } else if (first === "sub" || /^-\d/.test(first)) {
      format.position = "sub";
    } else {
      format.position = "";
    }
  }
  return format;
}

/** a style's format with its parent chain folded in (child wins) */
function resolveFormat(styles, name) {
  const chain = [];
  let current = name;
  let depth = 0;
  while (current && styles.text[current] && depth < MAX_STYLE_DEPTH) {
    chain.unshift(styles.text[current].format);
    current = styles.text[current].parent;
    depth += 1;
  }
  return Object.assign({}, ...chain);
}

/**
 * The heading level a paragraph style gives (its or a parent's
 * default-outline-level, or the standard "Heading N" style name), else 0.
 */
function resolveOutline(styles, name) {
  let current = name;
  let depth = 0;
  while (current && depth < MAX_STYLE_DEPTH) {
    const style = styles.text[current];
    if (style && style.outline > 0) {
      return style.outline;
    }
    const named = /^Heading_20_([1-6])$/.exec(current);
    if (named) {
      return parseInt(named[1], 10);
    }
    current = style ? style.parent : "";
    depth += 1;
  }
  return 0;
}

function mergeFormat(base, extra) {
  return Object.assign({}, base, extra);
}

function wrapFormat(html, format) {
  if (html === "") {
    return html;
  }
  let out = html;
  if (format.position === "sup") {
    out = `<sup>${out}</sup>`;
  } else if (format.position === "sub") {
    out = `<sub>${out}</sub>`;
  }
  if (format.strike) {
    out = `<del>${out}</del>`;
  }
  if (format.italic || format.underline) {
    out = `<em>${out}</em>`;
  }
  if (format.bold) {
    out = `<strong>${out}</strong>`;
  }
  return out;
}

function safeHref(href) {
  const value = String(href || "").trim();
  if (/^(https?:|mailto:)/i.test(value) || value.startsWith("#")) {
    return value;
  }
  return "";
}

class OdtConverter {
  constructor(zip, styles) {
    this.zip = zip;
    this.styles = styles;
    this.imageBytes = 0;
    this.images = {};
  }

  /** read every Pictures/* the document points at, before the sync walk */
  async loadImages(root) {
    const paths = [];
    const visit = (node) => {
      for (const child of elementChildren(node)) {
        if (child.name === "draw:image") {
          const href = attr(child, "xlink:href");
          if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            paths.push(href.replace(/^\.\//, ""));
          }
        }
        visit(child);
      }
    };
    visit(root);
    for (const path of paths) {
      if (Object.prototype.hasOwnProperty.call(this.images, path)) {
        continue;
      }
      this.images[path] = null;
      const ext = path.split(".").pop().toLowerCase();
      const entry = this.zip.file(path);
      if (!IMAGE_MIME[ext] || !entry) {
        continue;
      }
      const size = entryUncompressedSize(entry);
      if (
        size > MAX_IMAGE_BYTES ||
        this.imageBytes + size > MAX_TOTAL_IMAGE_BYTES
      ) {
        continue;
      }
      const data = await entry.async("nodebuffer");
      this.imageBytes += data.length;
      this.images[path] =
        `data:${IMAGE_MIME[ext]};base64,${data.toString("base64")}`;
    }
  }

  imageHtml(frame, image) {
    const href = attr(image, "xlink:href");
    let src = "";
    if (/^https?:\/\//i.test(href)) {
      src = href;
    } else {
      src = this.images[href.replace(/^\.\//, "")] || "";
    }
    if (src === "") {
      return "";
    }
    let alt = "";
    const title = elementChildren(frame).find(
      (node) => node.name === "svg:title",
    );
    const desc = elementChildren(frame).find(
      (node) => node.name === "svg:desc",
    );
    if (title && textContent(title).trim() !== "") {
      alt = textContent(title).trim();
    } else if (desc && textContent(desc).trim() !== "") {
      alt = textContent(desc).trim();
    }
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`;
  }

  frameHtml(frame) {
    for (const child of elementChildren(frame)) {
      if (child.name === "draw:image") {
        const html = this.imageHtml(frame, child);
        if (html !== "") {
          return html;
        }
      } else if (child.name === "draw:text-box") {
        const parts = [];
        for (const box of elementChildren(child)) {
          const inner = this.inline(box, {}).trim();
          if (inner !== "") {
            parts.push(inner);
          }
        }
        if (parts.length) {
          return parts.join("<br>");
        }
      }
    }
    return "";
  }

  inline(node, format) {
    let out = "";
    for (const child of node.children || []) {
      if (child.type === "text") {
        out += escapeText(child.data.replace(/[ \t\r\n]+/g, " "));
        continue;
      }
      if (child.type !== "tag" || SKIP_INLINE.has(child.name)) {
        continue;
      }
      switch (child.name) {
        case "text:s": {
          const count = Math.min(
            Math.max(parseInt(attr(child, "text:c") || "1", 10) || 1, 1),
            MAX_SPACES,
          );
          out += " ".repeat(count);
          break;
        }
        case "text:tab":
          out += " ";
          break;
        case "text:line-break":
          out += "<br>";
          break;
        case "text:span": {
          const spanFormat = mergeFormat(
            format,
            resolveFormat(this.styles, attr(child, "text:style-name")),
          );
          out += wrapFormat(
            this.inline(child, spanFormat),
            diffFormat(format, spanFormat),
          );
          break;
        }
        case "text:a": {
          const href = safeHref(attr(child, "xlink:href"));
          const inner = this.inline(child, format);
          out += href ? `<a href="${escapeAttr(href)}">${inner}</a>` : inner;
          break;
        }
        case "draw:frame":
          out += this.frameHtml(child);
          break;
        case "draw:a": {
          const href = safeHref(attr(child, "xlink:href"));
          const inner = this.inline(child, format);
          out += href ? `<a href="${escapeAttr(href)}">${inner}</a>` : inner;
          break;
        }
        case "text:p":
        case "text:h": {
          const inner = this.inline(child, format).trim();
          if (inner !== "") {
            out += (out !== "" ? "<br>" : "") + inner;
          }
          break;
        }
        default:
          // fields (dates, page numbers, sequences) and unknown wrappers:
          // keep their text
          out += this.inline(child, format);
          break;
      }
    }
    return out;
  }

  paragraphInline(node) {
    const base = resolveFormat(this.styles, attr(node, "text:style-name"));
    return wrapFormat(this.inline(node, base).trim(), base);
  }

  blocks(node) {
    // rendered blocks; a list stays as its parts until the next block, so a
    // following list that continues it can join it
    const out = [];
    for (const child of elementChildren(node)) {
      if (child.name === "text:list" && !containsListHeading(child)) {
        const parts = this.listParts(child, "", 1);
        const previous = out.length ? out[out.length - 1] : null;
        if (
          previous &&
          typeof previous === "object" &&
          joinsList(child, parts, previous)
        ) {
          joinListParts(previous, parts);
        } else if (parts.items.length) {
          out.push(parts);
        }
        continue;
      }
      const html = this.block(child);
      if (html !== "") {
        out.push(html);
      }
    }
    return out
      .map((entry) => (typeof entry === "object" ? renderList(entry) : entry))
      .join("");
  }

  block(node) {
    if (SKIP_BLOCKS.has(node.name)) {
      return "";
    }
    switch (node.name) {
      case "text:h": {
        let level = parseInt(attr(node, "text:outline-level") || "1", 10);
        if (!(level >= 1)) {
          level = 1;
        }
        return this.heading(node, level);
      }
      case "text:p": {
        const outline = resolveOutline(
          this.styles,
          attr(node, "text:style-name"),
        );
        if (outline > 0) {
          return this.heading(node, outline);
        }
        const inner = this.paragraphInline(node);
        return hasContent(inner) ? `<p>${inner}</p>\n` : "";
      }
      case "text:list":
        return containsListHeading(node)
          ? this.flatList(node)
          : renderList(this.listParts(node, "", 1));
      case "table:table":
        return this.table(node);
      case "draw:frame": {
        const inner = this.frameHtml(node);
        return hasContent(inner) ? `<p>${inner}</p>\n` : "";
      }
      default:
        // text:section, office:text and other containers
        return this.blocks(node);
    }
  }

  heading(node, level) {
    const inner = this.inline(node, {}).trim();
    if (!hasContent(inner)) {
      return "";
    }
    const tag = `h${Math.min(level, 6)}`;
    return `<${tag}>${inner}</${tag}>\n`;
  }

  /** numbered headings written as a list: keep them as headings */
  flatList(node) {
    let flat = "";
    for (const item of elementChildren(node)) {
      if (item.name !== "text:list-item" && item.name !== "text:list-header") {
        continue;
      }
      for (const child of elementChildren(item)) {
        flat +=
          child.name === "text:list" ? this.flatList(child) : this.block(child);
      }
    }
    return flat;
  }

  /**
   * A list as { tag, items: [{ html, wrapper }] }. A wrapper item holds only
   * nested lists (no text of its own), the shape Word-origin documents use
   * to carry a nested list in a list of its own.
   */
  listParts(node, styleName, depth) {
    const ownStyle = attr(node, "text:style-name") || styleName;
    const levels = this.styles.lists[ownStyle] || {};
    const parts = { tag: levels[depth] === "ol" ? "ol" : "ul", items: [] };
    for (const item of elementChildren(node)) {
      if (item.name !== "text:list-item" && item.name !== "text:list-header") {
        continue;
      }
      const children = elementChildren(item).filter(
        (child) => !SKIP_BLOCKS.has(child.name),
      );
      const paragraphs = children.filter((child) => child.name === "text:p");
      const others = children.filter(
        (child) => child.name !== "text:p" && child.name !== "text:list",
      );
      const inline = paragraphs.length === 1 && others.length === 0;
      let html = "";
      for (const child of children) {
        if (child.name === "text:list") {
          html += renderList(this.listParts(child, ownStyle, depth + 1));
        } else {
          html += inline ? this.paragraphInline(child) : this.block(child);
        }
      }
      html = html.trim();
      if (hasContent(html)) {
        parts.items.push({
          html: html,
          wrapper: paragraphs.length === 0 && others.length === 0,
        });
      }
    }
    return parts;
  }

  table(node) {
    const head = [];
    const body = [];
    const collect = (container, target) => {
      for (const child of elementChildren(container)) {
        if (child.name === "table:table-row") {
          const repeat = Math.min(
            Math.max(
              parseInt(attr(child, "table:number-rows-repeated") || "1", 10) ||
                1,
              1,
            ),
            MAX_REPEAT,
          );
          for (let i = 0; i < repeat; i++) {
            target.push(child);
          }
        } else if (child.name === "table:table-header-rows") {
          collect(child, head);
        } else if (
          child.name === "table:table-rows" ||
          child.name === "table:table-row-group"
        ) {
          collect(child, target);
        }
      }
    };
    collect(node, body);
    const rowHtml = (row, cellTag) => {
      let cells = "";
      for (const cell of elementChildren(row)) {
        if (cell.name !== "table:table-cell") {
          continue;
        }
        let attrs = "";
        const colspan = parseInt(
          attr(cell, "table:number-columns-spanned") || "1",
          10,
        );
        const rowspan = parseInt(
          attr(cell, "table:number-rows-spanned") || "1",
          10,
        );
        if (colspan > 1) {
          attrs += ` colspan="${Math.min(colspan, 1000)}"`;
        }
        if (rowspan > 1) {
          attrs += ` rowspan="${Math.min(rowspan, 1000)}"`;
        }
        const children = elementChildren(cell).filter(
          (child) => !SKIP_BLOCKS.has(child.name),
        );
        let inner = "";
        if (children.length === 1 && children[0].name === "text:p") {
          inner = this.paragraphInline(children[0]);
        } else {
          inner = this.blocks(cell).trim();
        }
        const repeat = Math.min(
          Math.max(
            parseInt(attr(cell, "table:number-columns-repeated") || "1", 10) ||
              1,
            1,
          ),
          MAX_REPEAT,
        );
        for (let i = 0; i < repeat; i++) {
          cells += `<${cellTag}${attrs}>${inner}</${cellTag}>`;
        }
      }
      return `<tr>${cells}</tr>`;
    };
    let html = "<table>";
    if (head.length) {
      html += `<thead>${head.map((row) => rowHtml(row, "th")).join("")}</thead>`;
    }
    html += `<tbody>${body.map((row) => rowHtml(row, "td")).join("")}</tbody>`;
    html += "</table>\n";
    return head.length || body.length ? html : "";
  }
}

function renderList(parts) {
  if (!parts.items.length) {
    return "";
  }
  const items = parts.items.map((item) => `<li>${item.html}</li>`).join("");
  return `<${parts.tag}>${items}</${parts.tag}>\n`;
}

/**
 * Whether a list continues the list rendered just before it: it opens with
 * a wrapper item (a nested level split out on its own), or ODF marks it as
 * continuing (text:continue-list / text:continue-numbering) with the same
 * list type.
 */
function joinsList(node, parts, previous) {
  if (!parts.items.length || !previous.items.length) {
    return false;
  }
  if (parts.items[0].wrapper) {
    return true;
  }
  return (
    (attr(node, "text:continue-list") !== "" ||
      attr(node, "text:continue-numbering") === "true") &&
    parts.tag === previous.tag
  );
}

/** fold `parts` into `previous`: wrapper items nest under its last item */
function joinListParts(previous, parts) {
  for (const item of parts.items) {
    if (item.wrapper && previous.items.length) {
      previous.items[previous.items.length - 1].html += item.html;
    } else {
      previous.items.push(item);
    }
  }
}

/** only the format keys that change from `outer` to `inner` */
function diffFormat(outer, inner) {
  const diff = {};
  for (const key of ["bold", "italic", "underline", "strike"]) {
    if (inner[key] && !outer[key]) {
      diff[key] = true;
    }
  }
  if (inner.position && inner.position !== outer.position) {
    diff.position = inner.position;
  }
  return diff;
}

function containsListHeading(list) {
  for (const item of elementChildren(list)) {
    for (const child of elementChildren(item)) {
      if (child.name === "text:h") {
        return true;
      }
      if (child.name === "text:list" && containsListHeading(child)) {
        return true;
      }
    }
  }
  return false;
}

/** text, or an image, once the tags are taken out */
function hasContent(html) {
  if (/<img\s/i.test(html)) {
    return true;
  }
  return (
    html
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;|\u00a0/g, " ")
      .trim() !== ""
  );
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
      throw new Error(`The .odt file has no ${path}.`);
    }
    return null;
  }
  if (entryUncompressedSize(entry) > MAX_XML_BYTES) {
    throw new Error(`The .odt file's ${path} is too large to import.`);
  }
  const xml = await entry.async("string");
  if (xml.length > MAX_XML_BYTES) {
    throw new Error(`The .odt file's ${path} is too large to import.`);
  }
  // Security: no DTD / entity declarations (billion laughs); ODF never needs them
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error(`The .odt file's ${path} is not valid OpenDocument XML.`);
  }
  return parseDocument(xml, { xmlMode: true });
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
 * Convert an .odt buffer to HTML.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function convertOdtBufferToHtml(buffer) {
  if (!hasZipSignature(buffer)) {
    throw new Error(
      "Uploaded file is not a valid .odt file (missing ZIP signature).",
    );
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("Uploaded file is not a valid .odt file (unreadable ZIP).");
  }
  const mimeEntry = zip.file("mimetype");
  if (mimeEntry && entryUncompressedSize(mimeEntry) <= 256) {
    const mime = (await mimeEntry.async("string")).trim();
    // .odt, plus Writer's web / master / template variants, all keep
    // their body in office:text
    if (mime !== ODT_MIMETYPE && mime.indexOf(`${ODT_MIMETYPE}-`) !== 0) {
      throw new Error(
        `Uploaded file is not an OpenDocument text file (${mime || "unknown type"}).`,
      );
    }
  }
  const content = await readXml(zip, "content.xml", true);
  const stylesDoc = await readXml(zip, "styles.xml", false);
  const styles = { text: {}, lists: {} };
  if (stylesDoc) {
    const named = findFirst(stylesDoc, "office:styles");
    if (named) {
      collectStyles(named, styles);
    }
    const auto = findFirst(stylesDoc, "office:automatic-styles");
    if (auto) {
      collectStyles(auto, styles);
    }
  }
  const contentAuto = findFirst(content, "office:automatic-styles");
  if (contentAuto) {
    collectStyles(contentAuto, styles);
  }
  const body = findFirst(content, "office:text");
  if (!body) {
    throw new Error("The .odt file has no text body.");
  }
  const converter = new OdtConverter(zip, styles);
  await converter.loadImages(body);
  return converter.blocks(body).trim();
}

module.exports = {
  convertOdtBufferToHtml,
  hasZipSignature,
  ODT_MIMETYPE,
};
