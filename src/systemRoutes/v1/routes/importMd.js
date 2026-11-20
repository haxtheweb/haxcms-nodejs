const fs = require("fs-extra");
const { importHtmlToItems } = require("../../../siteRoutes/v1/importUtils.js");
const { sanitizeUntrustedHtml } = require("../../../lib/convertUtils.js");
const {
  decodeTextBuffer,
  splitFrontMatter,
  renderMarkdown,
} = require("../../../lib/markdownImport.js");
// Security (SEC-ROUTE): client-safe exception text (no paths / stack internals)
const { clientSafeErrorDetail } = require("../../../lib/clientErrorMessage.js");

const TEXT_FILE_PATTERN = /\.(md|markdown|txt)$/i;

function fail(res, error, filename) {
  return res.status(400).json({
    status: 400,
    data: { error: error, items: [], filename: filename },
  });
}

/**
 * POST /system/api/v1/actions/import-md
 * Convert an uploaded Markdown (.md, .markdown) or plain text (.txt) file
 * into a HAXcms site schema (items array). Plain text is read as Markdown,
 * so `#` headings in a .txt become pages too.
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Also accepts form fields: method (site|branch|page), type (course|portfolio|''), parentId.
 * Returns { status: 200, data: { items: [...], filename: string } }.
 */
async function importMd(req, res) {
  let filename = null;
  try {
    if (!req.files || req.files.length === 0) {
      return fail(res, "No file uploaded", null);
    }
    const file = req.files[0];
    filename = file.originalname;
    if (!TEXT_FILE_PATTERN.test(filename)) {
      return fail(
        res,
        `Invalid file type. Expected .md, .markdown or .txt, got: ${filename}`,
        filename,
      );
    }
    let buffer;
    try {
      buffer = fs.readFileSync(file.path);
    } catch (e) {
      return fail(
        res,
        `Unable to read uploaded file: ${clientSafeErrorDetail(e)}`,
        filename,
      );
    }
    if (!buffer || buffer.length === 0) {
      return fail(res, "Uploaded file is empty", filename);
    }
    // a NUL byte means binary data, not a text document
    if (buffer.indexOf(0) !== -1) {
      return fail(res, "Uploaded file is not a valid text file.", filename);
    }
    const { title, body } = splitFrontMatter(decodeTextBuffer(buffer));
    // Markdown may carry raw HTML; sanitize it like any other import
    const html = sanitizeUntrustedHtml(renderMarkdown(body));
    const items = await importHtmlToItems(html, {
      titleValue: title || filename.replace(TEXT_FILE_PATTERN, ""),
      method: req.body && req.body.method ? req.body.method : "site",
      type: req.body && req.body.type ? req.body.type : "",
      parentId:
        req.body && req.body.parentId && req.body.parentId !== "null"
          ? req.body.parentId
          : null,
    });
    return res.json({
      status: 200,
      data: { items: items, filename: filename },
    });
  } catch (error) {
    console.error("mdToSite: Error processing file:", error.message);
    return fail(
      res,
      `Error processing Markdown import: ${clientSafeErrorDetail(error)}`,
      filename,
    );
  }
}

module.exports = { importMd, TEXT_FILE_PATTERN };
