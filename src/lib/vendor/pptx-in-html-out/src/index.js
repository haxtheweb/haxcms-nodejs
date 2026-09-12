import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import path from 'node:path';

const TITLE_PLACEHOLDER_TYPES = ['title', 'ctrTitle'];
const IMAGE_MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export class PPTXInHTMLOut {
  constructor(pptxBuffer) {
    this.pptxBuffer = pptxBuffer;
    this.zip = null;
    this.debug = false;
    this.slides = [];
    this.extractedFiles = {};
    this.imageReferenceMap = new Map();
  }

  setDebug(enabled) {
    this.debug = enabled;
    return this;
  }

  log(...args) {
    if (this.debug) {
      console.log(...args);
    }
  }

  asArray(value) {
    if (!value) {
      return [];
    }
    if (Array.isArray(value)) {
      return value;
    }
    return [value];
  }
//pptx is a zip, powerpoint stores each slide as its own file, and slideFile in this case is a path string
  getSlideNumber(slideFile) {
    const match = String(slideFile).match(/slide(\d+)\.xml/i);// the \d+eans one or more digits, and it captures it ie remembers what the number is for later retrieval, \.xml the backslash specifies to regex that this is a actual dot and not just any character, and the i means case insensitive.
    if (!match || !match[1]) {
      return 0;
    }
    return parseInt(match[1], 10);
  }

  escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')//g means replace every occurence
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  extractTextValue(value) {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      let tmp = '';
      for (const item of value) {
        tmp += this.extractTextValue(item);
      }
      return tmp;
    }
    if (value && typeof value === 'object') {
      if (typeof value._ === 'string') {
        return value._;
      }
      if (typeof value['a:t'] !== 'undefined') {
        return this.extractTextValue(value['a:t']);
      }
    }
    return '';
  }

  getParagraphText(paragraph) {
    const chunks = [];
    const runs = this.asArray(paragraph ? paragraph['a:r'] : null);
    for (const run of runs) {
      const text = this.extractTextValue(run ? run['a:t'] : '');
      if (text) {
        chunks.push(text);
      }
    }
    const fields = this.asArray(paragraph ? paragraph['a:fld'] : null);
    for (const field of fields) {
      const text = this.extractTextValue(field ? field['a:t'] : '');
      if (text) {
        chunks.push(text);
      }
    }
    if (chunks.length === 0) {
      const directText = this.extractTextValue(paragraph ? paragraph['a:t'] : '');
      if (directText) {
        chunks.push(directText);
      }
    }
    return chunks.join('').trim();
  }

  getShapeText(shape) {
    const txBody = this.asArray(shape ? shape['p:txBody'] : null)[0];
    if (!txBody) {
      return '';
    }
    const paragraphs = this.asArray(txBody['a:p']);
    const lines = [];
    for (const paragraph of paragraphs) {
      const line = this.getParagraphText(paragraph);
      if (line) {
        lines.push(line);
      }
    }
    return lines.join('\n').trim();
  }

  isTitleShape(shape) {
    const nvSpPr = this.asArray(shape ? shape['p:nvSpPr'] : null)[0];
    if (!nvSpPr) {
      return false;
    }
    const nvPr = this.asArray(nvSpPr['p:nvPr'])[0];
    if (!nvPr) {
      return false;
    }
    const placeholder = this.asArray(nvPr['p:ph'])[0];
    if (!placeholder || !placeholder.$) {
      return false;
    }
    const type = typeof placeholder.$.type === 'string' ? placeholder.$.type : '';
    if (TITLE_PLACEHOLDER_TYPES.includes(type)) {
      return true;
    }
    if (type === '' && (placeholder.$.idx === '0' || placeholder.$.idx === 0)) {
      return true;
    }
    return false;
  }

  getImageMimeType(extension) {
    if (IMAGE_MIME_BY_EXTENSION[extension]) {
      return IMAGE_MIME_BY_EXTENSION[extension];
    }
    return 'application/octet-stream';
  }

  getImageDataUri(fileReference) {
    const imageFile = this.extractedFiles[fileReference];
    if (!imageFile || !Buffer.isBuffer(imageFile.buffer)) {
      return null;
    }
    const mimeType = imageFile.mimeType || 'application/octet-stream';
    return `data:${mimeType};base64,${imageFile.buffer.toString('base64')}`;
  }

  async initialize() {
    try {
      this.zip = await JSZip.loadAsync(this.pptxBuffer);
      const files = Object.keys(this.zip.files);
      // console.log('Files in PPTX:', files);
    } catch (error) {
      console.error('Error initializing:', error);
      throw error;
    }
  }

  async load() {
    if (!Buffer.isBuffer(this.pptxBuffer)) {
      throw new Error('Input must be a Buffer');
    }

    try {
      this.log('Loading PPTX buffer of size:', this.pptxBuffer.length);
      await this.initialize();
      await this.validatePPTX();
    } catch (error) {
      this.log('Error during load:', error);
      throw error;
    }
  }

  async validatePPTX() {
    const files = Object.keys(this.zip.files);
    this.log('Files in PPTX:', files);

    const requiredFiles = [
      'ppt/presentation.xml',
      '_rels/.rels'
    ];

    for (const file of requiredFiles) {
      if (!files.includes(file)) {
        throw new Error(`Invalid PPTX file: missing ${file}`);
      }
    }

    const slideFiles = files.filter(f => f.match(/ppt\/slides\/slide[0-9]+\.xml/));
    if (slideFiles.length === 0) {
      throw new Error('Invalid PPTX file: no slides found');
    }

    this.slideFiles = slideFiles;
  }

  async parse() {
    try {
      await this.parseSlides();
    } catch (error) {
      this.log('Error during parse:', error);
      throw error;
    }
  }

  async parseSlides() {
    const slideFiles = Object.keys(this.zip.files)
      .filter(name => name.startsWith('ppt/slides/slide') && name.endsWith('.xml'))
      .sort((a, b) => this.getSlideNumber(a) - this.getSlideNumber(b));

    this.slides = [];
//every slide's XML must live at ppt/slides/slideN.xml
    for (const slideFile of slideFiles) {//fetches the xml content of every slide
      try {
        const slideContent = await this.zip.file(slideFile).async('string');
        const slideXml = await parseStringPromise(slideContent);
        if (this.debug) {
          console.log('Parsing slide:', slideFile);
        }
        this.slides.push({
          file: slideFile,
          content: slideXml
        });
      } catch (error) {
        console.error(`Error parsing slide ${slideFile}:`, error);
      }
    }

    return this.slides;
  }

  // extracts a slide's (or notes slide's) text blocks + which one is the title,
  // shared by convertSlideToHTML() and toDeckManifest() so title-detection logic
  // only lives in one place
  extractTextBlocks(slide) {
    const sld = slide.content['p:sld'];
    const cSld = sld ? this.asArray(sld['p:cSld'])[0] : null;
    const spTree = cSld ? this.asArray(cSld['p:spTree'])[0] : null;
    if (!spTree) {
      return { spTree: null, textBlocks: [], titleIndex: -1 };
    }
    const textBlocks = [];
    const shapes = this.asArray(spTree['p:sp']);
    for (const shape of shapes) {
      const text = this.getShapeText(shape);
      if (!text) continue;
      textBlocks.push({ text, isTitle: this.isTitleShape(shape) });
    }
    let titleIndex = textBlocks.findIndex((b) => b.isTitle);
    if (titleIndex === -1 && textBlocks.length > 0) {
      titleIndex = 0;
    }
    return { spTree, textBlocks, titleIndex };
  }

  async convertSlideToHTML(slide, options = {}) {
    if (!slide || !slide.content) {
      console.error('Invalid slide content');
      return '';
    }

    const { spTree, textBlocks, titleIndex } = this.extractTextBlocks(slide);
    if (!spTree) {
      return '';
    }

    const slideNumber = this.getSlideNumber(slide.file);
    const title = titleIndex > -1
      ? textBlocks[titleIndex].text.replace(/\s+/g, ' ').trim()
      : `Slide ${slideNumber || 1}`;

    let html = `<div class="slide" data-slide-number="${slideNumber || 1}">`;
    html += `<h1>${this.escapeHtml(title)}</h1>`;

    for (let i = 0; i < textBlocks.length; i += 1) {
      if (i === titleIndex) {
        continue;
      }
      const lines = textBlocks[i].text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
      for (const line of lines) {
        html += `<p>${this.escapeHtml(line)}</p>`;
      }
    }

    const pictures = this.asArray(spTree['p:pic']);
    for (let i = 0; i < pictures.length; i += 1) {
      const rId = this.getPictureEmbedRelationshipId(pictures[i]);
      if (!rId) {
        continue;
      }
      const imageReference = await this.getOrCreateImageReference(
        slide.file,
        rId,
        i + 1,
      );
      if (!imageReference) {
        continue;
      }
      let imageSource = imageReference;
      if (options.inlineImages) {
        const dataUri = this.getImageDataUri(imageReference);
        if (dataUri) {
          imageSource = dataUri;
        }
      }
      html += `<img src="${imageSource}" loading="lazy" decoding="async" alt="" />`;
    }

    html += '</div>';
    return html;
  }

  getPictureEmbedRelationshipId(pic) {
    const blipFill = this.asArray(pic ? pic['p:blipFill'] : null)[0];
    const blip = blipFill ? this.asArray(blipFill['a:blip'])[0] : null;
    if (!blip || !blip.$ || typeof blip.$['r:embed'] !== 'string') {
      return '';
    }
    return blip.$['r:embed'];
  }

  resolveRelationshipTarget(slideFile, target) {
    if (!target || typeof target !== 'string') {
      return null;
    }
    const normalizedTarget = target.replace(/\\/g, '/').replace(/^\/+/, '');
    const slideDir = path.posix.dirname(slideFile);
    return path.posix.normalize(path.posix.join(slideDir, normalizedTarget));
  }

  async getOrCreateImageReference(slideFile, rId, imageOrder) {
    const rels = await this.getSlideRels(slideFile);
    if (!rels || !rels[rId] || !rels[rId].Target) {
      return null;
    }
    const imagePath = this.resolveRelationshipTarget(slideFile, rels[rId].Target);
    if (!imagePath || !imagePath.startsWith('ppt/media/')) {
      return null;
    }
    if (this.imageReferenceMap.has(imagePath)) {
      return this.imageReferenceMap.get(imagePath);
    }
    const imageExtension = path.posix.extname(imagePath).toLowerCase();
    if (!IMAGE_MIME_BY_EXTENSION[imageExtension]) {
      return null;
    }
    const imageFile = this.zip.file(imagePath);
    if (!imageFile) {
      return null;
    }
    const imageBuffer = await imageFile.async('nodebuffer');
    const slideNumber = this.getSlideNumber(slideFile) || 1;
    const fileReference = `files/pptx-media/slide-${slideNumber}-image-${imageOrder}${imageExtension}`;
    this.extractedFiles[fileReference] = {
      buffer: imageBuffer,
      mimeType: this.getImageMimeType(imageExtension),
      originalPath: imagePath,
    };
    this.imageReferenceMap.set(imagePath, fileReference);
    return fileReference;
  }

  async getSlideRels(slideFile) {
    try {
      const slideNumber = this.getSlideNumber(slideFile);
      if (!slideNumber) {
        return {};
      }
      const relsFile = this.zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`);
      if (!relsFile) {
        return {};
      }
      const relsContent = await relsFile.async('string');//gets content from  slide and hands it back as a string
      const relsXml = await parseStringPromise(relsContent);//takes a raw xml string and converts it into plain js object tree so the rest of the code can navigate the XML with normal property access instead of string parsing tags by hand.
      const relationshipNodes = relsXml && relsXml.Relationships
        ? relsXml.Relationships.Relationship
        : [];
      const relationships = this.asArray(relationshipNodes);
      const rels = {};
      for (const rel of relationships) {
        if (!rel || !rel.$ || !rel.$.Id || !rel.$.Target) {
          continue;
        }
        rels[rel.$.Id] = {
          Id: rel.$.Id,
          Target: rel.$.Target,
          Type: rel.$.Type, //the real Type field lets callers check the relationship's actual declared kind
        };
      }
      return rels;
    } catch (error) {
      console.error('Error getting slide relationships:', error);
      return {};
    }
  }

  // relationships are not slide to slide - the only place which file holds a
  // slide's notes is recorded is inside that slide's own .rels. reuses
  // resolveRelationshipTarget() rather than duplicating path-resolution logic.
  async getNotesSlidePath(slideFile) {
    const rels = await this.getSlideRels(slideFile);
    for (const id in rels) {
      const rel = rels[id];
      if (rel.Type && rel.Type.endsWith('/notesSlide')) {
        return this.resolveRelationshipTarget(slideFile, rel.Target);
      }
    }
    return null;
  }

  // opens the specific notes-slide zip entry, parses it, and reuses the
  // already-existing getShapeText() unmodified because a notes slide's text
  // structure mirrors a regular slide's
  async getSlideNotesText(slideFile) {
    const notesPath = await this.getNotesSlidePath(slideFile);
    if (!notesPath) {
      return '';
    }
    const notesFile = this.zip.file(notesPath);
    if (!notesFile) {
      return '';
    }

    const notesContent = await notesFile.async('string');//convert notesContent into string
    const notesXml = await parseStringPromise(notesContent);// parse contents into XML format
    const notes = notesXml['p:notes'];
    const cSld = notes ? this.asArray(notes['p:cSld'])[0] : null;
    const spTree = cSld ? this.asArray(cSld['p:spTree'])[0] : null;
    if (!spTree) {
      return '';
    }
    const shapes = this.asArray(spTree['p:sp']);
    const lines = [];
    for (const shape of shapes) {
      const text = this.getShapeText(shape);
      if (text) {
        lines.push(text);
      }
    }
    return lines.join('\n').trim();
  }

  getExtractedFiles() {
    return this.extractedFiles;
  }

  // produces the structured per-slide manifest (title/html/notes/image) for
  // deck.json, alongside the existing HTML-document export below. image stays
  // null here on purpose - snapshot/pre-render is a separate, optional step.
  async toDeckManifest(options = {}) {
    await this.initialize();
    const slides = await this.parseSlides();
    const manifestSlides = [];
    for (const slide of slides) {
      const { textBlocks, titleIndex } = this.extractTextBlocks(slide);
      const slideNumber = this.getSlideNumber(slide.file);
      const title = titleIndex > -1
        ? textBlocks[titleIndex].text.replace(/\s+/g, ' ').trim()
        : `Slide ${slideNumber || 1}`;
      const html = await this.convertSlideToHTML(slide, options);
      const notes = await this.getSlideNotesText(slide.file);
      manifestSlides.push({ number: slideNumber || 1, title, html, image: null, notes });
    }
    return { slides: manifestSlides };
  }

  async toHTML(options = { includeStyles: true, inlineImages: false, fullDocument: true }) {
    try {
      await this.initialize();
      const slides = await this.parseSlides();
      const html = await this.generateHTML(slides, options);
      return html;
    } catch (error) {
      console.error('Error converting to HTML:', error);
      throw error;
    }
  }

  async generateHTML(slides, options = { includeStyles: true, inlineImages: false, fullDocument: true }) {
    const renderOptions = {
      includeStyles: typeof options.includeStyles === 'boolean' ? options.includeStyles : true,
      inlineImages: typeof options.inlineImages === 'boolean' ? options.inlineImages : false,
      fullDocument: typeof options.fullDocument === 'boolean' ? options.fullDocument : true,
    };
    let slidesHTML = '';
    for (const slide of slides) {
      const slideHTML = await this.convertSlideToHTML(slide, renderOptions);
      slidesHTML += slideHTML;
    }
    if (!renderOptions.fullDocument) {
      return slidesHTML;
    }

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${renderOptions.includeStyles ? this.generateStyles() : ''}
</head>
<body>${slidesHTML}</body>
</html>`;
  }

  generateStyles() {
    return `
      <style>
        .slide {
          margin-bottom: 20px;
          padding: 16px;
          border: 1px solid #dddddd;
          border-radius: 8px;
          background: white;
        }
        .slide h1 {
          margin: 0 0 16px;
        }
        .slide p {
          margin: 0 0 10px;
        }
        .slide img {
          display: block;
          max-width: 100%;
          height: auto;
          margin: 8px 0;
        }
      </style>
    `;
  }
}
