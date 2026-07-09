const SITE_FILES_TO_IMPORT = [
  'theme/theme.css',
  'theme/theme.html',
  'custom/build/custom.es6.js',
]
const BOILERPLATE_CUSTOM_ES6 = '// custom comment script here'

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
  const base = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`

  let site
  try {
    const response = await fetch(`${base}/site.json`)
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

  for (let i = 0; i < site.items.length; i++) {
    const item = site.items[i]
    if (item && item.location) {
      try {
        const response = await fetch(`${base}/${item.location}`)
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
          downloads[file.url] = `${base}/${file.url}`
        }
      }
    }
  }

  for (let i = 0; i < SITE_FILES_TO_IMPORT.length; i++) {
    const filePath = SITE_FILES_TO_IMPORT[i]
    try {
      const resp = await fetch(`${base}/${filePath}`)
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
