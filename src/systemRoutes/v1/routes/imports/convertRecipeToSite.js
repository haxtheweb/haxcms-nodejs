const child_process = require('child_process')
const util = require('node:util')
const fs = require('fs')
const path = require('path')
const { safeFetch } = require('../../../../lib/safeFetch.js')

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

async function convertRecipeToSite(req, res) {
  let repoUrl = null
  if (req && req.query && req.query.repoUrl) {
    repoUrl = req.query.repoUrl
  } else if (req && req.body && req.body.repoUrl) {
    repoUrl = req.body.repoUrl
  }

  let recipeContent = null
  let recipeName = 'recipe'
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

  if (!repoUrl && !recipeContent) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'missing `repoUrl` param',
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
      fs.writeFileSync(`${tmpDir}/${RECIPENAME}`, recipe)
      recipeName = deriveRecipeName(repoUrl, 'recipe')
    }

    await exec(`${HAXPROGRAM} site recipe:play --y --recipe "${RECIPENAME}" --root "${tmpDir}" --no-i`)
    await exec(`${HAXPROGRAM} site site:items --y --format json --to-file "${ITEMSFILE}" --root "${tmpDir}" --no-i`)

    const items = JSON.parse(fs.readFileSync(`${tmpDir}/${ITEMSFILE}`, 'utf8'))

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
