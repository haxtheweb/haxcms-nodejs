const SITE_FILES_TO_IMPORT = [
  'theme/theme.css',
  'theme/theme.html',
  'custom/build/custom.es6.js',
]
const BOILERPLATE_CUSTOM_ES6 = '// custom comment script here'
const { safeFetch } = require('../../../../lib/safeFetch.js')
const { HAXCMS } = require('../../../../lib/HAXCMS.js')
const fs = require('fs-extra')
const path = require('path')

// Directory under the HAXCMS config tree where bulk-import files are staged
// before createSite's isValidBulkImportStagedPath validator accepts them.
// createSite's build.files contract is "local staged paths only" (it rejects
// URL schemes by design), so the converter downloads each referenced file
// here and hands createSite the staged path instead of the remote URL.
function getBulkImportStagingRoot() {
  const root = path.join(HAXCMS.configDirectory, 'tmp', 'imports')
  try {
    fs.ensureDirSync(root)
  } catch (e) {}
  return root
}

// Fetch a remote file via safeFetch (SSRF-guarded, no redirects) and stage it
// under the bulk-import root so createSite can move it into the site tree.
// Returns the absolute staged path, or null on any fetch/write failure or
// empty body (the file is simply skipped, matching how page fetch failures
// are handled). idx keeps staged filenames unique across the import.
async function stageRemoteFile(url, stagingRoot, idx, relPath) {
  try {
    const response = await safeFetch(url)
    if (!response || !response.ok) {
      return null
    }
    const buf = Buffer.from(await response.arrayBuffer())
    if (!buf || buf.length === 0) {
      return null
    }
    const ext = path.extname(relPath || '')
    const stagedPath = path.join(
      stagingRoot,
      'haximp-' + Date.now() + '-' + idx + '-' + Math.floor(Math.random() * 1000000) + ext
    )
    fs.writeFileSync(stagedPath, buf)
    return stagedPath
  } catch (e) {
    return null
  }
}

/**
 * POST /system/api/v1/site/import/:platform
 * Convert a remote HAXcms site into a JSON Outline Schema items array.
 *
 * Expects a JSON body with { repoUrl: string }.
 * Returns { status: 200, data: { items: [...], filename: string, files: {}, siteFiles: {} } }.
 */
async function convertHaxcmsToSite(req, res) {
  let body = {}
  if (
    req &&
    req.body &&
    typeof req.body === 'object' &&
    !Array.isArray(req.body)
  ) {
    body = req.body
  }

  if (!body || !body.repoUrl) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'missing `repoUrl` param',
        items: [],
        filename: null,
      },
    })
  }

  let url = body.repoUrl.replace('/site.json', '')
  if (url.endsWith('/')) {
    url = url.slice(0, -1)
  }

  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch (e) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'Invalid repoUrl',
        items: [],
        filename: null,
      },
    })
  }

  if (!parsedUrl.pathname || !parsedUrl.host) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'Invalid repoUrl',
        items: [],
        filename: null,
      },
    })
  }

  parsedUrl.host = parsedUrl.host.replace('iam.', 'oer.')
  const base = (`${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`).replace(/\/+$/, '')

  let site
  try {
    const response = await safeFetch(`${base}/site.json`)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    site = await response.json()
  } catch (e) {
    return res.status(400).json({
      status: 400,
      data: {
        error: `Unable to fetch site.json: ${e.message}`,
        items: [],
        filename: null,
      },
    })
  }

  if (!site || !Array.isArray(site.items)) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'Invalid site.json structure',
        items: [],
        filename: null,
      },
    })
  }

  const downloads = {}
  const siteFiles = {}
  const stagingRoot = getBulkImportStagingRoot()
  let stagingIdx = 0

  for (let i = 0; i < site.items.length; i++) {
    const item = site.items[i]
    if (item && item.location) {
      try {
        const response = await safeFetch(`${base}/${item.location}`)
        item.contents = response.ok ? await response.text() : ''
      } catch (e) {
        item.contents = ''
      }
    }
    if (
      item.metadata &&
      item.metadata.files &&
      Array.isArray(item.metadata.files)
    ) {
      for (let j = 0; j < item.metadata.files.length; j++) {
        const file = item.metadata.files[j]
        if (file && file.url) {
          const stagedPath = await stageRemoteFile(`${base}/${file.url}`, stagingRoot, stagingIdx++, file.url)
          if (stagedPath) {
            downloads[file.url] = stagedPath
          }
        }
      }
    }
  }

  for (let i = 0; i < SITE_FILES_TO_IMPORT.length; i++) {
    const filePath = SITE_FILES_TO_IMPORT[i]
    try {
      const resp = await safeFetch(`${base}/${filePath}`)
      if (resp.ok) {
        const text = await resp.text()
        if (text && text.trim() !== '') {
          if (
            filePath === 'custom/build/custom.es6.js' &&
            text.trim() === BOILERPLATE_CUSTOM_ES6
          ) {
            continue
          }
          siteFiles[filePath] = `${base}/${filePath}`
        }
      }
    } catch (e) {}
  }

  const filename =
    site.metadata &&
    site.metadata.site &&
    site.metadata.site.name
      ? site.metadata.site.name
      : parsedUrl.pathname.split('/').pop()

  return res.json({
    status: 200,
    data: {
      items: site.items,
      filename: filename,
      files: downloads,
      siteFiles: siteFiles,
    },
  })
}

module.exports = { convertHaxcmsToSite }
