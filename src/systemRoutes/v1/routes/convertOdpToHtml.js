const fs = require("fs-extra");
const { convertOdpBufferToHtml } = require("../../../lib/odtToHtml.js");
// Security (SEC-ROUTE): client-safe exception text (no paths / stack internals)
const { clientSafeErrorDetail } = require("../../../lib/clientErrorMessage.js");

function fail(res, error, filename) {
  return res.status(400).json({
    status: 400,
    data: { error: error, contents: "", filename: filename },
  });
}

/**
 * POST /system/api/v1/actions/odp-to-html
 * Convert an uploaded OpenDocument Presentation (.odp) file to HTML, one h1 per slide.
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Returns { status: 200, data: { contents: html, filename: string } }.
 */
async function convertOdpToHtml(req, res) {
  let filename = null;
  try {
    if (!req.files || req.files.length === 0) {
      return fail(res, "No file uploaded", null);
    }
    const file = req.files[0];
    filename = file.originalname;
    if (!/\.odp$/i.test(filename)) {
      return fail(
        res,
        `Invalid file type. Expected .odp, got: ${filename}`,
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
    const html = await convertOdpBufferToHtml(buffer);
    return res.json({
      status: 200,
      data: { contents: html, filename: filename },
    });
  } catch (error) {
    console.error("odpToHtml: Error processing file:", error.message);
    return fail(
      res,
      `Error processing ODP document: ${clientSafeErrorDetail(error)}`,
      filename,
    );
  }
}

module.exports = { convertOdpToHtml };
