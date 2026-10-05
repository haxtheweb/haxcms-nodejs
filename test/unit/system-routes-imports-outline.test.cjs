'use strict'

// Direct handler unit tests for three remaining system/site routes:
//   src/systemRoutes/v1/routes/importDocx.js — a real minimal .docx built
//     at runtime with JSZip ([Content_Types].xml + word/document.xml with
//     Heading1/Heading2 styles), converted through the real mammoth
//     convertToHtml, driving the site/branch/page import methods
//   src/systemRoutes/v1/routes/schemaFileOperation.js — user-token auth,
//     skeleton upload/rename/delete against a temp HAXCMS.configDirectory
//     user/skeletons tree, including method-inferred actions
//   src/siteRoutes/v1/routes/saveOutline.js — the main outline save flow
//     against a fake site with a real temp siteDirectory: existing item
//     updates, new item creation with the server UUID itemMap, pathauto
//     slug regeneration, duplicate + contents writes, delete flags with
//     orphan rescue
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')

const { HAXCMS } = require('../../src/lib/HAXCMS.js')
const { importDocx } = require('../../src/systemRoutes/v1/routes/importDocx.js')
const schemaFileOperation = require('../../src/systemRoutes/v1/routes/schemaFileOperation.js')
const saveOutline = require('../../src/siteRoutes/v1/routes/saveOutline.js')

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(obj) {
      this.body = obj
      return this
    },
    send(obj) {
      this.sent = obj
      return this
    },
  }
}

function mockUserAuth(t) {
  t.mock.method(HAXCMS, 'validateRequestToken', (token, value) => value === 'tester')
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
}

function mockSiteAuth(t, site) {
  t.mock.method(HAXCMS, 'validateRequestToken', (token, value) => value === 'tester:demo')
  t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
  t.mock.method(HAXCMS, 'loadSite', async () => site)
}

// ---------------------------------------------------------------------------
// importDocx — real minimal .docx through mammoth
// ---------------------------------------------------------------------------
function wParagraph(text, style) {
  const styleTag = style
    ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
    : ''
  return `<w:p>${styleTag}<w:r><w:t>${text}</w:t></w:r></w:p>`
}

async function buildDocxBuffer(paragraphs) {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  )
  zip.folder('_rels').file(
    '.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.folder('word').file(
    'document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paragraphs.join('')}</w:body>` +
      '</w:document>',
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function makeDocxFile(t, paragraphs, name) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'importdocx-'))
  t.after(() => {
    fs.removeSync(tmpDir)
  })
  const filePath = path.join(tmpDir, name || 'course.docx')
  fs.writeFileSync(filePath, await buildDocxBuffer(paragraphs))
  return filePath
}

function docxReq(file, body) {
  return {
    headers: {},
    query: {},
    params: {},
    files: file
      ? [{ path: typeof file === 'string' ? file : file.path, originalname: path.basename(file), fieldname: 'file' }]
      : [],
    body: body || {},
  }
}

describe('importDocx route', () => {
  test('validation failures answer 400 with filename echo', async (t) => {
    mockUserAuth(t)
    const resNoFiles = stubRes()
    await importDocx(docxReq(null), resNoFiles)
    assert.equal(resNoFiles.statusCode, 400)
    assert.equal(resNoFiles.body.data.error, 'No file uploaded')

    const resBadType = stubRes()
    await importDocx(docxReq('/tmp/nonexistent/notdocx.txt', {}), resBadType)
    assert.equal(resBadType.statusCode, 400)
    assert.ok(resBadType.body.data.error.indexOf('Invalid file type') === 0)

    const resUnreadable = stubRes()
    await importDocx(docxReq('/tmp/nonexistent/missing.docx', {}), resUnreadable)
    assert.equal(resUnreadable.statusCode, 400)
    assert.ok(resUnreadable.body.data.error.indexOf('Unable to read uploaded file') === 0)

    const emptyFile = await makeDocxFile(t, [], 'empty.docx')
    fs.writeFileSync(emptyFile, '')
    const resEmpty = stubRes()
    await importDocx(docxReq(emptyFile, {}), resEmpty)
    assert.equal(resEmpty.statusCode, 400)
    assert.equal(resEmpty.body.data.error, 'Uploaded file is empty')

    const badMagicFile = await makeDocxFile(t, [], 'bad.docx')
    fs.writeFileSync(badMagicFile, 'plainly not a zip archive')
    const resBadMagic = stubRes()
    await importDocx(docxReq(badMagicFile, {}), resBadMagic)
    assert.equal(resBadMagic.statusCode, 400)
    assert.ok(resBadMagic.body.data.error.indexOf('not a valid .docx') !== -1)
  })

  test('method=site builds a heading tree with parent and child pages', async (t) => {
    mockUserAuth(t)
    const file = await makeDocxFile(t, [
      wParagraph('Chapter One', 'Heading1'),
      wParagraph('Intro text', null),
      wParagraph('Section One', 'Heading2'),
      wParagraph('Section body', null),
      wParagraph('Chapter Two', 'Heading1'),
      wParagraph('Second chapter body', null),
    ])
    const res = stubRes()
    await importDocx(docxReq(file, { method: 'site' }), res)
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.filename, 'course.docx')
    const items = res.body.data.items
    assert.equal(items.length, 3)
    assert.equal(items[0].title, 'Chapter One')
    assert.ok(items[0].contents.indexOf('Intro text') !== -1)
    // the H2 becomes a child of the H1 root
    assert.equal(items[1].title, 'Section One')
    assert.equal(items[1].parent, items[0].id)
    assert.equal(items[1].indent, 1)
    assert.ok(items[1].contents.indexOf('Section body') !== -1)
    assert.equal(items[2].title, 'Chapter Two')
    assert.equal(items[2].parent, null)
  })

  test('method=branch flattens headings into sibling pages', async (t) => {
    mockUserAuth(t)
    const file = await makeDocxFile(t, [
      wParagraph('Chapter One', 'Heading1'),
      wParagraph('Intro text', null),
      wParagraph('Chapter Two', 'Heading1'),
      wParagraph('Body two', null),
    ])
    const res = stubRes()
    await importDocx(
      docxReq(file, { method: 'branch', parentId: 'parent-item' }),
      res,
    )
    assert.equal(res.body.status, 200)
    const items = res.body.data.items
    assert.equal(items.length, 2)
    assert.equal(items[0].title, 'Chapter One')
    assert.equal(items[0].parent, 'parent-item')
    assert.ok(items[0].contents.indexOf('Intro text') !== -1)
    assert.equal(items[1].title, 'Chapter Two')
    assert.equal(items[1].parent, 'parent-item')
  })

  test('method=page answers a single page item, headings aside', async (t) => {
    mockUserAuth(t)
    const file = await makeDocxFile(t, [
      wParagraph('Only A Heading', 'Heading1'),
      wParagraph('Page body', null),
    ])
    const res = stubRes()
    await importDocx(
      docxReq(file, { method: 'page', parentId: 'null' }),
      res,
    )
    assert.equal(res.body.status, 200)
    const items = res.body.data.items
    assert.equal(items.length, 1)
    assert.equal(items[0].title, 'course')
    // parentId 'null' normalizes to a null parent
    assert.equal(items[0].parent, null)
    assert.ok(items[0].contents.indexOf('Page body') !== -1)
  })

  test('a headingless doc answers a single page with the file title', async (t) => {
    mockUserAuth(t)
    const file = await makeDocxFile(t, [wParagraph('Just body text', null)])
    const res = stubRes()
    await importDocx(docxReq(file, { method: 'site' }), res)
    assert.equal(res.body.status, 200)
    const items = res.body.data.items
    assert.equal(items.length, 1)
    assert.equal(items[0].title, 'course')
    assert.ok(items[0].contents.indexOf('Just body text') !== -1)
  })

  test('portfolio and course types fall back to overview content', async (t) => {
    mockUserAuth(t)
    const portfolioFile = await makeDocxFile(t, [
      wParagraph('Empty Chapter', 'Heading1'),
    ])
    const resPortfolio = stubRes()
    await importDocx(
      docxReq(portfolioFile, { method: 'site', type: 'portfolio' }),
      resPortfolio,
    )
    assert.equal(resPortfolio.body.status, 200)
    assert.ok(
      resPortfolio.body.data.items[0].contents.indexOf('lesson-overview') !== -1,
      'portfolio fallback content',
    )
    assert.ok(
      resPortfolio.body.data.items[0].contents.indexOf('portfolio') !== -1,
    )
    const courseFile = await makeDocxFile(t, [
      wParagraph('Empty Chapter', 'Heading1'),
    ])
    const resCourse = stubRes()
    await importDocx(
      docxReq(courseFile, { method: 'site', type: 'course' }),
      resCourse,
    )
    assert.ok(resCourse.body.data.items[0].contents.indexOf('selfChecks') !== -1)
  })
})

// ---------------------------------------------------------------------------
// schemaFileOperation — skeleton upload/rename/delete on temp config
// ---------------------------------------------------------------------------
describe('schemaFileOperation route', () => {
  function makeReq(overrides) {
    const req = {
      method: 'POST',
      headers: { 'x-haxcms-user-token': 'token' },
      query: {},
      params: {},
      body: {},
    }
    return Object.assign(req, overrides || {})
  }

  function useTempConfigDirectory(t) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schemafile-config-'))
    const originalConfigDirectory = HAXCMS.configDirectory
    HAXCMS.configDirectory = tmpDir
    t.after(() => {
      HAXCMS.configDirectory = originalConfigDirectory
      fs.removeSync(tmpDir)
    })
    return tmpDir
  }

  async function makeUploadFile(t, content, name) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schemafile-upload-'))
    t.after(() => {
      fs.removeSync(tmpDir)
    })
    const filePath = path.join(tmpDir, name || 'my-skeleton.json')
    fs.writeFileSync(filePath, content)
    return {
      path: filePath,
      originalname: name || 'my-skeleton.json',
      fieldname: 'file',
    }
  }

  test('a missing or invalid user token answers 403', async (t) => {
    useTempConfigDirectory(t)
    mockUserAuth(t)
    const resNoToken = stubRes()
    await schemaFileOperation(makeReq({ headers: {} }), resNoToken)
    assert.equal(resNoToken.statusCode, 403)
    assert.equal(resNoToken.body.data.message, 'invalid request token')
    t.mock.method(HAXCMS, 'validateRequestToken', () => false)
    const resBadToken = stubRes()
    await schemaFileOperation(makeReq(), resBadToken)
    assert.equal(resBadToken.statusCode, 403)
  })

  test('invalid schema and action values answer 400', async (t) => {
    useTempConfigDirectory(t)
    mockUserAuth(t)
    const resSchema = stubRes()
    await schemaFileOperation(makeReq({ body: { schema: 'bogus' } }), resSchema)
    assert.equal(resSchema.statusCode, 400)
    assert.equal(resSchema.body.data.message, 'invalid schema')
    const resAction = stubRes()
    await schemaFileOperation(makeReq({ body: { action: 'bogus' } }), resAction)
    assert.equal(resAction.statusCode, 400)
    assert.equal(resAction.body.data.message, 'invalid action')
    // PATCH/PUT only allows rename
    const resPatch = stubRes()
    await schemaFileOperation(
      makeReq({ method: 'PATCH', body: { action: 'delete' } }),
      resPatch,
    )
    assert.equal(resPatch.statusCode, 400)
    assert.equal(
      resPatch.body.data.message,
      'only rename is allowed for PATCH/PUT on skeletons',
    )
    // a request with no inferable action answers 400
    const resNone = stubRes()
    await schemaFileOperation(makeReq({ method: 'GET' }), resNone)
    assert.equal(resNone.statusCode, 400)
    assert.equal(resNone.body.data.message, 'invalid action')
  })

  test('upload writes a normalized skeleton and answers its location', async (t) => {
    const configDir = useTempConfigDirectory(t)
    mockUserAuth(t)
    const upload = await makeUploadFile(
      t,
      JSON.stringify({ meta: { name: 'My Skeleton' }, build: { items: [] } }),
      'course-start.json',
    )
    const res = stubRes()
    await schemaFileOperation(
      makeReq({ body: { schema: 'skeleton', action: 'upload', name: 'Course Start' }, file: upload }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.machineName, 'course-start')
    assert.equal(res.body.data.fileName, 'course-start.json')
    assert.ok(
      res.body.data.location.indexOf('/user/skeletons/course-start.json') !== -1,
    )
    // the stored skeleton carries the meta machine name
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(configDir, 'user', 'skeletons', 'course-start.json'),
        'utf8',
      ),
    )
    assert.equal(stored.meta.machineName, 'course-start')
    // the staged upload file was cleaned up
    assert.equal(fs.pathExistsSync(upload.path), false)
  })

  test('upload validation failures answer 400/409', async (t) => {
    useTempConfigDirectory(t)
    mockUserAuth(t)
    // missing upload file
    const resMissing = stubRes()
    await schemaFileOperation(
      makeReq({ body: { schema: 'skeleton', action: 'upload' } }),
      resMissing,
    )
    assert.equal(resMissing.statusCode, 400)
    assert.equal(resMissing.body.data.message, 'missing file upload')
    // wrong extension
    const badExt = await makeUploadFile(t, 'x', 'notes.txt')
    const resBadExt = stubRes()
    await schemaFileOperation(
      makeReq({ body: { schema: 'skeleton', action: 'upload' }, file: badExt }),
      resBadExt,
    )
    assert.equal(resBadExt.statusCode, 400)
    assert.ok(resBadExt.body.data.message.indexOf('expected .json') !== -1)
    // invalid json content
    const badJson = await makeUploadFile(t, 'not json', 'broken.json')
    const resBadJson = stubRes()
    await schemaFileOperation(
      makeReq({ body: { schema: 'skeleton', action: 'upload' }, file: badJson }),
      resBadJson,
    )
    assert.equal(resBadJson.statusCode, 400)
    assert.equal(resBadJson.body.data.message, 'invalid skeleton json')
    // unusable name
    const noName = await makeUploadFile(
      t,
      JSON.stringify({ meta: {} }),
      '!!!.json',
    )
    const resNoName = stubRes()
    await schemaFileOperation(
      makeReq({ body: { schema: 'skeleton', action: 'upload' }, file: noName }),
      resNoName,
    )
    assert.equal(resNoName.statusCode, 400)
    assert.equal(resNoName.body.data.message, 'invalid upload name')
  })

  test('rename moves a skeleton and updates its meta machine name', async (t) => {
    const configDir = useTempConfigDirectory(t)
    mockUserAuth(t)
    const skeletonsDir = path.join(configDir, 'user', 'skeletons')
    fs.ensureDirSync(skeletonsDir)
    fs.writeFileSync(
      path.join(skeletonsDir, 'course-start.json'),
      JSON.stringify({ meta: { machineName: 'course-start' }, build: {} }) + '\n',
    )
    const res = stubRes()
    await schemaFileOperation(
      makeReq({
        method: 'PATCH',
        body: { schema: 'skeleton', name: 'course-start', newName: 'course v2' },
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.machineName, 'course-v2')
    assert.equal(res.body.data.fileName, 'course-v2.json')
    assert.equal(
      fs.pathExistsSync(path.join(skeletonsDir, 'course-start.json')),
      false,
    )
    const stored = JSON.parse(
      fs.readFileSync(path.join(skeletonsDir, 'course-v2.json'), 'utf8'),
    )
    assert.equal(stored.meta.machineName, 'course-v2')
  })

  test('rename validation failures answer 400/404/409', async (t) => {
    const configDir = useTempConfigDirectory(t)
    mockUserAuth(t)
    const skeletonsDir = path.join(configDir, 'user', 'skeletons')
    fs.ensureDirSync(skeletonsDir)
    fs.writeFileSync(
      path.join(skeletonsDir, 'course-start.json'),
      JSON.stringify({ meta: { machineName: 'course-start' } }) + '\n',
    )
    const resMissing = stubRes()
    await schemaFileOperation(
      makeReq({ method: 'PATCH', body: { schema: 'skeleton', name: 'ghost', newName: 'x1' } }),
      resMissing,
    )
    assert.equal(resMissing.statusCode, 404)
    assert.equal(resMissing.body.data.message, 'file not found')
    const resInvalid = stubRes()
    await schemaFileOperation(
      makeReq({ method: 'PATCH', body: { schema: 'skeleton', name: 'course-start', newName: '!!!' } }),
      resInvalid,
    )
    assert.equal(resInvalid.statusCode, 400)
    assert.equal(resInvalid.body.data.message, 'invalid new name')
    const resSame = stubRes()
    await schemaFileOperation(
      makeReq({ method: 'PATCH', body: { schema: 'skeleton', name: 'course-start', newName: 'course-start' } }),
      resSame,
    )
    assert.equal(resSame.statusCode, 400)
    assert.equal(resSame.body.data.message, 'new name must be different')
    fs.writeFileSync(
      path.join(skeletonsDir, 'taken.json'),
      JSON.stringify({ meta: {} }) + '\n',
    )
    const resCollision = stubRes()
    await schemaFileOperation(
      makeReq({ method: 'PATCH', body: { schema: 'skeleton', name: 'course-start', newName: 'taken' } }),
      resCollision,
    )
    assert.equal(resCollision.statusCode, 409)
    assert.equal(resCollision.body.data.message, 'file already exists')
  })

  test('delete removes a skeleton; a missing one answers 404', async (t) => {
    const configDir = useTempConfigDirectory(t)
    mockUserAuth(t)
    const skeletonsDir = path.join(configDir, 'user', 'skeletons')
    fs.ensureDirSync(skeletonsDir)
    fs.writeFileSync(
      path.join(skeletonsDir, 'doomed.json'),
      JSON.stringify({ meta: { machineName: 'doomed' } }) + '\n',
    )
    // DELETE infers the delete action without an explicit one
    const res = stubRes()
    await schemaFileOperation(
      makeReq({ method: 'DELETE', body: { schema: 'skeleton', name: 'doomed' } }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    assert.equal(res.body.data.action, 'delete')
    assert.equal(res.body.data.machineName, 'doomed')
    assert.equal(fs.pathExistsSync(path.join(skeletonsDir, 'doomed.json')), false)
    const resMissing = stubRes()
    await schemaFileOperation(
      makeReq({ method: 'DELETE', body: { schema: 'skeleton', name: 'ghost' } }),
      resMissing,
    )
    assert.equal(resMissing.statusCode, 404)
    assert.equal(resMissing.body.data.message, 'file not found')
  })
})

// ---------------------------------------------------------------------------
// saveOutline — main save flow
// ---------------------------------------------------------------------------
describe('saveOutline route', () => {
  function makeOutlineSite(t) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saveoutline-'))
    const siteDirectory = path.join(tmpRoot, 'demo')
    fs.ensureDirSync(path.join(siteDirectory, 'pages', 'item-1'))
    fs.writeFileSync(
      path.join(siteDirectory, 'pages', 'item-1', 'index.html'),
      '<p>first page content</p>',
    )
    fs.ensureDirSync(path.join(siteDirectory, 'pages', 'item-2'))
    fs.writeFileSync(
      path.join(siteDirectory, 'pages', 'item-2', 'index.html'),
      '<p>second page content</p>',
    )
    // items carry a real writeLocation so contents/duplicate writes hit disk
    function itemWriteLocation(content) {
      const pagePath = path.join(siteDirectoryRef.directory, this.location)
      fs.ensureDirSync(path.dirname(pagePath))
      fs.writeFileSync(pagePath, content)
      return content.length
    }
    const siteDirectoryRef = { directory: siteDirectory }
    const items = [
      {
        id: 'item-1',
        title: 'Old First',
        slug: 'old-first',
        parent: null,
        indent: 0,
        order: 0,
        location: 'pages/item-1/index.html',
        metadata: {},
        writeLocation: itemWriteLocation,
      },
      {
        id: 'item-2',
        title: 'Old Second',
        slug: 'old-second',
        parent: 'item-1',
        indent: 1,
        order: 1,
        location: 'pages/item-2/index.html',
        metadata: {},
        writeLocation: itemWriteLocation,
      },
    ]
    const calls = {
      gitCommits: [],
      deleteNodes: [],
      updateNodes: [],
      rebuildManagedFiles: 0,
      updateAlternateFormats: 0,
      writePageAlternateFormats: 0,
      saveCalls: [],
      recurseCopies: [],
    }
    const site = {
      siteDirectory: siteDirectory,
      name: 'demo',
      calls: calls,
      manifest: {
        items: items,
        metadata: {
          site: {
            name: 'demo',
            settings: { pathauto: true },
          },
        },
        addItem(item) {
          items.push(item)
          return items.length
        },
        async save(reorder) {
          calls.saveCalls.push(typeof reorder === 'boolean' ? reorder : true)
        },
      },
      loadNode(id) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].id === id) {
            return items[i]
          }
        }
        return null
      },
      async getPageContent(page) {
        const pagePath = path.join(siteDirectory, page.location)
        if (fs.pathExistsSync(pagePath)) {
          return fs.readFileSync(pagePath, 'utf8')
        }
        return ''
      },
      getUniqueSlugName(slug) {
        return slug
      },
      async updateNode(page) {
        calls.updateNodes.push(page.id)
      },
      async deleteNode(page) {
        calls.deleteNodes.push(page.id)
        const index = items.indexOf(page)
        if (index !== -1) {
          items.splice(index, 1)
        }
        return true
      },
      async rebuildManagedFiles() {
        calls.rebuildManagedFiles++
      },
      updateAlternateFormats() {
        calls.updateAlternateFormats++
      },
      writePageAlternateFormats() {
        calls.writePageAlternateFormats++
      },
      async gitCommit(message) {
        calls.gitCommits.push(message)
      },
    }
    t.mock.method(HAXCMS, 'recurseCopy', async (source, destination) => {
      calls.recurseCopies.push({ source: source, destination: destination })
      // saveOutline hands the destination as the page DIRECTORY (location
      // stripped of /index.html), so materialize the directory + page file
      fs.ensureDirSync(destination)
      fs.writeFileSync(path.join(destination, 'index.html'), '<p>new page</p>')
    })
    t.after(() => {
      fs.removeSync(tmpRoot)
    })
    return site
  }

  function outlineReq(body) {
    return {
      headers: { 'x-haxcms-site-token': 'token' },
      query: {},
      params: {},
      body: body,
    }
  }

  test('an invalid token answers 403', async (t) => {
    const site = makeOutlineSite(t)
    t.mock.method(HAXCMS, 'validateRequestToken', () => false)
    t.mock.method(HAXCMS, 'getActiveUserName', () => 'tester')
    t.mock.method(HAXCMS, 'loadSite', async () => site)
    const res = stubRes()
    await saveOutline(outlineReq({ site: { name: 'demo' }, items: [] }), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.data.message, 'Authentication required')
  })

  test('saves an outline mixing updates, creation, contents, and deletes', async (t) => {
    const site = makeOutlineSite(t)
    mockSiteAuth(t, site)
    const res = stubRes()
    await saveOutline(
      outlineReq({
        site: { name: 'demo' },
        items: [
          // existing page: retitled, contents rewritten
          {
            id: 'item-1',
            title: 'New First',
            parent: null,
            order: 0,
            slug: 'new-first',
            contents: '<p>rewritten first</p>',
            metadata: { published: true },
          },
          // new page: server UUID assigned, boilerplate copied
          {
            id: 'client-new',
            title: 'Fresh Page',
            parent: 'item-1',
            order: 1,
            slug: 'fresh-page',
          },
          // existing page marked for deletion
          {
            id: 'item-2',
            title: 'Old Second',
            parent: 'item-1',
            order: 2,
            delete: true,
          },
          // duplicate of the rewritten first page
          {
            id: 'client-new',
            title: 'Fresh Page',
            parent: 'item-1',
            order: 1,
            duplicate: 'item-1',
          },
        ],
      }),
      res,
    )
    assert.equal(res.statusCode, null)
    assert.equal(res.body.status, 200)
    const items = site.manifest.items
    // item-2 was deleted; item-1 updated; the create AND duplicate entries
    // each produced their own server-UUID page
    assert.equal(items.length, 3)
    const first = items.filter((item) => item.id === 'item-1')[0]
    assert.equal(first.title, 'New First')
    assert.ok(fs.readFileSync(path.join(site.siteDirectory, 'pages', 'item-1', 'index.html'), 'utf8').indexOf('rewritten first') !== -1)
    const created = items.filter((item) => item.id !== 'item-1')
    assert.equal(created.length, 2)
    for (let i = 0; i < created.length; i++) {
      assert.equal(created[i].title, 'Fresh Page')
      assert.equal(created[i].parent, 'item-1')
    }
    // the boilerplate page was copied for each created page
    assert.equal(site.calls.recurseCopies.length, 2)
    assert.ok(site.calls.recurseCopies[0].destination.indexOf('pages/') !== -1)
    // duplicate + contents were written through writeLocation + alternates
    assert.equal(site.calls.writePageAlternateFormats >= 2, true)
    // the server id map reports the client id -> server id translation
    assert.ok(res.body.data.idMap['client-new'] !== undefined)
    // the deleted page was removed and committed
    assert.deepEqual(site.calls.deleteNodes, ['item-2'])
    assert.ok(
      site.calls.gitCommits.some((message) => message.indexOf('Page deleted') !== -1),
    )
    // orphan rescue: remaining child of the deleted page keeps its parent
    // here the created page's parent (item-1) still exists, so no rescue fires
    assert.equal(site.calls.rebuildManagedFiles, 1)
    assert.ok(
      site.calls.gitCommits.indexOf('Outline updated in bulk') !== -1,
    )
  })

  test('orphan children are rescued when their parent is deleted', async (t) => {
    const site = makeOutlineSite(t)
    mockSiteAuth(t, site)
    // delete item-1 while item-2 still points at it
    const res = stubRes()
    await saveOutline(
      outlineReq({
        site: { name: 'demo' },
        items: [
          { id: 'item-1', title: 'Old First', parent: null, order: 0, delete: true },
          { id: 'item-2', title: 'Old Second', parent: 'item-1', order: 1 },
        ],
      }),
      res,
    )
    assert.equal(res.body.status, 200)
    // item-2 lost its parent and was re-parented to the root
    const survivor = site.manifest.items.filter((item) => item.id === 'item-2')[0]
    assert.equal(survivor.parent, null)
    assert.ok(site.calls.updateNodes.indexOf('item-2') !== -1)
  })

  test('invalid page references and contents answer 400', async (t) => {
    const site = makeOutlineSite(t)
    mockSiteAuth(t, site)
    const resBadContents = stubRes()
    await saveOutline(
      outlineReq({
        site: { name: 'demo' },
        items: [
          {
            id: 'item-1',
            title: 'First',
            parent: null,
            order: 0,
            contents: 'plain text without tags',
          },
        ],
      }),
      resBadContents,
    )
    assert.equal(resBadContents.statusCode, 400)
    assert.equal(resBadContents.body.data.message, 'invalid page contents')
    const resBadDuplicate = stubRes()
    await saveOutline(
      outlineReq({
        site: { name: 'demo' },
        items: [
          {
            id: 'item-1',
            title: 'First',
            parent: null,
            order: 0,
            duplicate: 'ghost-item',
          },
        ],
      }),
      resBadDuplicate,
    )
    assert.equal(resBadDuplicate.statusCode, 400)
    assert.equal(resBadDuplicate.body.data.message, 'invalid duplicate source')
  })

  test('a writeLocation returning false answers 500 failed to write', async (t) => {
    const site = makeOutlineSite(t)
    mockSiteAuth(t, site)
    // the route's failed-to-write path needs writeLocation to answer false
    site.manifest.items[0].writeLocation = async () => false
    const res = stubRes()
    await saveOutline(
      outlineReq({
        site: { name: 'demo' },
        items: [
          {
            id: 'item-1',
            title: 'First',
            parent: null,
            order: 0,
            contents: '<p>will fail</p>',
          },
        ],
      }),
      res,
    )
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.data.message, 'failed to write')
  })
})
