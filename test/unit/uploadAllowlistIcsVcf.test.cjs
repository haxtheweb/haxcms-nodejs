'use strict'

// Unit tests for accepting .ics calendars and .vcf contact cards as uploads
// (haxtheweb/issues#2941).
//
// Both formats are plain text, so they are gated by the same three things as
// every other allowed type: the upload extension allowlist, the bulk-import
// extension allowlist, and the extension -> MIME table checked against the
// type sniffed from the file's own bytes. The tests below go through
// importBuildFile, which is the real bulk-import path (safeFetch -> staging ->
// HAXCMSFile.save -> files.json), so the whole chain is exercised rather than
// the regexes in isolation.
//
// The security case worth pinning: a calendar or card that carries HTML markup
// sniffs as text/html, which is deliberately absent from both new MIME
// entries, so it is rejected instead of being stored and later served.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const safeFetchMod = require('../../src/lib/safeFetch.js')
const { HAXCMS, HAXCMSSite } = require('../../src/lib/HAXCMS.js')
const HAXCMSFile = require('../../src/lib/HAXCMSFile.js')
const createSite = require('../../src/systemRoutes/v1/routes/createSite.js')
const EntityRegistry = require('../../src/lib/EntityRegistry.js')
const FileStorage = require('../../src/lib/FileStorage.js')

const { importBuildFile } = createSite

// the sample files from haxtheweb/issues#2941
const ICS = Buffer.from(
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Example Corp//Example Calendar//EN',
    'BEGIN:VEVENT',
    'UID:uid-1234567890@example.com',
    'DTSTART:20261015T180000Z',
    'DTEND:20261015T190000Z',
    'SUMMARY:Project Kickoff Meeting',
    'LOCATION:Conference Room A',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n'),
  'utf8',
)

const VCF = Buffer.from(
  [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Doe;John;Q.,Public',
    'FN;CHARSET=UTF-8:John Doe',
    'TEL;TYPE=WORK,VOICE:(111) 555-1212',
    'EMAIL;TYPE=PREF,INTERNET:forrestgump@example.com',
    'END:VCARD',
    '',
  ].join('\r\n'),
  'utf8',
)

// a card whose NOTE smuggles markup; the sniffer reports text/html for it
const VCF_WITH_MARKUP = Buffer.from(
  [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Hostile Card',
    'NOTE:<html><body><script>alert(1)</script></body></html>',
    'END:VCARD',
    '',
  ].join('\r\n'),
  'utf8',
)

describe('ics/vcf upload allowlist — haxtheweb/issues#2941', () => {
  const realSafeFetch = safeFetchMod.safeFetch
  const realConfigDirectory = HAXCMS.configDirectory
  let tmpRoot
  let stagingRoot
  let site

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hax-icsvcf-'))
    HAXCMS.configDirectory = path.join(tmpRoot, 'config')
    stagingRoot = path.join(HAXCMS.configDirectory, 'tmp', 'imports')
    await fs.ensureDir(stagingRoot)
    site = new HAXCMSSite()
    site.name = 'testsite'
    site.siteDirectory = path.join(tmpRoot, 'testsite')
    await fs.ensureDir(path.join(site.siteDirectory, 'files'))
    site.manifest = {
      metadata: { site: { name: 'testsite' } },
      items: [],
      save: async function () {
        return true
      },
    }
  })

  afterEach(async () => {
    safeFetchMod.safeFetch = realSafeFetch
    HAXCMS.configDirectory = realConfigDirectory
    try {
      await fs.remove(tmpRoot)
    } catch (e) {}
  })

  function stubNetwork(responses) {
    safeFetchMod.safeFetch = async function (url) {
      const entry = responses[url]
      const status = entry ? entry.status || 200 : 404
      const body = entry && entry.body ? entry.body : Buffer.alloc(0)
      return {
        ok: status >= 200 && status < 300,
        status: status,
        headers: { get: function () { return null } },
        arrayBuffer: async function () { return body },
      }
    }
  }

  function entityAt(relativePath) {
    const fileStorage = FileStorage.registerOn(new EntityRegistry(site))
    const record = fileStorage.getDataStore().getByPath(relativePath)
    return record ? fileStorage.load(record.uuid) : null
  }

  describe('the MIME table', () => {
    test('a calendar accepts the registered calendar types and plain text', () => {
      const allowed = HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['ics']
      assert.ok(allowed, 'ics has an entry')
      assert.deepEqual(allowed, [
        'text/calendar',
        'text/x-vcalendar',
        'text/plain',
      ])
    })

    test('a contact card accepts the registered card types and plain text', () => {
      const allowed = HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['vcf']
      assert.ok(allowed, 'vcf has an entry')
      assert.deepEqual(allowed, [
        'text/vcard',
        'text/x-vcard',
        'text/directory',
        'text/plain',
      ])
    })

    test('neither type accepts html', () => {
      assert.equal(
        HAXCMSFile.mimeMatchesAllowed(
          'text/html',
          HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['ics'],
        ),
        false,
      )
      assert.equal(
        HAXCMSFile.mimeMatchesAllowed(
          'text/html',
          HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['vcf'],
        ),
        false,
      )
    })

    test('adding these did not open up executables', () => {
      assert.equal(HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['php'], undefined)
      assert.equal(HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['phar'], undefined)
      assert.equal(HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['exe'], undefined)
    })
  })

  describe('what the sniffer reports for these files', () => {
    test('a real calendar sniffs as plain text, which the table allows', async () => {
      const staged = path.join(stagingRoot, 'probe.ics')
      await fs.writeFile(staged, ICS)
      const detected = HAXCMSFile.detectMimeTypeFromContent(staged)
      assert.equal(detected, 'text/plain')
      assert.equal(
        HAXCMSFile.mimeMatchesAllowed(
          detected,
          HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['ics'],
        ),
        true,
      )
    })

    test('a real contact card sniffs as plain text, which the table allows', async () => {
      const staged = path.join(stagingRoot, 'probe.vcf')
      await fs.writeFile(staged, VCF)
      const detected = HAXCMSFile.detectMimeTypeFromContent(staged)
      assert.equal(detected, 'text/plain')
      assert.equal(
        HAXCMSFile.mimeMatchesAllowed(
          detected,
          HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['vcf'],
        ),
        true,
      )
    })

    test('a card carrying markup sniffs as html, which the table does not allow', async () => {
      const staged = path.join(stagingRoot, 'hostile.vcf')
      await fs.writeFile(staged, VCF_WITH_MARKUP)
      const detected = HAXCMSFile.detectMimeTypeFromContent(staged)
      assert.equal(detected, 'text/html')
      assert.equal(
        HAXCMSFile.mimeMatchesAllowed(
          detected,
          HAXCMSFile.ALLOWED_MIME_BY_EXTENSION['vcf'],
        ),
        false,
      )
    })
  })

  describe('through the bulk import path', () => {
    test('a calendar is imported and recorded in files.json', async () => {
      stubNetwork({ 'https://example.org/schedule.ics': { body: ICS } })
      assert.equal(
        await importBuildFile(
          site,
          'files/schedule.ics',
          'https://example.org/schedule.ics',
          0,
        ),
        true,
      )
      const entity = entityAt('files/schedule.ics')
      assert.ok(entity, 'files.json records the calendar')
      assert.ok(
        fs.existsSync(path.join(site.siteDirectory, 'files', 'schedule.ics')),
        'the calendar physically lives in files/',
      )
      assert.equal(
        fs.readFileSync(
          path.join(site.siteDirectory, 'files', 'schedule.ics'),
          'utf8',
        ),
        ICS.toString('utf8'),
        'the file is stored byte for byte, not rewritten',
      )
    })

    test('a contact card is imported and recorded in files.json', async () => {
      stubNetwork({ 'https://example.org/directory.vcf': { body: VCF } })
      assert.equal(
        await importBuildFile(
          site,
          'files/directory.vcf',
          'https://example.org/directory.vcf',
          0,
        ),
        true,
      )
      assert.ok(entityAt('files/directory.vcf'), 'files.json records the card')
      assert.ok(
        fs.existsSync(path.join(site.siteDirectory, 'files', 'directory.vcf')),
        'the card physically lives in files/',
      )
    })

    test('a calendar in a nested import path keeps its directory', async () => {
      stubNetwork({ 'https://example.org/a.ics': { body: ICS } })
      assert.equal(
        await importBuildFile(
          site,
          'files/calendars/term.ics',
          'https://example.org/a.ics',
          0,
        ),
        true,
      )
      assert.ok(
        fs.existsSync(
          path.join(site.siteDirectory, 'files', 'calendars', 'term.ics'),
        ),
        'nested calendar lands at files/calendars/term.ics',
      )
    })

    test('a card carrying markup is never stored', async () => {
      stubNetwork({ 'https://example.org/hostile.vcf': { body: VCF_WITH_MARKUP } })
      await importBuildFile(
        site,
        'files/hostile.vcf',
        'https://example.org/hostile.vcf',
        0,
      )
      // what matters is that the save was refused and nothing reached the
      // site. importBuildFile's own return value is not asserted here: it
      // reports true for any file that downloaded, even when HAXCMSFile.save
      // then refused it, which is existing behaviour for every type rather
      // than anything these two extensions introduce
      assert.equal(
        fs.existsSync(path.join(site.siteDirectory, 'files', 'hostile.vcf')),
        false,
        'a card whose content sniffs as html is not written to the site',
      )
      assert.equal(entityAt('files/hostile.vcf'), null, 'and is not recorded')
    })

    test('a calendar carrying markup is never stored either', async () => {
      const icsWithMarkup = Buffer.from(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'DTSTART:20261015T180000Z',
          'SUMMARY:<html><body>nope</body></html>',
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
        'utf8',
      )
      stubNetwork({ 'https://example.org/hostile.ics': { body: icsWithMarkup } })
      await importBuildFile(
        site,
        'files/hostile.ics',
        'https://example.org/hostile.ics',
        0,
      )
      assert.equal(
        fs.existsSync(path.join(site.siteDirectory, 'files', 'hostile.ics')),
        false,
        'a calendar whose content sniffs as html is not written to the site',
      )
      assert.equal(entityAt('files/hostile.ics'), null, 'and is not recorded')
    })

    test('an executable is still refused', async () => {
      stubNetwork({ 'https://example.org/evil.php': { body: ICS } })
      assert.equal(
        await importBuildFile(
          site,
          'files/evil.php',
          'https://example.org/evil.php',
          0,
        ),
        false,
      )
      assert.equal(
        fs.existsSync(path.join(site.siteDirectory, 'files', 'evil.php')),
        false,
      )
    })

    test('an extension that is still not on the list is refused', async () => {
      stubNetwork({ 'https://example.org/notes.ical': { body: ICS } })
      assert.equal(
        await importBuildFile(
          site,
          'files/notes.ical',
          'https://example.org/notes.ical',
          0,
        ),
        false,
        '.ical is a different extension and was not added',
      )
    })
  })
})
