const fs = require("fs-extra");
const { convertOdtBufferToHtml } = require("../../../lib/odtToHtml.js");
// Security (SEC-ROUTE): client-safe exception text (no paths / stack internals)
const { clientSafeErrorDetail } = require("../../../lib/clientErrorMessage.js");

function fail(res, error, filename) {
  return res.status(400).json({
    status: 400,
    data: { error: error, contents: "", filename: filename },
  });
}

/**
 * POST /system/api/v1/actions/odt-to-html
 * Convert an uploaded OpenDocument Text (.odt) file to HTML.
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Returns { status: 200, data: { contents: html, filename: string } }.
 */
async function convertOdtToHtml(req, res) {
  let filename = null;
  try {
    if (!req.files || req.files.length === 0) {
      return fail(res, "No file uploaded", null);
    }
    const file = req.files[0];
    filename = file.originalname;
    if (!/\.odt$/i.test(filename)) {
      return fail(
        res,
        `Invalid file type. Expected .odt, got: ${filename}`,
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
    const html = await convertOdtBufferToHtml(buffer);
    return res.json({
      status: 200,
      data: { contents: html, filename: filename },
    });
  } catch (error) {
    console.error("odtToHtml: Error processing file:", error.message);
    return fail(
      res,
      `Error processing ODT document: ${clientSafeErrorDetail(error)}`,
      filename,
    );
  }
}

module.exports = { convertOdtToHtml };
