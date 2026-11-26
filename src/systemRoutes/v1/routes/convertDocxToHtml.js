const { convertToHtml } = require("mammoth");
const { boundZipBuffer } = require("../../../lib/boundedZip.js");
const {
  stripMSWord,
  processDocxHtml,
} = require("../../../lib/convertUtils.js");
// Security (SEC-ROUTE): client-safe exception text (no paths / stack internals)
const { clientSafeErrorDetail } = require("../../../lib/clientErrorMessage.js");
const { HAXCMS } = require("../../../lib/HAXCMS.js");
const {
  materializeInlineImages,
} = require("../../../lib/materializeInlineImages.js");

/**
 * The page the document is going into, when the request names one: both
 * `siteName` and `itemId` form fields, a site that loads and an item in its
 * outline (haxtheweb/issues#3058). Anything else is no page, and the
 * conversion answers as it always has.
 */
async function pageContextFromRequest(req) {
  const body = req.body || {};
  const siteName = typeof body.siteName === "string" ? body.siteName : "";
  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  if (siteName === "" || itemId === "") {
    return null;
  }
  try {
    const site = await HAXCMS.loadSite(siteName);
    const item = site ? site.loadNode(itemId) : false;
    return item ? { site: site, item: item } : null;
  } catch {
    return null;
  }
}

/**
 * POST /system/api/v1/actions/docx-to-html
 * Convert an uploaded .docx file to clean HTML.
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Optional `siteName` and `itemId` fields name the page the document goes
 * into: when both resolve, images in the document are saved as files of that
 * site, named after the page (as creating a page from a document does), and
 * the HTML points at them. Without them images stay inline data URIs.
 * Returns { status: 200, data: { contents: html, filename: string } }.
 */
async function convertDocxToHtml(req, res) {
  let originalname = null;
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        data: { error: "No file uploaded", contents: "", filename: null },
      });
    }

    const file = req.files[0];
    originalname = file.originalname;
    if (!/\.docx$/i.test(originalname)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .docx, got: ${originalname}`,
          contents: "",
          filename: originalname,
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
        },
      });
    }

    // Validate ZIP magic number (DOCX files are ZIP archives)
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
            "Uploaded file is not a valid .docx file (missing ZIP signature). If this is a .doc file, convert it to .docx first.",
          contents: "",
          filename: originalname,
        },
      });
    }

    const mammothOptions = {
      styleMap: ["u => em", "strike => del"],
    };

    let html = "";
    try {
      const result = await convertToHtml(
        { buffer: await boundZipBuffer(buffer, "docx") },
        mammothOptions,
      );
      html = result.value;
      html = processDocxHtml(html);
      html = stripMSWord(html);
      // only a document with inline images needs the page (materialize
      // replaces just img elements whose src is a data: URI)
      if (/data:/i.test(html)) {
        const page = await pageContextFromRequest(req);
        if (page) {
          // a save that fails leaves the images inline, as with no page;
          // the conversion still answers
          try {
            const materialized = await materializeInlineImages(
              html,
              page.site,
              { pageTitle: page.item.title },
            );
            html = materialized.html;
          } catch (e) {
            console.error(
              "docxToHtml: inline images left inline:",
              clientSafeErrorDetail(e),
            );
          }
        }
      }
    } catch (e) {
      html = `Error converting document: ${clientSafeErrorDetail(e)}`;
    }

    return res.json({
      status: 200,
      data: {
        contents: html,
        filename: originalname,
      },
    });
  } catch (error) {
    console.error("docxToHtml: Error processing file:", error.message);
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing Word document: ${clientSafeErrorDetail(error)}`,
        contents: "",
        filename: originalname,
      },
    });
  }
}

module.exports = { convertDocxToHtml };
