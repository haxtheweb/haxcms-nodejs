const child_process = require('child_process')
const util = require('node:util')
const fs = require('fs')
const path = require('path')

const exec = util.promisify(child_process.exec)
const SITENAME = 'recipe-import-tmp'
const RECIPENAME = 'tmp.recipe'
const ITEMSFILE = 'items.json'

function findHaxCli() {
  const localPath = path.resolve(__dirname, '../../../../../../create/dist/create.js')
  if (fs.existsSync(localPath)) {
    return `node ${localPath}`
  }
  return 'npm exec @haxtheweb/create --'
}

async function convertRecipeToSite(req, res) {
  let q = null
  if (req && req.query && req.query.q) {
    q = req.query.q
  } else if (req && req.body && req.body.q) {
    q = req.body.q
  }

  let recipeContent = null
  if (req.files && req.files.length > 0) {
    const file = req.files[0]
    try {
      recipeContent = fs.readFileSync(file.path, 'utf8')
      q = 'file-upload'
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

  if (!q && !recipeContent) {
    return res.status(400).json({
      status: 400,
      data: {
        error: 'missing `q` param',
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
      const recipe = await fetch(`${q}`).then((d) => d.ok ? d.text() : '')
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
    }

    await exec(`${HAXPROGRAM} site recipe:play --y --recipe "${RECIPENAME}" --root "${tmpDir}" --no-i`)
    await exec(`${HAXPROGRAM} site site:items --y --format json --to-file "${ITEMSFILE}" --root "${tmpDir}" --no-i`)

    const items = JSON.parse(fs.readFileSync(`${tmpDir}/${ITEMSFILE}`, 'utf8'))

    return res.json({
      status: 200,
      data: {
        items: items,
        filename: `${SITENAME}.json`
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
