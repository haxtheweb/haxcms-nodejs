const { convertPptxBufferToHtml } = require("../../../lib/pptxToHtml.js");
// Security (SEC-ROUTE): client-safe exception text (no paths / stack internals)
const { clientSafeErrorDetail } = require("../../../lib/clientErrorMessage.js");
/**
 * POST /system/api/v1/actions/pptx-to-html
 * Convert an uploaded PPTX file to HTML.
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Returns { status: 200, data: { contents: html, filename: string, files?: object } }.
 */
async function convertPptxToHtml(req, res) {
  let originalname = null;
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: "No file uploaded",
          contents: "",
          filename: null,
          files: {},
        },
      });
    }

    const file = req.files[0];
    originalname = file.originalname;
    if (!/\.pptx$/i.test(originalname)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .pptx, got: ${originalname}`,
          contents: "",
          filename: originalname,
          files: {},
        },
      });
    }

    const fs = require("fs-extra");
    let buffer;
    try {
      buffer = fs.readFileSync(file.path);
    } catch (e) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Unable to read uploaded file: ${clientSafeErrorDetail(e)}`,
          contents: "",
          filename: originalname,
          files: {},
        },
      });
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: "Uploaded file is empty",
          contents: "",
          filename: originalname,
          files: {},
        },
      });
    }

    // Validate ZIP magic number (PPTX files are ZIP archives)
    if (
      buffer.length < 4 ||
      buffer[0] !== 0x50 ||
      buffer[1] !== 0x4b ||
      buffer[2] !== 0x03 ||
      buffer[3] !== 0x04
    ) {
      return res.status(400).json({
        status: 400,
        data: {
          error:
            "Uploaded file is not a valid .pptx file (missing ZIP signature).",
          contents: "",
          filename: originalname,
          files: {},
        },
      });
    }

    // one <h1> per slide then its content, pictures as data URIs that
    // createNode / addPage turn into files (the .odp importer's shape)
    const html = await convertPptxBufferToHtml(buffer);
    // pictures are inline in contents now; kept so the response keeps its shape
    const files = {};

    return res.json({
      status: 200,
      data: {
        contents: html,
        filename: originalname,
        files: files,
      },
    });
  } catch (error) {
    console.error("pptxToHtml: Error processing file:", error.message);
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing PPTX: ${clientSafeErrorDetail(error)}`,
        contents: "",
        filename: originalname,
        files: {},
      },
    });
  }
}

module.exports = { convertPptxToHtml };
