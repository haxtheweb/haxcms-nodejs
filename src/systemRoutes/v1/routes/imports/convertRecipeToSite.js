const child_process = require('child_process')
const util = require('node:util')
const fs = require('fs')
const path = require('path')
const { safeFetch } = require('../../../../lib/safeFetch.js')
const crypto = require('node:crypto')

const exec = util.promisify(child_process.exec)
const SITENAME = 'recipe-import-tmp'
const RECIPENAME = 'tmp.recipe'
const ITEMSFILE = 'items.json'
const UPLOAD_FIELD_ALLOWLIST = ['upload', 'file', 'file-upload']

// D34: derive the output filename from the recipe/repo name (PHP canonical).
// Mirrors PHP preg_replace('/\.(json|yaml|yml)$/i', '', lastPathSegment).
function deriveRecipeName(source, fallback) {
  let base = String(source || '').split('/').pop() || fallback
  base = base.replace(/\.(json|yaml|yml)$/i, '')
  return base !== '' ? base : fallback
}

function findHaxCli() {
  const localPath = path.resolve(__dirname, '../../../../../../create/dist/create.js')
  if (fs.existsSync(localPath)) {
    return `node ${localPath}`
  }
  return 'npm exec @haxtheweb/create --'
}

// D34: slugify a title for fallback item generation (mirrors HAXCMS.cleanTitle
// without importing the full HAXCMS module).
function slugifyTitle(title) {
  let slug = String(title || '').trim()
  slug = slug.replace(/ /g, '-').toLowerCase()
  slug = slug.replace(/[^\w\-/]+/gu, '-')
  slug = slug.replace(/--+/gu, '-')
  if (slug === '') {
    slug = 'blank'
  }
  return slug
}

// PHP parity fallback: when the HAX CLI yields no usable items, parse the
// recipe JSON directly for an `items` or `pages` array (mirrors
// convertRecipeToSite.php lines 99-133). parentId seeds the default parent.
function parseRecipeItems(recipeContent, parentId) {
  let recipe = null
  try {
    recipe = JSON.parse(recipeContent)
  } catch (e) {
    return []
  }
  if (!recipe || typeof recipe !== 'object') {
    return []
  }
  const items = []
  if (Array.isArray(recipe.items)) {
    let order = 0
    for (let i = 0; i < recipe.items.length; i++) {
      const ri = recipe.items[i] || {}
      const title = ri.title ? String(ri.title) : 'Page'
      items.push({
        id: crypto.randomUUID(),
        title: title,
        order: typeof ri.order === 'number' ? ri.order : order,
        parent: ri.parent ? String(ri.parent) : parentId,
        slug: ri.slug ? String(ri.slug) : slugifyTitle(title),
        contents: ri.contents ? String(ri.contents) : '',
        description: ri.description ? String(ri.description) : '',
        metadata: ri.metadata && typeof ri.metadata === 'object' ? ri.metadata : {},
      })
      order++
    }
  } else if (Array.isArray(recipe.pages)) {
    let order = 0
    for (let i = 0; i < recipe.pages.length; i++) {
      const page = recipe.pages[i] || {}
      const title = page.title ? String(page.title) : 'Page'
      items.push({
        id: crypto.randomUUID(),
        title: title,
        order: order,
        parent: parentId,
        slug: page.slug ? String(page.slug) : slugifyTitle(title),
        contents: page.content ? String(page.content) : '',
        description: '',
        metadata: {},
      })
      order++
    }
  }
  return items
}

async function convertRecipeToSite(req, res) {
  // Read the request body (parity with PHP convertRecipeToSite.php and the
  // other NodeJS import handlers).
  let body = {}
  if (req && req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    body = req.body
  }

  let repoUrl = null
  if (req && req.query && req.query.repoUrl) {
    repoUrl = req.query.repoUrl
  } else if (body.repoUrl) {
    repoUrl = body.repoUrl
  }

  // Read optional import hints declared in the OpenAPI spec (PHP parity).
  // parentId is consumed by the fallback item parser below; method/type are
  // accepted on the input surface for parity with the other import endpoints
  // (the PHP recipe handler likewise accepts but does not consume them).
  let parentId = null
  if (body.parentId && body.parentId !== 'null') {
    parentId = String(body.parentId)
  }
  const method = body.method ? String(body.method) : null
  const type = body.type ? String(body.type) : null

  let recipeContent = null
  let recipeName = 'recipe'

  // 1) Uploaded recipe file (allowlist: upload/file/file-upload).
  if (req.files && req.files.length > 0) {
    const file = req.files[0]
    // D37: validate upload field name against the canonical allowlist.
    if (UPLOAD_FIELD_ALLOWLIST.indexOf(file.fieldname) === -1) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Unexpected upload field name \`${file.fieldname}\`; expected one of: ${UPLOAD_FIELD_ALLOWLIST.join(', ')}`,
          items: [],
          filename: null
        }
      })
    }
    try {
      recipeContent = fs.readFileSync(file.path, 'utf8')
      recipeName = deriveRecipeName(file.originalname, 'recipe')
    } catch (e) {
      return res.status(400).json({
        status: 400,
        data: {
          error: `Unable to read uploaded file: ${e.message}`,
          items: [],
          filename: null
        }
      })
    }
  }

  // 2) Inline recipe object/string in the body (PHP parity: alternative to a
  // file upload or repoUrl fetch).
  if (!recipeContent && body.recipe) {
    if (typeof body.recipe === 'object') {
      recipeContent = JSON.stringify(body.recipe)
    } else {
      recipeContent = String(body.recipe)
    }
    recipeName = 'recipe'
  }

  // 3) Fetch from repoUrl.
  if (!repoUrl && !recipeContent) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'missing recipe content, file upload, or `repoUrl` param',
        items: [],
        filename: null
      }
    })
  }

  const HAXPROGRAM = findHaxCli()
  const tmpDir = `/tmp/${SITENAME}`

  try {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }

    await exec(`${HAXPROGRAM} site ${SITENAME} --path "/tmp/" --y --quiet --no-i`)

    if (recipeContent) {
      fs.writeFileSync(`${tmpDir}/${RECIPENAME}`, recipeContent)
    } else {
      const recipe = await safeFetch(`${repoUrl}`).then((d) => d.ok ? d.text() : '')
      if (!recipe) {
        return res.status(400).json({
          status: 400,
          data: {
            error: 'Unable to fetch recipe from URL',
            items: [],
            filename: null
          }
        })
      }
      recipeContent = recipe
      fs.writeFileSync(`${tmpDir}/${RECIPENAME}`, recipeContent)
      recipeName = deriveRecipeName(repoUrl, 'recipe')
    }

    await exec(`${HAXPROGRAM} site recipe:play --y --recipe "${RECIPENAME}" --root "${tmpDir}" --no-i`)
    await exec(`${HAXPROGRAM} site site:items --y --format json --to-file "${ITEMSFILE}" --root "${tmpDir}" --no-i`)

    let items = []
    try {
      items = JSON.parse(fs.readFileSync(`${tmpDir}/${ITEMSFILE}`, 'utf8'))
    } catch (e) {
      // items file missing or invalid; fall through to the direct-parse fallback
    }
    if (!Array.isArray(items) || items.length === 0) {
      // PHP parity: parse the recipe JSON directly when the HAX CLI yields no
      // usable items (mirrors convertRecipeToSite.php fallback).
      items = parseRecipeItems(recipeContent, parentId)
    }

    return res.json({
      status: 200,
      data: {
        items: items,
        filename: recipeName
      }
    })
  } catch (error) {
    console.error('recipeToSite: Error processing recipe:', error.message)
    return res.status(400).json({
      status: 400,
      data: {
        error: `Error processing recipe: ${error.message}`,
        items: [],
        filename: null
      }
    })
  }
}

module.exports = { convertRecipeToSite }
