const path = require('path');
const fs = require('fs-extra');
const { HAXCMS } = require('../../../lib/HAXCMS.js');

/**
 * POST /system/api/v1/actions/import-pptx-deck
 * Convert an uploaded .pptx into a deck.json manifest + stored media,
 * scoped to an existing site's files/decks/<name>/ directory.
 *
 * Expects multipart/form-data with a file field and a siteName form field.
 * Returns { status: 200, data: { deckPath, embedHtml, manifest } }.
 */
async function importPptxDeck(req, res) {
  let filename = null;
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ status: 400, data: { error: 'No file uploaded' } });
    }
    const file = req.files[0];
    filename = file.originalname;
    if (!/\.pptx$/i.test(filename)) {
      return res.status(400).json({ status: 400, data: { error: `Invalid file type. Expected .pptx, got: ${filename}` } });
    }

    let buffer;
    try {
      buffer = fs.readFileSync(file.path);
    } catch (e) {
      return res.status(400).json({ status: 400, data: { error: `Unable to read uploaded file: ${e.message}` } });
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ status: 400, data: { error: 'Uploaded file is empty' } });
    }
    // Validate ZIP magic number (PPTX files are ZIP archives). Checked before
    // any site-specific logic, matching the sibling actions/pptx-to-html and
    // actions/import-pptx routes, which validate the upload itself first.
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
      return res.status(400).json({ status: 400, data: { error: 'Uploaded file is not a valid .pptx file (missing ZIP signature).' } });
    }

    const siteName = req.body && req.body.siteName ? String(req.body.siteName).trim() : '';
    if (!siteName) {
      return res.status(400).json({ status: 400, data: { error: 'siteName is required' } });
    }
    // note: in single-site mode HAXCMS.loadSite() ignores the requested name
    // and always resolves to the one site this server instance is running for
    const site = await HAXCMS.loadSite(siteName);
    if (!site || !site.siteDirectory) {
      return res.status(400).json({ status: 400, data: { error: `Site "${siteName}" not found` } });
    }

    const { PPTXInHTMLOut } = await import('../../../lib/vendor/pptx-in-html-out/src/index.js');
    const converter = new PPTXInHTMLOut(buffer);
    const manifest = await converter.toDeckManifest({ includeStyles: false, inlineImages: false });
    const extractedFiles = converter.getExtractedFiles() || {};

    // sanitize the deck folder name - strip the extension, then drop anything
    // that isn't alphanumeric/hyphen/underscore so it's safe as a path segment
    const deckName = filename.replace(/\.pptx$/i, '').replace(/[^a-zA-Z0-9-_]/g, '-');
    if (!deckName) {
      return res.status(400).json({ status: 400, data: { error: 'Unable to derive a deck name from the uploaded filename' } });
    }
    const deckDir = path.join(site.siteDirectory, 'files', 'decks', deckName);
    fs.mkdirSync(deckDir, { recursive: true });

    fs.writeFileSync(path.join(deckDir, 'original.pptx'), buffer);
    for (const fileReference in extractedFiles) {
      const extracted = extractedFiles[fileReference];
      const destName = path.basename(fileReference);
      fs.writeFileSync(path.join(deckDir, destName), extracted.buffer);
    }

    // convertSlideToHTML() (via getOrCreateImageReference) embeds image src
    // paths as "files/pptx-media/<name>" - a fixed, deck-agnostic location.
    // Actual files are written above into this deck's own folder instead
    // (avoids collisions between separate deck imports on the same site), so
    // slide HTML must be rewritten to match where the files actually landed.
    const deckSlides = manifest.slides.map((slide) => ({
      ...slide,
      html: typeof slide.html === 'string'
        ? slide.html.replace(/files\/pptx-media\//g, `files/decks/${deckName}/`)
        : slide.html,
    }));

    const deckManifest = {
      title: deckName,
      source: filename,
      pptx: `files/decks/${deckName}/original.pptx`,
      thumbnail: null,
      renderTier: 'client',
      slides: deckSlides,
    };
    fs.writeFileSync(path.join(deckDir, 'deck.json'), JSON.stringify(deckManifest, null, 2));

    return res.json({
      status: 200,
      data: {
        deckPath: `files/decks/${deckName}/deck.json`,
        embedHtml: `<slide-deck source="files/decks/${deckName}/deck.json"></slide-deck>`,
        manifest: deckManifest,
      },
    });
  } catch (error) {
    console.error('importPptxDeck: Error processing file:', error.message);
    return res.status(400).json({ status: 400, data: { error: `Error processing PPTX: ${error.message}` } });
  }
}

module.exports = { importPptxDeck };
