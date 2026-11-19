const fs = require("fs-extra");
const { importHtmlToItems } = require("../../../siteRoutes/v1/importUtils.js");
const { convertOdtBufferToHtml } = require("../../../lib/odtToHtml.js");
// Security (SEC-ROUTE): client-safe exception text (no paths / stack internals)
const { clientSafeErrorDetail } = require("../../../lib/clientErrorMessage.js");

function fail(res, error, filename) {
  return res.status(400).json({
    status: 400,
    data: { error: error, items: [], filename: filename },
  });
}

/**
 * POST /system/api/v1/actions/import-odt
 * Convert an uploaded OpenDocument Text (.odt) file into a HAXcms site
 * schema (items array).
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Also accepts form fields: method (site|branch|page), type (course|portfolio|''), parentId.
 * Returns { status: 200, data: { items: [...], filename: string } }.
 */
async function importOdt(req, res) {
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
    // the converter writes only its own escaped tags (like the PDF
    // importer), so its inline data URI images survive to createNode,
    // which materializes them and sanitizes before storing
    const html = await convertOdtBufferToHtml(buffer);
    const items = await importHtmlToItems(html, {
      titleValue: filename.replace(/\.odt$/i, ""),
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
    console.error("odtToSite: Error processing file:", error.message);
    return fail(
      res,
      `Error processing ODT import: ${clientSafeErrorDetail(error)}`,
      filename,
    );
  }
}

module.exports = { importOdt };
