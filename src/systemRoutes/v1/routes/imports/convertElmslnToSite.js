const JSONOutlineSchema = require('../../../../lib/JSONOutlineSchema.js')
const JSONOutlineSchemaItem = require('../../../../lib/JSONOutlineSchemaItem.js')

/**
 * POST /system/api/v1/actions/convert-elmsln-to-site
 * Convert an ELMSLN / HAXcms site (via remote site.json) into a HAXcms site schema.
 *
 * Expects JSON body with `repoUrl` param (URL to site root or site.json).
 * Returns { status: 200, data: { items: [...], filename: string, files: {...} } }.
 */
async function convertElmslnToSite(req, res) {
  let body = {}
  if (req && req.body && typeof req.body === 'object') {
    body = req.body
  }
  else if (req && req.body && typeof req.body === 'string') {
    try {
      body = JSON.parse(req.body.trim())
    }
    catch (e) {
      body = {}
    }
  }
  if (!body || !body.repoUrl) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'missing `repoUrl` param',
        items: [],
        filename: null,
        files: {}
      }
    })
  }

  try {
    let url = ''
    url = body.repoUrl.replace('/site.json', '')
    // handle trailing slash
    if (url.endsWith('/')) {
      url = url.slice(0, -1)
    }
    const parseURL = new URL(url)
    let siteName = url
    let downloads = {}
    let items = []
    let siteJson = null

    // verify we have a path / host
    if (parseURL.pathname && parseURL.host) {
      const base = `${parseURL.protocol}//${parseURL.host}${parseURL.pathname}`
      const siteJsonUrl = `${base}/site.json`
      const siteResponse = await fetch(siteJsonUrl)
      if (siteResponse.ok) {
        siteJson = await siteResponse.json()
      }
      else {
        return res.status(400).json({
          status: 400,
          data: {
            error: `Unable to fetch site.json from ${siteJsonUrl}`,
            items: [],
            filename: null,
            files: {}
          }
        })
      }

      // use legit prop or just pull off the url
      siteName = (siteJson && siteJson.metadata && siteJson.metadata.site && siteJson.metadata.site.name)
        ? siteJson.metadata.site.name
        : parseURL.pathname.split('/').pop()

      const site = new JSONOutlineSchema()
      site.id = siteJson.id || site.id
      site.title = siteJson.title || site.title
      site.author = siteJson.author || site.author
      site.description = siteJson.description || site.description
      site.license = siteJson.license || site.license
      site.metadata = siteJson.metadata || site.metadata

      // convert items to JSONOutlineSchemaItem objects
      if (Array.isArray(siteJson.items)) {
        for (const itemData of siteJson.items) {
          let item = new JSONOutlineSchemaItem()
          for (const key in itemData) {
            if (item.hasOwnProperty(key)) {
              item[key] = itemData[key]
            }
          }
          // ensure metadata is preserved even if not in standard properties
          if (itemData.metadata && typeof itemData.metadata === 'object') {
            item.metadata = itemData.metadata
          }
          site.items.push(item)
        }
      }

      let start = process.hrtime()
      let elapsed = 0
      const timeoutLimit = 300
      const __fetchOptions = {
        method: 'GET'
      }

      for (const item of site.items) {
        // time out check
        if (elapsed <= timeoutLimit) {
          let contentUrl = `${base}/${item.location}`
          if (item.location.indexOf(`/${siteName}/`) === 0) {
            contentUrl = `${base}/${item.location.replace(`/${siteName}/`, '')}`
          }
          const contentResponse = await fetch(contentUrl, __fetchOptions)
          if (contentResponse.ok) {
            item.contents = await contentResponse.text()
          }
          else {
            item.contents = `<p>get source from <a href="${contentUrl}" target="_blank">${contentUrl}</a></p>`
          }
        }
        else {
          let contentUrl = `${base}/${item.location}`
          if (item.location.indexOf(`/${siteName}/`) === 0) {
            contentUrl = `${base}/${item.location.replace(`/${siteName}/`, '')}`
          }
          item.contents = `<p>get source from <a href="${contentUrl}" target="_blank">${contentUrl}</a></p>`
        }
        if (item.metadata && item.metadata.files) {
          for (const file of item.metadata.files) {
            if (file && file.url) {
              downloads[file.url] = `${base}/${file.url}`
            }
          }
        }
        elapsed = process.hrtime(start)[0]
      }
      items = site.items
    }

    return res.json({
      status: 200,
      data: {
        items: items,
        filename: siteName,
        files: downloads
      }
    })
  }
  catch (error) {
    console.error('convertElmslnToSite error:', error.message)
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error converting ELMSLN: ${error.message}`,
        items: [],
        filename: null,
        files: {}
      }
    })
  }
}

module.exports = { convertElmslnToSite }