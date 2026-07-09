const { convertHaxcmsToSite } = require('./imports/convertHaxcmsToSite.js')
const { convertHtmlToSite } = require('./imports/convertHtmlToSite.js')
const { convertPressbooksToSite } = require('./imports/convertPressbooksToSite.js')
const { convertGitbookToSite } = require('./imports/convertGitbookToSite.js')
const { convertNotionToSite } = require('./imports/convertNotionToSite.js')
const { convertWordpressToSite } = require('./imports/convertWordpressToSite.js')
const { convertElmslnToSite } = require('./imports/convertElmslnToSite.js')
const { convertDrupalBookToSite } = require('./imports/convertDrupalBookToSite.js')
const { convertPloneToSite } = require('./imports/convertPloneToSite.js')
const { convertRecipeToSite } = require('./imports/convertRecipeToSite.js')

/**
 * POST /system/api/v1/site/import/:platform
 * Dispatcher that routes platform import requests to the correct converter.
 *
 * Supported platforms: haxcms, html, pressbooks, gitbook, notion, wordpress,
 * elmsln, drupal-book, plone, recipe.
 * Returns { status: 200, data: { items: [...], filename: string, ... } }.
 */
async function siteImport(req, res) {
  const platform =
    req && req.params && req.params.platform
      ? String(req.params.platform).toLowerCase().trim()
      : ''

  switch (platform) {
    case 'haxcms':
      return convertHaxcmsToSite(req, res)
    case 'html':
      return convertHtmlToSite(req, res)
    case 'pressbooks':
      return convertPressbooksToSite(req, res)
    case 'gitbook':
      return convertGitbookToSite(req, res)
    case 'notion':
      return convertNotionToSite(req, res)
    case 'wordpress':
      return convertWordpressToSite(req, res)
    case 'elmsln':
      return convertElmslnToSite(req, res)
    case 'drupal-book':
      return convertDrupalBookToSite(req, res)
    case 'plone':
      return convertPloneToSite(req, res)
    case 'recipe':
      return convertRecipeToSite(req, res)
    default:
      return res.status(400).json({
        status: 400,
        data: {
          error: `Unsupported import platform "${platform}"`,
          items: [],
          filename: null,
        },
      })
  }
}

module.exports = { siteImport }
