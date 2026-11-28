// Security (SEC-UPLOAD, SEC-DOS): an uploaded spreadsheet is read only as the
// format its extension names (xlsx, xls, ods), and only when its bytes start
// the way that format does. SheetJS's XLSX.read() otherwise guesses the
// format from the content and would read HTML, CSV, SYLK or XML Spreadsheet
// uploads this route never meant to offer, and a non-zip upload would skip
// the zip limits. The zip formats are inflated under boundedZip's limits
// before SheetJS sees them, and the workbook SheetJS reports must be the
// named format. Same rule as haxcms-php lib/SpreadsheetUpload.php.
const XLSX = require("./vendor/xlsx/xlsx.js");
const { boundZipBuffer, hasZipSignature } = require("./boundedZip.js");

const FORMATS = ["xlsx", "xls", "ods"];
// OLE2 compound document header (legacy .xls)
const OLE_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

// lowercased extension of filename when it is one of allowed, else ""
function spreadsheetExtension(filename, allowed = FORMATS) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(filename || ""));
  if (!match) {
    return "";
  }
  const ext = match[1].toLowerCase();
  return FORMATS.includes(ext) && allowed.includes(ext) ? ext : "";
}

function hasSpreadsheetSignature(buffer, ext) {
  if (ext === "xlsx" || ext === "ods") {
    return hasZipSignature(buffer);
  }
  if (ext === "xls") {
    return (
      Buffer.isBuffer(buffer) &&
      buffer.length >= OLE_SIGNATURE.length &&
      buffer.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)
    );
  }
  return false;
}

// a 400 whose message is safe to show the uploader (clientSafeErrorDetail
// passes messages of errors that carry a status through unchanged)
function notThatFormat(ext) {
  const error = new Error(
    ext
      ? `Uploaded file is not a valid .${ext} file`
      : "Unsupported spreadsheet type",
  );
  error.status = 400;
  return error;
}

async function readSpreadsheet(buffer, ext, options = {}) {
  if (!FORMATS.includes(ext)) {
    throw notThatFormat("");
  }
  if (!hasSpreadsheetSignature(buffer, ext)) {
    throw notThatFormat(ext);
  }
  const input =
    ext === "xlsx" || ext === "ods"
      ? await boundZipBuffer(buffer, ext)
      : buffer;
  const workbook = XLSX.read(input, { ...options, type: "buffer" });
  // SheetJS names the zip format it parsed; an .ods that is really an .xlsx
  // (or the reverse) is refused, as PhpSpreadsheet's pinned reader does
  if (
    (ext === "xlsx" || ext === "ods") &&
    (!workbook || workbook.bookType !== ext)
  ) {
    throw notThatFormat(ext);
  }
  return workbook;
}

module.exports = {
  spreadsheetExtension,
  hasSpreadsheetSignature,
  readSpreadsheet,
};
