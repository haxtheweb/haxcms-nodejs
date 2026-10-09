'use strict'

// Unit tests for the HAXCMSSite surface of src/lib/HAXCMS.js: site creation
// build variants, loading, git operations, alternate-format generation, site
// metadata rendering, node field schema cascade, and the settings forms.
//
// A temp runtime with a seeded _config (marked with .isHAXcmsConfig) is created
// and cwd moved into it BEFORE the first require so config discovery and all
// site writes stay inside the temp tree. Sites are created with the real
// HAXCMS.createSite / HAXCMSSite.newSite code paths (real file copies, real
// git init/commit via GitPlus).
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window), NO
// optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const util = require('node:util')
const childProcess = require('node:child_process')
const sharp = require('sharp')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const BOILERPLATE_SYSTEMSETUP = path.join(REPO_ROOT, 'src', 'boilerplate', 'systemsetup')
const execFile = util.promisify(childProcess.execFile)

const TEST_USER_NAME = 'unit-ops-user'
const TEST_USER_PASSWORD = 'unit-ops-pass'
const GIT_AUTHOR_NAME = 'HAXcms Unit Ops'
const GIT_AUTHOR_EMAIL = 'unit-ops@local.invalid'

const originalCwd = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'haxcms-unit-ops-'))
const runtimeRoot = path.join(tempRoot, 'runtime')
const configRoot = path.join(runtimeRoot, '_config')
const sitesRoot = path.join(runtimeRoot, '_sites')

function seedRuntimeConfig() {
  fs.ensureDirSync(configRoot)
  fs.writeFileSync(path.join(configRoot, '.isHAXcmsConfig'), '')
  const seedFiles = [
    'config.json',
    'my-custom-elements.js',
    'userData.json',
    'config.php',
    '.htaccess',
    '.user-files-htaccess',
  ]
  for (let i = 0; i < seedFiles.length; i++) {
    fs.copySync(
      path.join(BOILERPLATE_SYSTEMSETUP, seedFiles[i]),
      path.join(configRoot, seedFiles[i]),
    )
  }
  fs.ensureDirSync(path.join(configRoot, 'tmp'))
  fs.ensureDirSync(path.join(configRoot, 'cache'))
  fs.ensureDirSync(path.join(configRoot, 'user'))
  fs.ensureDirSync(path.join(configRoot, 'user', 'files'))
  fs.ensureDirSync(path.join(configRoot, 'user', 'skeletons'))
  fs.ensureDirSync(path.join(configRoot, 'skeletons'))
  fs.ensureDirSync(path.join(configRoot, 'settings'))
  fs.ensureDirSync(path.join(configRoot, 'node_modules'))
}

fs.ensureDirSync(sitesRoot)
seedRuntimeConfig()
fs.writeFileSync(
  path.join(configRoot, '.user'),
  JSON.stringify({ name: TEST_USER_NAME, password: TEST_USER_PASSWORD }, null, 2),
)

process.chdir(runtimeRoot)
// HAXCMS.js mixes string concat (HAXCMS_ROOT + sitesDirectory) and path.join,
// so the root env var must carry a trailing slash (mirrors the e2e harness).
process.env.HAXCMS_ROOT = runtimeRoot + '/'
process.env.GIT_AUTHOR_NAME = GIT_AUTHOR_NAME
process.env.GIT_AUTHOR_EMAIL = GIT_AUTHOR_EMAIL
process.env.GIT_COMMITTER_NAME = GIT_AUTHOR_NAME
process.env.GIT_COMMITTER_EMAIL = GIT_AUTHOR_EMAIL

const { HAXCMS, HAXCMSSite, systemStructureContext } = require('../../src/lib/HAXCMS.js')
const JSONOutlineSchema = require('../../src/lib/JSONOutlineSchema.js')

async function runGitCommand(siteName, args) {
  const result = await execFile('git', ['--no-pager'].concat(args), {
    cwd: path.join(sitesRoot, siteName),
    maxBuffer: 1024 * 1024,
  })
  return String(result.stdout || '').trim()
}

test.after(() => {
  process.chdir(originalCwd)
  delete process.env.HAXCMS_ROOT
  fs.removeSync(tempRoot)
})

test('harness writes into a trailing-slash HAXCMS_ROOT', () => {
  assert.ok(process.env.HAXCMS_ROOT.endsWith('/'))
  assert.equal(HAXCMS.HAXCMS_ROOT, runtimeRoot + '/')
})

// ---------------------------------------------------------------------------
// site creation build variants
// ---------------------------------------------------------------------------
test('createSite builds a default site with a welcome page, managed files, and a git repo', async () => {
  const site = await HAXCMS.createSite('unit-site')
  assert.ok(site)
  assert.equal(site.manifest.metadata.site.name, 'unit-site')
  assert.equal(site.manifest.items.length, 1)
  assert.equal(site.manifest.items[0].title, 'Welcome')
  assert.equal(site.manifest.items[0].slug, 'welcome')
  assert.ok(site.manifest.metadata.site.created > 0)
  assert.ok(site.manifest.metadata.site.updated > 0)
  assert.equal(site.manifest.metadata.site.settings.pathauto, true)
  const siteDir = path.join(sitesRoot, 'unit-site')
  assert.ok(fs.statSync(path.join(siteDir, '.git')).isDirectory())
  assert.ok(fs.statSync(path.join(siteDir, 'index.html')).isFile())
  assert.ok(fs.statSync(path.join(siteDir, 'build.js')).isFile())
  assert.ok(fs.statSync(path.join(siteDir, 'robots.txt')).isFile())
  assert.ok(fs.statSync(path.join(siteDir, 'pages', site.manifest.items[0].id, 'index.html')).isFile())
})

test('createSite builds a 6-week course with a welcome page and six lessons', async () => {
  const site = await HAXCMS.createSite('unit-course6w', null, null, {
    structure: 'course',
    type: '6w',
  })
  assert.ok(site)
  assert.equal(site.manifest.items.length, 7)
  assert.equal(site.manifest.items[6].title, 'Lesson 6')
  assert.equal(site.manifest.items[6].slug, 'lesson-6')
})

test('createSite builds a course from imported docx-style items', async () => {
  const site = await HAXCMS.createSite('unit-coursedocx', null, null, {
    structure: 'course',
    type: 'docx import',
    items: [
      {
        parent: null,
        title: 'Imported One',
        slug: 'imported-one',
        id: 'imported-one',
        indent: 0,
        contents: '<p>imported content one</p>',
        order: 1,
        metadata: { tags: 'imported' },
      },
    ],
  })
  assert.ok(site)
  assert.equal(site.manifest.items.length, 2)
  assert.equal(site.manifest.items[1].title, 'Imported One')
  assert.ok(
    fs
      .readFileSync(
        path.join(sitesRoot, 'unit-coursedocx', 'pages', 'imported-one', 'index.html'),
        'utf8',
      )
      .indexOf('imported content one') !== -1,
  )
})

test('createSite builds a blog, website, collection, and training structure', async () => {
  const blog = await HAXCMS.createSite('unit-blog', null, null, { structure: 'blog' })
  assert.equal(blog.manifest.items.length, 3)
  assert.equal(blog.manifest.items[2].slug, 'meet-the-author')
  const website = await HAXCMS.createSite('unit-website', null, null, {
    structure: 'website',
    type: 'personal',
  })
  assert.equal(website.manifest.items.length, 1)
  assert.equal(website.manifest.items[0].slug, 'home')
  const collection = await HAXCMS.createSite('unit-collection', null, null, {
    structure: 'collection',
  })
  assert.equal(collection.manifest.items[0].slug, 'home')
  assert.equal(collection.manifest.items[0].location.indexOf('pages/') === 0, true)
  const training = await HAXCMS.createSite('unit-training', null, null, {
    structure: 'training',
  })
  assert.equal(training.manifest.items[0].slug, 'start')
})

test('createSite builds portfolio structures for art and default types', async () => {
  const art = await HAXCMS.createSite('unit-portfolio-art', null, null, {
    structure: 'portfolio',
    type: 'art',
  })
  assert.equal(art.manifest.items.length, 3)
  assert.equal(art.manifest.items[2].slug, 'meet-the-artist')
  const business = await HAXCMS.createSite('unit-portfolio-biz', null, null, {
    structure: 'portfolio',
    type: 'business',
  })
  assert.equal(business.manifest.items.length, 3)
  assert.equal(business.manifest.items[2].slug, 'meet-the-author')
})

test('createSite builds from a skeleton / import item schema', async () => {
  const site = await HAXCMS.createSite('unit-import', null, null, {
    structure: 'from-skeleton',
    items: [
      {
        parent: null,
        title: 'Skeleton Root',
        slug: 'skeleton-root',
        id: 'skeleton-root',
        indent: 0,
        content: '<p>skeleton root content</p>',
        order: 0,
      },
      {
        parent: 'skeleton-root',
        title: 'Skeleton Child',
        slug: 'skeleton-child',
        id: 'skeleton-child',
        indent: 1,
        contents: '<p>skeleton child content</p>',
        order: 0,
      },
    ],
  })
  assert.ok(site)
  assert.equal(site.manifest.items.length, 2)
  assert.equal(site.manifest.items[1].parent, 'skeleton-root')
  assert.equal(site.manifest.items[1].indent, 1)
})

test('createSite deduplicates a colliding site name with a numeric suffix', async () => {
  const first = await HAXCMS.createSite('unit-dup')
  assert.ok(first)
  const second = await HAXCMS.createSite('unit-dup')
  assert.ok(second)
  assert.equal(second.manifest.metadata.site.name, 'unit-dup-1')
  assert.ok(fs.statSync(path.join(sitesRoot, 'unit-dup-1')).isDirectory())
})

test('createSite derives the github.io domain from git details and writes a CNAME for a custom domain', async () => {
  // git details without a url get replaced by config.site.git, so carry a
  // url through for the github.io derivation to fire
  const ghPages = await HAXCMS.createSite('unit-github', null, {
    user: 'unit-org',
    url: 'git@github.com:unit-org/unit-github.git',
  })
  assert.equal(ghPages.manifest.metadata.site.domain, 'https://unit-org.github.io/unit-github')
  const custom = await HAXCMS.createSite('unit-cname', 'https://custom.example')
  assert.equal(custom.manifest.metadata.site.domain, 'https://custom.example')
  assert.equal(
    fs.readFileSync(path.join(sitesRoot, 'unit-cname', 'CNAME'), 'utf8'),
    'https://custom.example',
  )
})

test('createSite tolerates git details that only carry a remote url', async () => {
  const remote = await HAXCMS.createSite('unit-remote', null, {
    url: 'git@github.com:unit-org/unit-remote.git',
  })
  assert.ok(remote)
  assert.equal(remote.manifest.metadata.site.domain, null)
})

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------
test('loadSite loads an existing site from the file system', async () => {
  const site = await HAXCMS.loadSite('unit-site')
  assert.ok(site)
  assert.equal(site.manifest.metadata.site.name, 'unit-site')
  assert.equal(site.name, 'unit-site')
  assert.equal(site.basePath, '/_sites/')
  assert.ok(site.siteDirectory.indexOf(path.join(sitesRoot, 'unit-site')) !== -1)
})

test('loadSite returns false for a missing site and creates on request', async () => {
  assert.equal(await HAXCMS.loadSite('unit-missing-site'), false)
  const created = await HAXCMS.loadSite('unit-created-site', true)
  assert.ok(created)
  assert.equal(created.manifest.metadata.site.name, 'unit-created-site')
})

test('systemStructureContext loads a single-site directory and returns null elsewhere', async () => {
  const single = await systemStructureContext(path.join(sitesRoot, 'unit-site'))
  assert.ok(single)
  assert.equal(single.manifest.metadata.site.name, 'unit-site')
  assert.equal(await systemStructureContext(path.join(sitesRoot, 'unit-not-a-site')), null)
})

test('HAXCMSSite.load and loadSingle hydrate the manifest directly', async () => {
  const loaded = new HAXCMSSite()
  await loaded.load(sitesRoot, '/_sites/', 'unit-site')
  assert.equal(loaded.manifest.metadata.site.name, 'unit-site')
  assert.equal(loaded.name, 'unit-site')
  const single = new HAXCMSSite()
  await single.loadSingle(path.join(sitesRoot, 'unit-site'))
  assert.equal(single.manifest.metadata.site.name, 'unit-site')
  assert.equal(single.basePath, '/')
})

// ---------------------------------------------------------------------------
// git operations
// ---------------------------------------------------------------------------
test('gitCommit commits site changes and reports success', async () => {
  const site = await HAXCMS.loadSite('unit-site')
  fs.writeFileSync(path.join(site.siteDirectory, 'unit-commit-marker.txt'), 'marker')
  const result = await site.gitCommit('Unit commit: add marker')
  assert.equal(result, true)
  const log = await runGitCommand('unit-site', ['log', '-1', '--pretty=%s'])
  // git-interface quotes the -m message, so the stored subject keeps quotes
  assert.ok(log.indexOf('Unit commit: add marker') !== -1)
})

test('gitCommit sanitizes hostile commit messages', async () => {
  const site = await HAXCMS.loadSite('unit-site')
  fs.writeFileSync(path.join(site.siteDirectory, 'unit-commit-marker.txt'), 'marker2')
  const result = await site.gitCommit("bad'quote\"quote\\back")
  assert.equal(result, true)
  const log = await runGitCommand('unit-site', ['log', '-1', '--pretty=%s'])
  // quotes remain in the stored subject because git-interface quotes -m,
  // so only the sanitized body itself is asserted here
  assert.ok(log.indexOf('badquotequoteback') !== -1)
  assert.ok(log.indexOf("'quote") === -1)
  assert.ok(log.indexOf('\\back') === -1)
})

test('gitCommit attempts a branch checkout and push when autoPush is configured', async () => {
  const site = await HAXCMS.loadSite('unit-site')
  site.manifest.metadata.site.git = {
    autoPush: true,
    branch: 'unit-branch',
  }
  fs.writeFileSync(path.join(site.siteDirectory, 'unit-commit-marker.txt'), 'marker3')
  // push has no remote configured, so the attempt fails internally but the
  // wrapper still resolves true (all git failures are caught)
  assert.equal(await site.gitCommit('Auto push attempt'), true)
  delete site.manifest.metadata.site.git
})

test('gitRevert, gitPush, gitSetRemote, and gitTest resolve without throwing', async () => {
  const site = await HAXCMS.loadSite('unit-site')
  assert.equal(await site.gitRevert(1), true)
  assert.equal(await site.gitPush(), true)
  assert.equal(await site.gitSetRemote({ url: 'git@github.com:unit-org/none.git' }), true)
  const version = await site.gitTest()
  assert.ok(String(version).indexOf('git version') !== -1)
})

// ---------------------------------------------------------------------------
// addPage / node mutation helpers
// ---------------------------------------------------------------------------
test('addPage creates pages with parent, template, order, indent, and metadata', async () => {
  const site = await HAXCMS.loadSite('unit-site')
  const rootPage = site.manifest.items[0]
  const child = await site.addPage(
    rootPage,
    'Child Page',
    'lesson',
    'child-page',
    null,
    null,
    '<p>child body</p>',
    0,
    { tags: 'child' },
  )
  assert.ok(child)
  assert.equal(child.parent, rootPage.id)
  assert.equal(child.indent, rootPage.indent + 1)
  assert.equal(child.order, 0)
  assert.equal(child.slug, 'child-page')
  assert.equal(child.metadata.tags, 'child')
  assert.ok(fs.statSync(path.join(site.siteDirectory, 'pages', child.id, 'index.html')).isFile())
  const stringParentChild = await site.addPage(
    rootPage.id,
    'String Parent Page',
    'default',
    'string-parent',
    null,
    3,
    '<p>body</p>',
    4,
  )
  assert.equal(stringParentChild.parent, rootPage.id)
  assert.equal(stringParentChild.indent, 3)
  assert.equal(stringParentChild.order, 4)
  const topPage = await site.addPage(null, 'Top Page', 'glossary', 'top-page')
  assert.equal(topPage.parent, null)
  assert.equal(topPage.indent, 0)
  const htmlPage = await site.addPage(
    null,
    'HTML Page',
    'html',
    'html-page',
    null,
    null,
    '<p>raw html body</p>',
    null,
    null,
  )
  assert.ok(
    fs
      .readFileSync(path.join(site.siteDirectory, 'pages', htmlPage.id, 'index.html'), 'utf8')
      .indexOf('raw html body') !== -1,
  )
  const unknownTemplatePage = await site.addPage(null, 'Unknown Template', 'bogus-template', 'unknown-template')
  assert.ok(unknownTemplatePage)
})

test('addPage deduplicates a slug that collides with an existing page', async () => {
  const site = await HAXCMS.loadSite('unit-site')
  const duplicate = await site.addPage(null, 'Welcome', 'init', 'welcome')
  assert.ok(duplicate.slug !== 'welcome')
  assert.ok(duplicate.slug.indexOf('welcome-') === 0)
})

test('renamePageLocation moves the page folder then fails on the redundant unlink', async () => {
  const site = await HAXCMS.loadSite('unit-site')
  const page = site.manifest.items[0]
  const oldLocation = page.location
  const newLocation = 'pages/renamed-page/index.html'
  // the folder move succeeds, but the trailing unlink still targets the old
  // file inside the moved folder, so the wrapper rejects with ENOENT
  await assert.rejects(
    () => site.renamePageLocation(oldLocation, newLocation),
    function (err) { return err && err.code === 'ENOENT' },
  )
  assert.ok(fs.statSync(path.join(site.siteDirectory, 'pages', 'renamed-page')).isDirectory())
  assert.equal(fs.pathExistsSync(path.join(site.siteDirectory, oldLocation)), false)
})

test('updateNode and deleteNode mutate the outline and persist it', async () => {
  const site = await HAXCMS.loadSite('unit-site')
  const page = site.manifest.items[0]
  page.title = 'Updated Title'
  const updated = await site.updateNode(page)
  assert.equal(updated.title, 'Updated Title')
  assert.equal(await site.updateNode({ id: 'missing-node', title: 'x' }), false)
  const count = site.manifest.items.length
  assert.equal(await site.deleteNode(site.manifest.items[0]), true)
  assert.equal(site.manifest.items.length, count - 1)
  assert.equal(await site.deleteNode({ id: 'missing-node' }), false)
})

test('changeName is a no-op for the same name and self-renames for a new name', async () => {
  const site = await HAXCMS.loadSite('unit-cname')
  site.manifest.metadata.site.name = '_sites/unit-cname'
  const sameName = await site.changeName('_sites/unit-cname')
  assert.equal(sameName, undefined)
  // the metadata name is set to the new value BEFORE the rename call, so a
  // real rename resolves from the not-yet-existing new name and rejects
  await assert.rejects(
    () => site.changeName('_sites/unit-cname-renamed'),
    function (err) { return err && err.code === 'ENOENT' },
  )
  assert.equal(fs.pathExistsSync(path.join(sitesRoot, 'unit-cname')), true)
  assert.equal(fs.pathExistsSync(path.join(sitesRoot, 'unit-cname-renamed')), false)
})

test('sortItems orders items numerically and lexically in both directions', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const byTitle = site.sortItems('title', 'ASC')
  assert.ok(byTitle.length >= 2)
  assert.equal(byTitle[0].title <= byTitle[1].title, true)
  const byTitleDesc = site.sortItems('title', 'DESC')
  assert.equal(byTitleDesc[0].title >= byTitleDesc[1].title, true)
  const byCreated = site.sortItems('created', 'DESC')
  assert.equal(byCreated.length, byTitle.length)
  const byOrder = site.sortItems('order', 'ASC')
  assert.equal(byOrder.length, byTitle.length)
  assert.equal(site.sortItems('bogus-key', 'ASC').length, byTitle.length)
})

test('treeToNodes renders the outline as a nested link list', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const html = site.treeToNodes(site.manifest.items, [])
  assert.ok(html.indexOf('<ul>') !== -1)
  assert.ok(html.indexOf('Skeleton Root') !== -1)
  assert.ok(html.indexOf('Skeleton Child') !== -1)
})

test('loadNode and loadNodeByLocation resolve items by id and location', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const first = site.manifest.items[0]
  assert.equal(site.loadNode(first.id).id, first.id)
  assert.equal(site.loadNode('missing'), false)
  // loadNodeByLocation walks manifest.files, which JSONOutlineSchema never
  // populates, so every lookup resolves a fresh item instead of a match
  const lookedUp = site.loadNodeByLocation(first.location.replace('/index.html', ''))
  assert.ok(lookedUp && lookedUp.id && lookedUp.id.indexOf('item-') === 0)
  const unmatched = site.loadNodeByLocation('pages/no-such-page')
  assert.ok(unmatched && unmatched.id && unmatched.id.indexOf('item-') === 0)
})

test('getUniqueSlugName builds a pathauto slug from the parent chain', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const child = site.manifest.items[1]
  const parent = site.manifest.items[0]
  const slug = site.getUniqueSlugName('child-slug', child, true)
  assert.equal(slug, parent.slug + '/child-slug')
  assert.equal(site.getUniqueSlugName('/leading-slash'), 'leading-slash')
})

// ---------------------------------------------------------------------------
// alternate formats
// ---------------------------------------------------------------------------
test('updateAlternateFormats writes feeds, sitemap, search index, and llms.txt', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  await site.updateAlternateFormats()
  const dir = site.siteDirectory
  assert.ok(fs.statSync(path.join(dir, 'rss.xml')).isFile())
  assert.ok(fs.statSync(path.join(dir, 'atom.xml')).isFile())
  assert.ok(fs.statSync(path.join(dir, 'sitemap.xml')).isFile())
  assert.ok(fs.statSync(path.join(dir, 'sitemap-index.xml')).isFile())
  assert.ok(fs.statSync(path.join(dir, 'lunrSearchIndex.json')).isFile())
  assert.ok(fs.statSync(path.join(dir, 'llms.txt')).isFile())
  await site.updateAlternateFormats('rss')
  await site.updateAlternateFormats('sitemap')
  await site.updateAlternateFormats('search')
  await site.updateAlternateFormats('llms')
})

test('updateAlternateFormats uses the site domain when configured', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  site.manifest.metadata.site.domain = 'https://unit-website.example'
  await site.updateAlternateFormats()
  const rss = fs.readFileSync(path.join(site.siteDirectory, 'rss.xml'), 'utf8')
  assert.ok(rss.indexOf('https://unit-website.example') !== -1)
})

test('writePageAlternateFormats writes md, json, yaml, and xml sidecars', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const page = site.manifest.items[0]
  const result = await site.writePageAlternateFormats(page, '<p>alternate body</p>')
  assert.equal(result, true)
  const base = path.join(site.siteDirectory, path.dirname(page.location))
  assert.ok(fs.statSync(path.join(base, 'index.md')).isFile())
  assert.ok(fs.statSync(path.join(base, 'index.json')).isFile())
  assert.ok(fs.statSync(path.join(base, 'index.yaml')).isFile())
  assert.ok(fs.statSync(path.join(base, 'index.xml')).isFile())
  const md = fs.readFileSync(path.join(base, 'index.md'), 'utf8')
  assert.ok(md.indexOf('alternate body') !== -1)
  // no-location / no-site variants answer false
  assert.equal(await site.writePageAlternateFormats({ location: '' }), false)
  const pageWithoutContent = { location: page.location }
  assert.equal(await site.writePageAlternateFormats(null, ''), false)
})

test('writePageAlternateFormats reads the page content when html is not supplied', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  const page = site.manifest.items[0]
  const result = await site.writePageAlternateFormats(page)
  assert.equal(result, true)
})

test('getPageAlternatePayload, getPageAlternateLocation, and link tags build variant metadata', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const page = site.manifest.items[0]
  const payload = site.getPageAlternatePayload(page, '<p>x</p>', 'yaml')
  assert.equal(payload.location, page.location.replace('.html', '.yaml'))
  assert.equal(payload.content, '<p>x</p>')
  assert.equal(site.getPageAlternateLocation('', 'md'), '')
  assert.equal(site.getPageAlternateLocation('pages/x/index.html', 'json'), 'pages/x/index.json')
  assert.equal(site.getPageAlternateLocation('pages/x/other', 'JSON'), 'pages/x/other.json')
  assert.equal(site.getPageAlternateLocation('pages\\x\\index.html', 'md'), 'pages/x/index.md')
  const linkTags = site.getPageAlternateLinkTags(page, '/skeleton-root')
  assert.ok(linkTags.indexOf('rel="alternate"') !== -1)
  assert.ok(linkTags.indexOf('/skeleton-root.md') !== -1)
  assert.equal(site.getPageAlternateLinkTags(null), '')
  assert.equal(site.getPageAlternateLinkTags({ slug: 'x' }, ''), '')
  // no canonicalPath: the base path is derived from the slug instead
  const slugDerived = site.getPageAlternateLinkTags(page, '')
  assert.ok(slugDerived.indexOf('/skeleton-root.md') !== -1)
})

test('getPageAlternateXML serializes payloads with escaped values and cdata content', () => {
  const site = new HAXCMSSite()
  const xml = site.getPageAlternateXML({
    title: 'A <b>title</b>',
    content: 'has ]]> inside',
    meta: { nested: 'value' },
    list: ['one', 'two'],
    nothing: null,
    '123numeric': 'n',
  })
  assert.ok(xml.indexOf('<?xml version="1.0"') !== -1)
  assert.ok(xml.indexOf('<title>') !== -1)
  assert.ok(xml.indexOf('A &lt;b&gt;title&lt;/b&gt;') !== -1)
  assert.ok(xml.indexOf('<![CDATA[has ]]]]><![CDATA[> inside]]>') !== -1)
  assert.ok(xml.indexOf('<meta>') !== -1)
  assert.ok(xml.indexOf('<list>') !== -1)
  assert.ok(xml.indexOf('<nothing></nothing>') !== -1)
  assert.ok(xml.indexOf('<item-123numeric>') !== -1)
})

test('getSafeXMLTagName and getSafeCDATA normalize hostile names and content', () => {
  const site = new HAXCMSSite()
  assert.equal(site.getSafeXMLTagName('valid-name_1'), 'valid-name_1')
  assert.equal(site.getSafeXMLTagName(''), 'item')
  assert.equal(site.getSafeXMLTagName('!!!'), '---')
  assert.equal(site.getSafeXMLTagName('9leading'), 'item-9leading')
  assert.equal(site.getSafeXMLTagName('spaces in name'), 'spaces-in-name')
  assert.equal(site.getSafeCDATA('break ]]> out'), 'break ]]]]><![CDATA[> out')
  assert.equal(site.getSafeCDATA(null), 'null')
})

test('getPageContent reads the page body and filters it', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const page = site.manifest.items[0]
  const content = await site.getPageContent(page)
  assert.ok(typeof content === 'string')
  assert.ok(content.length > 0)
  assert.equal(await site.getPageContent({ location: '' }), undefined)
})

test('llms.txt helpers normalize titles, links, and URLs', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const llms = site.getLLMSTxt('https://unit.example')
  assert.ok(llms.indexOf('# ') === 0)
  assert.ok(llms.indexOf('## Pages') !== -1)
  assert.ok(llms.indexOf('https://unit.example/site.json') !== -1)
  assert.ok(llms.indexOf('Skeleton Root') !== -1)
  assert.equal(site.getLLMSResourceURL('', ''), '/')
  assert.equal(site.getLLMSResourceURL('/', 'llms.txt'), '/llms.txt')
  assert.equal(site.getLLMSResourceURL('https://x.example', 'llms.txt'), 'https://x.example/llms.txt')
  assert.equal(site.getLLMSResourceURL('relative', 'llms.txt'), '/relative/llms.txt')
  assert.equal(site.getLLMSBaseURL('https://x.example'), 'https://x.example/')
  assert.equal(site.getLLMSBaseURL('x'), '/x/')
  assert.equal(site.getLLMSBaseURL('/y'), '/y/')
  assert.equal(site.getLLMSSafeText(' multi\nline\rtext  '), 'multi line text')
  assert.equal(site.getLLMSSafeText(null), '')
  assert.equal(site.getLLMSSafeLinkText('[bracket]'), '\\[bracket\\]')
  assert.equal(site.getLLMSSafeLinkText(''), 'Untitled page')
  const empty = new HAXCMSSite()
  empty.manifest = new JSONOutlineSchema()
  empty.manifest.items = []
  empty.manifest.title = ''
  empty.name = ''
  const fallbackText = empty.getLLMSTxt('')
  assert.ok(fallbackText.indexOf('# HAXcms site') !== -1)
  assert.ok(fallbackText.indexOf('No page markdown files are currently available') !== -1)
})

// haxtheweb/issues#3116
test('llms.txt links AGENTS.md only when the site has one', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const agentsPath = path.join(site.siteDirectory, 'AGENTS.md')
  const hadAgents = fs.existsSync(agentsPath)
  const original = hadAgents ? fs.readFileSync(agentsPath) : null
  try {
    fs.writeFileSync(agentsPath, '# AGENTS.md\n')
    assert.ok(site.getLLMSTxt('https://unit.example').indexOf('[AGENTS.md](https://unit.example/AGENTS.md)') !== -1)
    fs.removeSync(agentsPath)
    assert.equal(site.getLLMSTxt('https://unit.example').indexOf('AGENTS.md'), -1)
  } finally {
    if (hadAgents) {
      fs.writeFileSync(agentsPath, original)
    }
  }
})

// haxtheweb/issues#3116
test('gitFallbackIdentity supplies and then restores a placeholder identity', async () => {
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
  const saved = {}
  keys.forEach((key) => { saved[key] = process.env[key] })
  const repo = fs.mkdtempSync(path.join(tempRoot, 'noident-'))
  const originalWarn = console.warn
  const warnings = []
  console.warn = (msg) => { warnings.push(String(msg)) }
  try {
    keys.forEach((key) => { delete process.env[key] })
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CONFIG_GLOBAL = path.join(repo, 'empty-gitconfig')
    await execFile('git', ['init', '-q'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
    await execFile('git', ['add', 'a.txt'], { cwd: repo })
    const restore = await new HAXCMSSite().gitFallbackIdentity(repo)
    assert.equal(process.env.GIT_AUTHOR_EMAIL, 'haxcms@localhost')
    await execFile('git', ['commit', '-q', '-m', 'first'], { cwd: repo })
    restore()
    assert.equal(process.env.GIT_AUTHOR_EMAIL, undefined)
    const log = await execFile('git', ['log', '--format=%an <%ae>'], { cwd: repo })
    assert.equal(log.stdout.trim(), 'HAXcms <haxcms@localhost>')
    assert.equal(warnings.length, 1)
    // a configured identity is left alone
    warnings.length = 0
    process.env.GIT_AUTHOR_NAME = 'Someone'
    process.env.GIT_COMMITTER_NAME = 'Someone'
    process.env.GIT_AUTHOR_EMAIL = 'someone@local.invalid'
    process.env.GIT_COMMITTER_EMAIL = 'someone@local.invalid'
    const noop = await new HAXCMSSite().gitFallbackIdentity(repo)
    noop()
    assert.equal(process.env.GIT_AUTHOR_EMAIL, 'someone@local.invalid')
    assert.equal(warnings.length, 0)
  } finally {
    console.warn = originalWarn
    keys.forEach((key) => {
      if (saved[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved[key]
      }
    })
  }
})

test('lunrSearchIndex and cleanSearchData build the search corpus', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const index = await site.lunrSearchIndex(site.manifest.items)
  assert.ok(Array.isArray(index))
  assert.ok(index.length > 0)
  assert.ok(typeof index[0].text === 'string')
  assert.equal(site.cleanSearchData(''), '')
  assert.equal(site.cleanSearchData(null), '')
  const cleaned = site.cleanSearchData('<p>Hello   world</p>\nunique unique words')
  assert.ok(cleaned.indexOf('<') === -1)
})

// ---------------------------------------------------------------------------
// site metadata rendering
// ---------------------------------------------------------------------------
test('getSiteMetadata renders head tags, structured data, and social metadata', async () => {
  const site = await HAXCMS.loadSite('unit-import')
  const page = site.manifest.items[0]
  const metadata = await site.getSiteMetadata(page, 'https://unit.example', '', '/skeleton-root')
  assert.ok(metadata.indexOf('<meta charset="utf-8"') !== -1)
  assert.ok(metadata.indexOf('<link rel="canonical" href="https://unit.example/skeleton-root" />') !== -1)
  assert.ok(metadata.indexOf('<title>') !== -1)
  assert.ok(metadata.indexOf('application/ld+json') !== -1)
  assert.ok(metadata.indexOf('BreadcrumbList') !== -1)
  assert.ok(metadata.indexOf('robots') !== -1)
})

test('getSiteMetadata renders prev/next links for a middle page', async () => {
  const site = await HAXCMS.loadSite('unit-blog')
  const middle = site.manifest.items[1]
  const metadata = await site.getSiteMetadata(middle, 'https://unit.example')
  assert.ok(metadata.indexOf('<link rel="prev"') !== -1)
  const last = site.manifest.items[2]
  const lastMetadata = await site.getSiteMetadata(last, 'https://unit.example')
  assert.ok(lastMetadata.indexOf('<link rel="prev"') !== -1)
})

test('getSiteMetadata flags private sites with robots none and skips the canonical link when disabled', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  site.manifest.metadata.site.settings.private = true
  site.manifest.metadata.site.settings.canonical = false
  const metadata = await site.getSiteMetadata(null, 'https://unit.example')
  assert.ok(metadata.indexOf('content="none"') !== -1)
  assert.equal(metadata.indexOf('<link rel="canonical"'), -1)
  site.manifest.metadata.site.settings.private = false
  site.manifest.metadata.site.settings.canonical = true
  site.manifest.metadata.site.domain = 'https://unit-website.example'
  const canonical = await site.getSiteMetadata(
    { slug: 'home', id: null },
    'https://unit.example',
  )
  assert.ok(canonical.indexOf('<link rel="canonical"') !== -1)
})

test('getSiteMetadata resolves author data from manifest metadata and string authors', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  site.manifest.metadata.author = {
    name: 'Meta Author',
    email: 'meta@example.com',
    socialLink: 'https://twitter.com/meta-author',
    image: 'files/author.png',
  }
  const meta = await site.getSiteMetadata(null, 'https://unit.example')
  assert.ok(meta.indexOf('"name":"Meta Author"') !== -1 || meta.indexOf('Meta Author') !== -1)
  assert.ok(meta.indexOf('twitter:creator') !== -1)
  assert.ok(meta.indexOf('@meta-author') !== -1)
  site.manifest.metadata.author = {}
  site.manifest.author = 'String Author'
  const stringAuthorMeta = await site.getSiteMetadata(null, 'https://unit.example')
  assert.ok(stringAuthorMeta.indexOf('String Author') !== -1)
  site.manifest.author = { name: 'Object Author', email: 'obj@example.com' }
  site.manifest.metadata.author = { socialLink: 'https://x.com/object-author' }
  const objectAuthorMeta = await site.getSiteMetadata(null, 'https://unit.example')
  assert.ok(objectAuthorMeta.indexOf('Object Author') !== -1)
  assert.ok(objectAuthorMeta.indexOf('@object-author') !== -1)
})

test('getSiteMetadata honors theme hex codes and cdn preconnect', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  site.manifest.metadata.theme.variables = { hexCode: '#123456' }
  const meta = await site.getSiteMetadata(null, 'https://unit.example')
  assert.ok(meta.indexOf('#123456') !== -1)
  const cdnMeta = await site.getSiteMetadata(null, 'https://unit.example', 'https://cdn.example')
  assert.ok(cdnMeta.indexOf('https://cdn.example') !== -1)
  assert.ok(cdnMeta.indexOf('<link rel="preconnect" crossorigin href="https://cdn.example" />') !== -1)
})

test('getSiteMetadata emits verbatim hints for custom themes and registry-prefixed hints for registry themes', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  const originalThemePath = site.manifest.metadata.theme.path
  // registry theme keeps the base + build/es6/node_modules/ prefix on both hints
  site.manifest.metadata.theme.path = '@haxtheweb/clean-two/clean-two.js'
  const registryMeta = await site.getSiteMetadata(null, 'https://unit.example')
  assert.ok(
    registryMeta.indexOf(
      '<link rel="modulepreload" href="./build/es6/node_modules/@haxtheweb/clean-two/clean-two.js"',
    ) !== -1,
  )
  assert.ok(
    registryMeta.indexOf(
      '<link rel="preload" href="./build/es6/node_modules/@haxtheweb/clean-two/clean-two.js"',
    ) !== -1,
  )
  // custom theme: site-relative path is emitted verbatim, never mangled
  site.manifest.metadata.theme.path = './custom/build/custom.es6.js'
  const customMeta = await site.getSiteMetadata(null, 'https://unit.example')
  assert.ok(
    customMeta.indexOf('<link rel="modulepreload" href="./custom/build/custom.es6.js"') !== -1,
  )
  assert.ok(
    customMeta.indexOf('<link rel="preload" href="./custom/build/custom.es6.js"') !== -1,
  )
  assert.equal(customMeta.indexOf('build/es6/node_modules/./custom'), -1)
  assert.equal(customMeta.indexOf('build/es6/node_modules/custom/'), -1)
  // the shell helper only admits registry-relative theme paths
  assert.equal(
    HAXCMS.buildShellModulepreloadPaths(
      site,
      './',
      './custom/build/custom.es6.js',
    ).indexOf('./custom/build/custom.es6.js'),
    -1,
  )
  assert.ok(
    HAXCMS.buildShellModulepreloadPaths(
      site,
      './',
      '@haxtheweb/clean-two/clean-two.js',
    ).indexOf('@haxtheweb/clean-two/clean-two.js') !== -1,
  )
  site.manifest.metadata.theme.path = originalThemePath
})

test('getSiteMetadata uses the site domain for canonical and og urls', async () => {
  const site = await HAXCMS.loadSite('unit-training')
  site.manifest.metadata.site.domain = 'https://unit-training.example'
  site.manifest.metadata.site.settings.canonical = true
  const page = site.manifest.items[0]
  const meta = await site.getSiteMetadata(page, 'https://ignored.example', '', '')
  assert.ok(meta.indexOf('https://unit-training.example/start') !== -1)
})

test('getSitePageAttributes, getBaseTag, and service worker helpers', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  assert.ok(site.getSitePageAttributes().indexOf('oer:http://oerschema.org') !== -1)
  assert.ok(site.getBaseTag().indexOf('<base href="') !== -1)
  assert.equal(site.getForceUpgrade(), 'false')
  assert.equal(site.getServiceWorkerStatus(), false)
  const sw = site.getServiceWorkerScript()
  assert.ok(sw.indexOf('serviceWorker') !== -1)
  const disabled = site.getServiceWorkerScript(null, false, false)
  assert.ok(disabled.indexOf('Service worker disabled') !== -1)
  const explicit = site.getServiceWorkerScript('/custom-scope/', true, true)
  assert.ok(explicit.indexOf('/custom-scope/') !== -1)
})

test('getDefaultSiteBasePath and getPWAScopePath resolve base paths', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  assert.equal(site.getDefaultSiteBasePath(), '/_sites/unit-website/')
  site.manifest.metadata.site.domain = 'https://unit-website.example'
  assert.equal(site.getPWAScopePath(), '/')
  site.manifest.metadata.site.domain = null
  assert.equal(site.getPWAScopePath(), '/_sites/unit-website/')
})

test('getSocialShareImage resolves legacy file shapes and the theme banner', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  const page = site.manifest.items[0]
  page.metadata.files = [
    { type: 'image/png', fullUrl: 'files/legacy-image.png' },
  ]
  const legacyImage = site.getSocialShareImage(page)
  assert.equal(legacyImage, 'files/legacy-image.png')
  page.metadata.files = ['unknown-uuid-shape']
  const uuidMiss = site.getSocialShareImage(page)
  assert.notEqual(uuidMiss, 'files/legacy-image.png')
  site.manifest.metadata.theme.variables = { image: 'files/theme-banner.png' }
  // a bare object (not null) skips the broken loadNodeByLocation path
  assert.equal(site.getSocialShareImage({}), 'files/theme-banner.png')
})

test('getLogoSize falls back to the default icon and resizes a configured logo', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  assert.equal(await site.getLogoSize('16', '16'), 'assets/icon-16x16.png')
  const logoPath = path.join(site.siteDirectory, 'files', 'unit-logo.png')
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#ff0000' },
  })
    .png()
    .toFile(logoPath)
  site.manifest.metadata.site.logo = 'files/unit-logo.png'
  const resized = await site.getLogoSize('32', '32')
  assert.equal(resized, 'files/haxcms-managed/32x32-unit-logo.png')
  assert.ok(fs.statSync(path.join(site.siteDirectory, resized)).isFile())
})

// ---------------------------------------------------------------------------
// managed files + legacy bootstrap upgrade
// ---------------------------------------------------------------------------
test('rebuildManagedFiles re-renders the managed template set', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  fs.writeFileSync(path.join(site.siteDirectory, 'index.html'), 'overwrite me')
  await site.rebuildManagedFiles()
  const indexHtml = fs.readFileSync(path.join(site.siteDirectory, 'index.html'), 'utf8')
  assert.ok(indexHtml.indexOf('overwrite me') === -1)
  assert.ok(indexHtml.indexOf('<') !== -1)
})

test('maybeUpgradeLegacyBootstrap rebuilds managed files when a legacy bootstrap is detected', async () => {
  const legacy = await HAXCMS.createSite('unit-legacy')
  fs.writeFileSync(
    path.join(legacy.siteDirectory, 'index.html'),
    '<html><head>@lrnwebcomponents legacy</head><body>legacy</body></html>',
  )
  await legacy.maybeUpgradeLegacyBootstrap()
  const upgraded = fs.readFileSync(path.join(legacy.siteDirectory, 'index.html'), 'utf8')
  assert.ok(upgraded.indexOf('@lrnwebcomponents') === -1)
})

test('maybeUpgradeLegacyBootstrap is a no-op without the legacy tell', async () => {
  const site = await HAXCMS.loadSite('unit-legacy')
  await site.maybeUpgradeLegacyBootstrap()
  assert.ok(fs.statSync(path.join(site.siteDirectory, 'index.html')).isFile())
})

// ---------------------------------------------------------------------------
// node field schema cascade + settings forms
// ---------------------------------------------------------------------------
test('loadNodeFieldSchema walks the core cascade then rejects on the undeclared response', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  const page = site.manifest.items[0]
  // class bodies run in strict mode, so the undeclared `response` global at
  // the end of loadNodeFieldSchema rejects; the field walk itself still runs
  await assert.rejects(
    () => site.loadNodeFieldSchema(page),
    function (err) { return err instanceof ReferenceError && err.message.indexOf('response') !== -1 },
  )
})

test('loadNodeFieldSchema cascade branches currently reject on the object-initial push', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  const page = site.manifest.items[0]
  // fields.configure / fields.advanced are object-initialized but merged
  // with Array.push, so any config / theme / site field set that declares
  // configure or advanced rejects; documented here until that is fixed.
  HAXCMS.config.node.fields = {
    configure: { unitConfigField: { property: 'unitConfigField' } },
  }
  try {
    await assert.rejects(() => site.loadNodeFieldSchema(page))
  }
  finally {
    delete HAXCMS.config.node.fields
  }
  const themeFieldsDir = path.join(runtimeRoot, 'build', 'es6', 'node_modules')
  fs.ensureDirSync(themeFieldsDir)
  fs.writeFileSync(
    path.join(themeFieldsDir, 'unit-theme-fields.json'),
    JSON.stringify({
      configure: { unitThemeField: { property: 'unitThemeField' } },
    }),
  )
  site.manifest.metadata.theme.fields = 'unit-theme-fields.json'
  try {
    await assert.rejects(() => site.loadNodeFieldSchema(page))
  }
  finally {
    delete site.manifest.metadata.theme.fields
  }
  site.manifest.metadata.node.fields = {
    configure: { unitSiteField: { property: 'unitSiteField' } },
  }
  try {
    await assert.rejects(() => site.loadNodeFieldSchema(page))
  }
  finally {
    delete site.manifest.metadata.node.fields
  }
})

test('siteSettingsForm and siteSettingsValue resolve the settings form and values', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  site.manifest.metadata.theme.variables = {
    cssVariable: '--simple-colors-default-theme-primary-7',
  }
  site.manifest.metadata.theme.regions = { header: 'pages/region-node/index.html' }
  // siteSettingsValue loads a fresh manifest from disk, so persist the
  // mutations first for the deep lookups to resolve against them
  await site.save()
  const form = await HAXCMS.siteSettingsForm({ site: { name: 'unit-website' } })
  assert.ok(form)
  const value = await HAXCMS.siteSettingsValue({ site: { name: 'unit-website' } })
  assert.ok(value)
  assert.equal(value['manifest']['site']['manifest-title'], 'unit-website')
  assert.equal(
    value['manifest']['theme']['manifest-metadata-theme-variables-cssVariable'],
    'primary',
  )
  const regions = value['manifest']['theme']['regions']
  assert.ok(regions['manifest-metadata-theme-regions-header'])
  assert.ok(Array.isArray(regions['manifest-metadata-theme-regions-header']))
})

// ---------------------------------------------------------------------------
// style guide save
// ---------------------------------------------------------------------------
test('handleStyleGuideSave validates body content and persists a valid style guide', async () => {
  const site = await HAXCMS.loadSite('unit-blog')
  const missing = await site.handleStyleGuideSave({})
  assert.equal(missing.status, 400)
  assert.equal(missing.data.message, 'Content parameter is required')
  const notString = await site.handleStyleGuideSave({ node: { body: 42 } })
  assert.equal(notString.status, 400)
  assert.equal(notString.data.message, 'Content must be a string')
  const empty = await site.handleStyleGuideSave({ node: { body: '   ' } })
  assert.equal(empty.status, 400)
  assert.equal(empty.data.message, 'Content cannot be empty')
  const notHtml = await site.handleStyleGuideSave({ node: { body: 'no tags here' } })
  assert.equal(notHtml.status, 400)
  assert.equal(notHtml.data.message, 'Content must be valid HTML')
  const saved = await site.handleStyleGuideSave({ node: { body: '<div>style guide</div>' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.file, 'theme/style-guide.html')
  assert.ok(
    fs
      .readFileSync(path.join(site.siteDirectory, 'theme', 'style-guide.html'), 'utf8')
      .indexOf('style guide') !== -1,
  )
})

test('handleStyleGuideSave rejects an externally configured style guide', async () => {
  const site = await HAXCMS.loadSite('unit-blog')
  site.manifest.metadata.theme.styleGuide = 'https://external.example/guide.html'
  const blocked = await site.handleStyleGuideSave({ node: { body: '<div>blocked</div>' } })
  assert.equal(blocked.status, 403)
  assert.equal(
    blocked.data.message,
    'Style guide is configured to use external source. Cannot edit through HAXcms.',
  )
})

// ---------------------------------------------------------------------------
// itemFromParams + save
// ---------------------------------------------------------------------------
test('itemFromParams slugs from the title when no location was supplied', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  const item = site.itemFromParams({
    node: { title: 'Title Only Page', id: 'title-only' },
    parent: '',
    description: '',
    metadata: null,
  })
  assert.equal(item.parent, null)
  assert.ok(item.slug.indexOf('title-only-page') === 0)
})

test('save persists the manifest with and without reordering', async () => {
  const site = await HAXCMS.loadSite('unit-website')
  site.manifest.items[0].title = 'Saved Title'
  await site.save()
  await site.save(false)
  const reloaded = await HAXCMS.loadSite('unit-website')
  assert.equal(reloaded.manifest.items[0].title, 'Saved Title')
})

test('getManagedTemplateFiles lists the managed file map', async () => {
  const site = new HAXCMSSite()
  const templates = site.getManagedTemplateFiles()
  assert.equal(templates['index'], 'index.html')
  assert.equal(templates['sw'], 'service-worker.js')
  assert.equal(templates['404'], '404.html')
  assert.equal(templates['fileshtaccess'], 'files/.htaccess')
})
