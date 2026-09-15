const path = require('path');
const fs = require('fs-extra');
const FilesDataStore = require('./FilesDataStore.js');

/**
 * Convert an uploaded .pptx file into a deck.json manifest + stored media,
 * scoped to a site's files/decks/<name>/ directory. The .pptx stays where it
 * was uploaded in files/ — the deck folder gets only deck.json + extracted
 * media, and the manifest's `pptx` field references the original path.
 *
 * Used by the `convert-pptx-deck` file operation (PATCH /x/api/v1/files/:fileUuid).
 *
 * @param {object} site - the resolved HAXCMS site object
 * @param {string} resolvedPath - absolute path to the .pptx on disk
 * @param {string} normalizedPath - site-relative path (e.g. "files/my-deck.pptx")
 * @returns {Promise<{commitMessage: string, data: {operation: string, deckPath: string, embedHtml: string, manifest: object}}>}
 */
async function convertPptxToDeck(site, resolvedPath, normalizedPath) {
  if (!/\.pptx$/i.test(String(normalizedPath || ''))) {
    const err = new Error('File must have a .pptx extension');
    err.status = 400;
    throw err;
  }
  const buffer = fs.readFileSync(resolvedPath);
  if (!buffer || buffer.length === 0) {
    const err = new Error('PPTX file is empty');
    err.status = 400;
    throw err;
  }
  // Validate ZIP magic number (PPTX files are ZIP archives)
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    const err = new Error('File is not a valid .pptx (missing ZIP signature)');
    err.status = 400;
    throw err;
  }

  const { PPTXInHTMLOut } = await import(
    './vendor/pptx-in-html-out/src/index.js'
  );
  const converter = new PPTXInHTMLOut(buffer);
  const manifest = await converter.toDeckManifest({
    includeStyles: false,
    inlineImages: false,
  });
  const extractedFiles = converter.getExtractedFiles() || {};

  // sanitize the deck folder name from the original filename
  const baseDeckName = path
    .basename(normalizedPath)
    .replace(/\.pptx$/i, '')
    .replace(/[^a-zA-Z0-9-_]/g, '-');
  if (!baseDeckName) {
    const err = new Error('Unable to derive a deck name from the file name');
    err.status = 400;
    throw err;
  }
  // uniquify the deck folder name when a deck of the same name already
  // exists, matching the archiveSite/cloneSite pattern (-1, -2, ...)
  let deckName = baseDeckName;
  let deckCounter = 1;
  while (
    fs.existsSync(path.join(site.siteDirectory, 'files', 'decks', deckName))
  ) {
    deckName = baseDeckName + '-' + deckCounter;
    deckCounter++;
  }
  const deckDir = path.join(site.siteDirectory, 'files', 'decks', deckName);
  fs.mkdirSync(deckDir, { recursive: true });

  // write extracted media to the deck folder (converter-generated safe names)
  for (const fileReference in extractedFiles) {
    const extracted = extractedFiles[fileReference];
    const destName = path.basename(fileReference);
    fs.writeFileSync(path.join(deckDir, destName), extracted.buffer);
  }

  // rewrite slide image src from the converter's deck-agnostic default
  // (files/pptx-media/) to where the files actually landed
  const deckSlides = manifest.slides.map((slide) => ({
    ...slide,
    html:
      typeof slide.html === 'string'
        ? slide.html.replace(
            /files\/pptx-media\//g,
            'files/decks/' + deckName + '/',
          )
        : slide.html,
  }));

  // the .pptx stays where it was uploaded; the manifest references it there
  const deckManifest = {
    title: deckName,
    source: path.basename(normalizedPath),
    pptx: normalizedPath,
    slides: deckSlides,
  };
  fs.writeFileSync(
    path.join(deckDir, 'deck.json'),
    JSON.stringify(deckManifest, null, 2),
  );

  // #3043: register the new deck.json + media files in the per-site
  // files.json datastore so they are immediately discoverable via
  // /x/api/v1/files. The original .pptx record is already there from
  // the upload (unchanged).
  try {
    const dataStore = new FilesDataStore(site);
    const deckJsonPath = 'files/decks/' + deckName + '/deck.json';
const deckJsonRecord = await dataStore.buildFileRecordFromDisk(deckJsonPath);
    }
    for (const fileReference in extractedFiles) {
      const destName = path.basename(fileReference);
      const mediaPath = 'files/decks/' + deckName + '/' + destName;
      const mediaRecord = dataStore.buildFileRecordFromDisk(mediaPath);
      if (mediaRecord) {
        dataStore.upsertRecord(mediaRecord);
      }
    }
  } catch (e) {
    // best-effort index registration; never block a successful conversion
  }

  return {
    commitMessage: 'PPTX converted to deck: ' + normalizedPath,
    data: {
      operation: 'convert-pptx-deck',
      deckPath: 'files/decks/' + deckName + '/deck.json',
      embedHtml:
        '<slide-deck source="files/decks/' +
        deckName +
        '/deck.json"></slide-deck>',
      manifest: deckManifest,
    },
  };
}

module.exports = { convertPptxToDeck };
