const XLSX = require('xlsx')
const JSONOutlineSchemaItem = require('../../../lib/JSONOutlineSchemaItem.js')

/**
 * POST /system/api/v1/actions/import-xlsx
 * Convert an uploaded .xlsx or .xls file into a HAXcms site schema (items array).
 *
 * Expects multipart/form-data with a file field (any field name is accepted).
 * Also accepts form fields: method (site|branch|page), type (course|portfolio|''), parentId.
 * Returns { status: 200, data: { items: [...], filename: string, selectedSheet: string } }.
 */
async function importXlsx(req, res) {
  let filename = null
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'No file uploaded',
          items: [],
          filename: null,
        },
      })
    }

    const file = req.files[0]
    filename = file.originalname
    if (!/\.(xlsx|xls)$/i.test(filename)) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Invalid file type. Expected .xlsx or .xls, got: ${filename}`,
          items: [],
          filename: filename,
        },
      })
    }

    const fs = require('fs-extra')
    let buffer
    try {
      buffer = fs.readFileSync(file.path)
    } catch (e) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Unable to read uploaded file: ${e.message}`,
          items: [],
          filename: filename,
        },
      })
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'Uploaded file is empty',
          items: [],
          filename: filename,
        },
      })
    }

    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellText: true })
    if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
      return res.status(400).json({
        status: 400,
        data: {
          error: 'No sheets found in Excel file',
          items: [],
          filename: filename,
        },
      })
    }
    const selectedSheet = workbook.SheetNames[0]
    const worksheet = workbook.Sheets[selectedSheet]
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '', blankrows: false })
    const items = rowsToSiteItems(rows, filename)
    return res.json({
      status: 200,
      data: {
        items: items,
        filename: filename,
        selectedSheet: selectedSheet,
      },
    })
  } catch (error) {
    console.error('xlsxToSite: Error processing file:', error.message)
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing Excel import: ${error.message}`,
        items: [],
        filename: filename,
      },
    })
  }
}

function rowsToSiteItems(rows, filename) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Spreadsheet is empty')
  }
  let headerRowIndex = -1
  for (let i = 0; i < rows.length; i++) {
    if (rowHasData(rows[i])) {
      headerRowIndex = i
      break
    }
  }
  if (headerRowIndex === -1) {
    throw new Error('Spreadsheet has no header row')
  }
  const headerLookup = getHeaderLookup(rows[headerRowIndex])
  const records = []
  const slugMap = {}
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!rowHasData(row)) {
      continue
    }
    const rowNumber = i + 1
    const title = valueToString(row[headerLookup.title]).trim()
    const rawSlug = valueToString(row[headerLookup.slug]).trim()
    const rawParent = valueToString(row[headerLookup.parent]).trim()
    const rawContent = valueToString(row[headerLookup.content])
    if (title === '') {
      throw new Error(`Row ${rowNumber}: title is required`)
    }
    if (rawSlug === '') {
      throw new Error(`Row ${rowNumber}: slug is required`)
    }
    const slug = normalizeSlug(rawSlug)
    if (slug === '') {
      throw new Error(`Row ${rowNumber}: slug is required`)
    }
    const slugKey = slug.toLowerCase()
    if (slugMap[slugKey]) {
      throw new Error(`Row ${rowNumber}: duplicate slug "${slug}" (already used on row ${slugMap[slugKey].rowNumber})`)
    }
    const parentSlug = normalizeSlug(rawParent)
    const parentSlugKey = parentSlug === '' ? '' : parentSlug.toLowerCase()
    const item = new JSONOutlineSchemaItem()
    item.title = title
    item.slug = slug
    item.order = records.length
    item.contents = rawContent
    records.push(item)
    slugMap[slugKey] = { item: item, rowNumber: rowNumber, parentSlugKey: parentSlugKey }
  }
  // Resolve parent references
  for (const slugKey in slugMap) {
    const entry = slugMap[slugKey]
    if (entry.parentSlugKey !== '') {
      if (slugMap[entry.parentSlugKey]) {
        entry.item.parent = slugMap[entry.parentSlugKey].item.id
        entry.item.indent = 1
      }
    }
  }
  return records
}

function rowHasData(row) {
  if (!Array.isArray(row)) {
    return false
  }
  for (const cell of row) {
    const value = valueToString(cell).trim()
    if (value !== '') {
      return true
    }
  }
  return false
}

function getHeaderLookup(headerRow) {
  const lookup = { title: -1, slug: -1, parent: -1, content: -1 }
  if (!Array.isArray(headerRow)) {
    return lookup
  }
  for (let i = 0; i < headerRow.length; i++) {
    const normalized = String(headerRow[i] || '').trim().toLowerCase().replace(/\s+/g, '')
    if (normalized === 'title') {
      lookup.title = i
    } else if (normalized === 'slug') {
      lookup.slug = i
    } else if (normalized === 'parent') {
      lookup.parent = i
    } else if (normalized === 'content') {
      lookup.content = i
    }
  }
  return lookup
}

function valueToString(value) {
  if (value === null || value === undefined) {
    return ''
  }
  return String(value)
}

function normalizeSlug(rawSlug) {
  if (!rawSlug || typeof rawSlug !== 'string') {
    return ''
  }
  return rawSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
}

module.exports = { importXlsx }
