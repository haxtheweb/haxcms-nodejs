const zlib = require("node:zlib");
const { promisify } = require("node:util");
const JSZip = require("jszip");

const inflateRaw = promisify(zlib.inflateRaw);

// Security (SEC-DOS, SEC-UPLOAD): an uploaded zip (docx, xlsx, ods, odt, odp,
// pptx) is inflated here, entry by entry, under real byte limits before any
// parser sees it. The sizes a zip's directory declares are written by the
// uploader, so they only ever lower a limit: each entry is inflated with
// zlib's maxOutputLength, so a lying header stops at its claim and an honest
// huge one is refused before it is inflated. Parsers then get a stored
// (uncompressed) copy whose sizes are true, so nothing downstream can expand
// past these limits (zip bomb).
const MAX_ZIP_ENTRIES = 10000;
const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;
// Office XML compresses roughly 5-30x and media barely at all; a zip that
// claims more than this much content per compressed byte is a bomb, not a
// document. The floor keeps small, highly compressible documents working.
const MAX_ZIP_RATIO = 100;
const MIN_ZIP_BUDGET_BYTES = 32 * 1024 * 1024;

const DEFLATE = "\x08\x00";
const STORE = "\x00\x00";

function zipBudgetError(ext) {
  const err = new Error(
    `The .${ext} file expands to more content than can be imported.`,
  );
  err.status = 400;
  err.code = "ZIP_BUDGET";
  return err;
}

function zipInvalidError(ext) {
  const err = new Error(`Uploaded file is not a valid .${ext} file.`);
  err.status = 400;
  return err;
}

/**
 * True when a buffer starts with the ZIP local file header signature.
 * @param {Buffer} buffer
 */
function hasZipSignature(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

/**
 * Inflate a zip upload under the limits above and return a stored copy of it.
 * @param {Buffer} buffer the uploaded file
 * @param {string} ext file type for messages ("docx", "odt", ...)
 * @returns {Promise<Buffer>} the same entries, stored, with true sizes
 */
async function boundZipBuffer(buffer, ext = "zip") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw zipInvalidError(ext);
  }
  let zip;
  try {
    // reads the central directory only; nothing is inflated here
    zip = await JSZip.loadAsync(buffer, { createFolders: false });
  } catch {
    throw zipInvalidError(ext);
  }
  const budget = Math.min(
    MAX_ZIP_TOTAL_BYTES,
    Math.max(MIN_ZIP_BUDGET_BYTES, buffer.length * MAX_ZIP_RATIO),
  );
  const entries = [];
  let declaredTotal = 0;
  zip.forEach((path, entry) => {
    entries.push({ path, entry });
  });
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw zipBudgetError(ext);
  }
  for (const { entry } of entries) {
    if (entry.dir) {
      continue;
    }
    const data = entry._data;
    if (
      !data ||
      typeof data.uncompressedSize !== "number" ||
      data.uncompressedSize < 0 ||
      !data.compressedContent
    ) {
      throw zipInvalidError(ext);
    }
    declaredTotal += data.uncompressedSize;
    if (declaredTotal > budget) {
      throw zipBudgetError(ext);
    }
  }
  const out = new JSZip();
  let inflatedTotal = 0;
  for (const { path, entry } of entries) {
    if (entry.dir) {
      out.folder(path);
      continue;
    }
    const data = entry._data;
    const magic = data.compression && data.compression.magic;
    const compressed = Buffer.from(data.compressedContent);
    let content;
    if (magic === STORE) {
      content = compressed;
    } else if (magic === DEFLATE) {
      try {
        // never produce more than the entry claims (plus one byte, so a
        // longer stream is seen as a mismatch rather than cut silently)
        content = await inflateRaw(compressed, {
          maxOutputLength: Math.max(1, data.uncompressedSize + 1),
        });
      } catch (e) {
        if (e && e.code === "ERR_BUFFER_TOO_LARGE") {
          throw zipBudgetError(ext);
        }
        throw zipInvalidError(ext);
      }
    } else {
      throw zipInvalidError(ext);
    }
    if (content.length !== data.uncompressedSize) {
      throw zipInvalidError(ext);
    }
    inflatedTotal += content.length;
    if (inflatedTotal > budget) {
      throw zipBudgetError(ext);
    }
    out.file(path, content, {
      compression: "STORE",
      date: entry.date,
      createFolders: false,
    });
  }
  return out.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

module.exports = {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_TOTAL_BYTES,
  MAX_ZIP_RATIO,
  MIN_ZIP_BUDGET_BYTES,
  boundZipBuffer,
  hasZipSignature,
};
