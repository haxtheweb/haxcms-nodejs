const XLSX = require('xlsx');
const fs = require('fs-extra');

function parseMultipartData(buffer, boundary) {
  const data = buffer.toString('binary');
  const parts = data.split('--' + boundary);
  const result = {
    fields: {},
    file: null,
  };
  for (const part of parts) {
    if (!part || part === '--' || part === '--\r\n' || part === '\r\n') {
      continue;
    }
    const headerEndIndex = part.indexOf('\r\n\r\n');
    if (headerEndIndex === -1) {
      continue;
    }
    const headerText = part.substring(0, headerEndIndex);
    if (!headerText.includes('Content-Disposition: form-data')) {
      continue;
    }
    const nameMatch = headerText.match(/name=\"([^\"]+)\"/);
    if (!nameMatch || !nameMatch[1]) {
      continue;
    }
    let partData = part.substring(headerEndIndex + 4);
    partData = partData.replace(/\r\n$/, '');
    const filenameMatch = headerText.match(/filename=\"([^\"]+)\"/);
    if (filenameMatch && filenameMatch[1]) {
      const mimeTypeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
      result.file = {
        fieldName: nameMatch[1],
        filename: filenameMatch[1],
        mimeType: mimeTypeMatch && mimeTypeMatch[1] ? mimeTypeMatch[1].trim() : null,
        data: Buffer.from(partData, 'binary'),
      };
    } else {
      result.fields[nameMatch[1]] = partData;
    }
  }
  return result;
}

function escapeCsvValue(value) {
  const stringValue = value === null || value === undefined ? '' : String(value);
  const requiresQuotes =
    stringValue.includes(',') ||
    stringValue.includes('"') ||
    stringValue.includes('\n') ||
    stringValue.includes('\r');
  if (requiresQuotes) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function worksheetToCsv(worksheet, includeHeaders) {
  const ref = worksheet['!ref'];
  if (!ref) {
    return '';
  }
  const range = XLSX.utils.decode_range(ref);
  const rows = [];
  for (let rowNumber = range.s.r; rowNumber <= range.e.r; rowNumber++) {
    const serializedRow = [];
    let hasValues = false;
    for (let columnNumber = range.s.c; columnNumber <= range.e.c; columnNumber++) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowNumber, c: columnNumber })];
      let cellText = '';
      if (cell) {
        cellText = cell.w != null ? cell.w : String(cell.v == null ? '' : cell.v);
      }
      const normalizedValue =
        cellText === null || cellText === undefined ? '' : String(cellText);
      if (normalizedValue.trim() !== '') {
        hasValues = true;
      }
      serializedRow.push(escapeCsvValue(normalizedValue));
    }
    if (hasValues) {
      rows.push(serializedRow.join(','));
    }
  }
  if (!includeHeaders && rows.length > 0) {
    rows.shift();
  }
  return rows.join('\n');
}

/**
 * POST /system/api/v1/actions/xlsx-to-csv
 * Convert an uploaded Excel file to CSV.
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Returns { status: 200, data: { contents: csv, filename: string, sheetNames: [], selectedSheet: string } }.
 */
async function convertXlsxToCsv(req, res) {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        data: { error: 'No file uploaded', contents: '', filename: null },
      });
    }

    const file = req.files[0];
    const originalname = file.originalname;
    if (!/\.(xlsx|xls)$/i.test(originalname)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .xlsx or .xls, got: ${originalname}`,
          contents: '',
          filename: originalname,
        },
      });
    }

    if (originalname.toLowerCase().endsWith('.xls')) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Legacy .xls files are not supported. Please save as .xlsx and retry.',
          contents: '',
          filename: originalname,
        },
      });
    }

    let buffer;
    try {
      buffer = fs.readFileSync(file.path);
    } catch (e) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Unable to read uploaded file: ${e.message}`,
          contents: '',
          filename: originalname,
        },
      });
    }
    if (buffer.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Empty file uploaded',
          contents: '',
          filename: originalname,
        },
      });
    }

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetNames = workbook.SheetNames;
    const sheetName = req.query && req.query.sheet ? req.query.sheet : null;
    let selectedSheetName = sheetName;
    if (!selectedSheetName || !sheetNames.includes(selectedSheetName)) {
      selectedSheetName = sheetNames[0];
    }
    if (!selectedSheetName) {
      return res.status(400).json({
        status: 400,
        data: { error: 'No sheets found in Excel file', contents: '', filename: originalname },
      });
    }
    const worksheet = workbook.Sheets[selectedSheetName];
    if (!worksheet) {
      return res.status(400).json({
        status: 400,
        data: { error: `Unable to access worksheet: ${selectedSheetName}`, contents: '', filename: originalname },
      });
    }
    const includeHeaders = req.query && req.query.headers !== 'false';
    const csvData = worksheetToCsv(worksheet, includeHeaders);

    return res.json({
      status: 200,
      data: {
        contents: csvData,
        filename: originalname,
        originalFilename: originalname,
        sheetNames: sheetNames,
        selectedSheet: selectedSheetName,
        format: 'csv',
      },
    });
  } catch (error) {
    console.error('xlsxToCsv route error:', error.message);
    return res.status(400).json({
      status: 400,
      data: { error: `Excel to CSV conversion failed: ${error.message}`, contents: '', filename: null },
    });
  }
}

module.exports = { convertXlsxToCsv };
