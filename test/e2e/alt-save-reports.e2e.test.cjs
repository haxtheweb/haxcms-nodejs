"use strict";

// E2E test: Reports > Accessibility saves alt text through the block
// operations API (haxtheweb/issues#3270, phase 3 in haxtheweb/issues#3321).
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login -> create
// HAXSITEAUTOMATEDTESTING -> add two pages with images that have no alt ->
// open Reports > Accessibility (?admin=admin-reports-accessibility) and:
//   1. edit the alt of an img and a media-image, Save: the page file differs
//      only in those alt attributes, one git commit ends "Alt text from
//      Reports", the revisions list shows it, and restoring the revision
//      before it brings back the original bytes;
//   2. change the page on disk after the scan: the row ends Not saved and
//      the file is left as it was;
//   3. lock the page: its row ends Not saved, saying the page is locked;
//   4. set the block change limit to 2: the first page saves, the second is
//      refused with the limit message and stays edited, and a second click
//      after the window saves it;
//   5. axe scans of the confirm panel and the result rows.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining, node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const {
  setupE2ERuntime,
  teardownE2ERuntime,
  launchBrowser,
  newPage,
  createResponseCollector,
  runA11y,
  FIXED_SITE_NAME,
  waitFor,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  loginViaUI,
  createSiteViaUI,
} = require("./helpers");

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase();
const SITES_DIR = "_sites";
const NOTE = "Alt text from Reports";

const PAGE_ONE = {
  title: "Alt page one",
  slug: "alt-page-one",
  content:
    "<p>Images without alt.</p>" +
    '<img src="files/one.png">' +
    '<media-image source="files/two.png"></media-image>',
};
const PAGE_TWO = {
  title: "Alt page two",
  slug: "alt-page-two",
  content: '<p>One more.</p><img src="files/three.png">',
};

let runtime = null;
let browser = null;
let page = null;
let collector = null;

test.before(
  async () => {
    runtime = await setupE2ERuntime();
    patchHaxcmsRootForHarness(runtime);
    browser = await launchBrowser();
    page = await newPage(browser);
    collector = createResponseCollector(page);
  },
  { timeout: 120000 },
);

test.after(
  async () => {
    const { HAXCMS } = require("../../src/lib/HAXCMS.js");
    if (HAXCMS.config && HAXCMS.config.security) {
      delete HAXCMS.config.security.blockOperationsRateLimit;
    }
    if (collector) {
      try {
        collector.detach();
      } catch {
        /* ignore */
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    if (runtime) {
      try {
        await teardownE2ERuntime(runtime);
      } catch {
        /* ignore */
      }
    }
  },
  { timeout: 60000 },
);

// --- helpers ---------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function siteDir() {
  return path.join(runtime.runtimeRoot, SITES_DIR, EXPECTED_SITE_NAME);
}

function getSiteToken() {
  const { HAXCMS } = require("../../src/lib/HAXCMS.js");
  const userName = HAXCMS.getActiveUserName();
  return HAXCMS.getRequestToken(userName + ":" + EXPECTED_SITE_NAME);
}

async function siteApi(method, suffix, body) {
  const resp = await axios({
    method,
    url:
      runtime.baseUrl +
      "/" +
      SITES_DIR +
      "/" +
      EXPECTED_SITE_NAME +
      "/x/api/v1/" +
      suffix,
    headers: {
      Authorization: "Bearer " + runtime.jwt,
      "X-HAXCMS-Site-Token": getSiteToken(),
      "Content-Type": "application/json",
    },
    data: body,
    validateStatus: () => true,
  });
  return resp;
}

function manifest() {
  return fs.readJsonSync(path.join(siteDir(), "site.json"));
}

function itemBySlug(slug) {
  const items = manifest().items || [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].slug === slug) {
      return items[i];
    }
  }
  return null;
}

function pageFile(slug) {
  const item = itemBySlug(slug);
  assert.ok(item && item.location, "page " + slug + " is in site.json");
  return path.join(siteDir(), item.location);
}

function readPage(slug) {
  return fs.readFileSync(pageFile(slug), "utf8");
}

function setLocked(slug, locked) {
  const file = path.join(siteDir(), "site.json");
  const data = fs.readJsonSync(file);
  data.items.forEach((item) => {
    if (item.slug === slug) {
      item.metadata = item.metadata || {};
      if (locked) {
        item.metadata.locked = true;
      } else {
        delete item.metadata.locked;
      }
    }
  });
  fs.writeJsonSync(file, data, { spaces: 2 });
}

async function gitSubjects() {
  const out = await execFileAsync(
    "git",
    ["--no-pager", "log", "--pretty=format:%s"],
    { cwd: siteDir(), maxBuffer: 1024 * 1024 * 20 },
  );
  return String(out.stdout || "")
    .split("\n")
    .filter((l) => l.trim());
}

// The accessibility screen and its rows, found through every shadow root.
const FIND_SCREEN = `
function findScreen() {
  function walk(root) {
    if (!root) { return null }
    var hit = root.querySelector('insights-accessibility')
    if (hit) { return hit }
    var all = root.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) {
        var r = walk(all[i].shadowRoot)
        if (r) { return r }
      }
    }
    return null
  }
  return walk(document)
}
function rowFor(file) {
  var el = findScreen()
  if (!el || !el.shadowRoot) { return null }
  var rows = el.shadowRoot.querySelectorAll('tr[data-row]')
  for (var i = 0; i < rows.length; i++) {
    var code = rows[i].querySelector('code.file')
    if (code && code.textContent.trim() === file) { return rows[i] }
  }
  return null
}
`;

async function openAccessibility(t) {
  const url =
    runtime.baseUrl +
    "/" +
    SITES_DIR +
    "/" +
    EXPECTED_SITE_NAME +
    "/?admin=admin-reports-accessibility";
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  } catch {
    t.diagnostic("[e2e] networkidle2 timed out, retrying domcontentloaded");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  const ready = await waitFor(
    async () =>
      page.evaluate((src) => {
        eval(src);
        var el = findScreen();
        return !!(
          el &&
          el._canSave === true &&
          rowFor("one.png") &&
          rowFor("two.png") &&
          rowFor("three.png")
        );
      }, FIND_SCREEN),
    60000,
  );
  if (!ready) {
    const state = await page.evaluate((src) => {
      eval(src);
      var el = findScreen();
      if (!el) {
        return { screen: false, url: globalThis.location.href };
      }
      var r = el.results && el.results.accessibility;
      return {
        screen: true,
        canSave: el._canSave,
        files: r && r.altRows ? r.altRows.map((x) => x.file) : null,
        rows: el.shadowRoot
          ? el.shadowRoot.querySelectorAll("tr[data-row]").length
          : -1,
      };
    }, FIND_SCREEN);
    t.diagnostic("[e2e] accessibility screen: " + JSON.stringify(state));
  }
  assert.ok(ready, "Reports > Accessibility listed the images, with saving on");
}

async function setAlt(file, value) {
  const ok = await page.evaluate(
    (src, f, v) => {
      eval(src);
      var row = rowFor(f);
      if (!row) {
        return false;
      }
      var input = row.querySelector("input.alt-input");
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    FIND_SCREEN,
    file,
    value,
  );
  assert.ok(ok, "typed an alt for " + file);
}

async function rowState(file) {
  return page.evaluate(
    (src, f) => {
      eval(src);
      var row = rowFor(f);
      if (!row) {
        return null;
      }
      var state = row.querySelector(".save-state");
      return {
        save: row.getAttribute("data-save") || "",
        text: state ? state.textContent.replace(/\s+/g, " ").trim() : "",
      };
    },
    FIND_SCREEN,
    file,
  );
}

async function clickInScreen(selector) {
  const ok = await page.evaluate(
    (src, sel) => {
      eval(src);
      var el = findScreen();
      var btn = el && el.shadowRoot && el.shadowRoot.querySelector(sel);
      if (!btn || btn.disabled) {
        return false;
      }
      btn.click();
      return true;
    },
    FIND_SCREEN,
    selector,
  );
  assert.ok(ok, "clicked " + selector);
}

async function saveNoteText() {
  return page.evaluate((src) => {
    eval(src);
    var el = findScreen();
    var note = el && el.shadowRoot && el.shadowRoot.querySelector(".save-note");
    return note ? note.textContent.replace(/\s+/g, " ").trim() : "";
  }, FIND_SCREEN);
}

// Save edits: Save alt text, then Save now in the confirm panel. Runs `onConfirm`
// while the confirm panel is open. Resolves with the note shown afterwards.
async function saveEdits(onConfirm) {
  await clickInScreen(".save-alt");
  const confirmOpen = await waitFor(
    async () =>
      page.evaluate((src) => {
        eval(src);
        var el = findScreen();
        return !!(
          el &&
          el.shadowRoot &&
          el.shadowRoot.querySelector(".save-now")
        );
      }, FIND_SCREEN),
    10000,
  );
  assert.ok(confirmOpen, "the confirm panel opened");
  if (typeof onConfirm === "function") {
    await onConfirm();
  }
  await clickInScreen(".save-now");
  let note = "";
  await waitFor(async () => {
    note = await saveNoteText();
    return note !== "";
  }, 60000);
  assert.ok(note !== "", "a save summary was shown");
  return note;
}

// axe violations (critical or serious) inside the accessibility screen only
async function screenViolations() {
  const result = await runA11y(page, null);
  const mine = [];
  result.critical.concat(result.serious).forEach((v) => {
    const nodes = (v.nodes || []).filter(
      (n) =>
        JSON.stringify(n.target || []).indexOf("insights-accessibility") !== -1,
    );
    if (nodes.length) {
      mine.push(
        v.id + ": " + nodes.map((n) => JSON.stringify(n.target)).join(" "),
      );
    }
  });
  return mine;
}

// --- the flow --------------------------------------------------------------

test(
  "Reports > Accessibility saves alt text through block operations",
  { timeout: 600000 },
  async (t) => {
    await loginViaUI(page, collector, runtime.baseUrl);
    await createSiteViaUI(page, collector, FIXED_SITE_NAME);
    relocateCreatedSite(runtime, FIXED_SITE_NAME);

    const created = await siteApi("POST", "items", {
      site: { name: EXPECTED_SITE_NAME },
      items: [
        Object.assign({ parent: null, order: 90, indent: 0 }, PAGE_ONE),
        Object.assign({ parent: null, order: 91, indent: 0 }, PAGE_TWO),
      ],
    });
    assert.strictEqual(created.status, 200, "two pages with images were added");
    const original = readPage(PAGE_ONE.slug);
    assert.ok(original.indexOf("one.png") !== -1, "page one holds one.png");
    assert.ok(original.indexOf(" alt=") === -1, "page one starts with no alt");

    await t.test("1. saves two alts as one change, restorable", async () => {
      await openAccessibility(t);
      await setAlt("one.png", "First image");
      await setAlt("two.png", "Second image");
      let a11y = [];
      await saveEdits(async () => {
        a11y = await screenViolations();
      });
      assert.deepStrictEqual(a11y, [], "confirm panel has no axe violations");
      assert.strictEqual((await rowState("one.png")).save, "saved");
      assert.strictEqual((await rowState("two.png")).save, "saved");
      const rowsA11y = await screenViolations();
      assert.deepStrictEqual(
        rowsA11y,
        [],
        "result rows have no axe violations",
      );

      const after = readPage(PAGE_ONE.slug);
      assert.ok(after.indexOf('alt="First image"') !== -1, "img alt written");
      assert.ok(
        after.indexOf('alt="Second image"') !== -1,
        "media-image alt written",
      );
      const stripped = after
        .replace(/\s+alt="First image"/, "")
        .replace(/\s+alt="Second image"/, "");
      assert.strictEqual(stripped, original, "only the alt bytes changed");

      const subjects = await gitSubjects();
      assert.ok(
        subjects[0].endsWith(NOTE),
        "the newest commit ends with the note: " + subjects[0],
      );
      assert.strictEqual(
        subjects.filter((s) => s.endsWith(NOTE)).length,
        1,
        "one commit for the page",
      );

      const list = await siteApi(
        "GET",
        "items/" + encodeURIComponent(PAGE_ONE.slug) + "/revisions",
      );
      assert.strictEqual(list.status, 200, "revisions listed");
      const revisions = list.data && list.data.data && list.data.data.revisions;
      assert.ok(
        Array.isArray(revisions) && revisions.length >= 2,
        "two revisions",
      );
      assert.ok(
        String(revisions[0].message || "").indexOf(NOTE) !== -1,
        "the newest revision is the alt save",
      );
      const restored = await siteApi(
        "POST",
        "items/" +
          encodeURIComponent(PAGE_ONE.slug) +
          "/revisions/" +
          encodeURIComponent(revisions[1].hash) +
          "/restore",
        {},
      );
      assert.strictEqual(restored.status, 200, "previous revision restored");
      assert.strictEqual(
        readPage(PAGE_ONE.slug),
        original,
        "original bytes are back",
      );
    });

    await t.test(
      "2. a page changed after the scan is not overwritten",
      async () => {
        await openAccessibility(t);
        const changed = original.replace(
          '<img src="files/one.png">',
          '<img src="files/one.png" alt="Set elsewhere">',
        );
        assert.notStrictEqual(changed, original, "test edit applies");
        fs.writeFileSync(pageFile(PAGE_ONE.slug), changed);
        await setAlt("one.png", "Mine");
        await saveEdits();
        const st = await rowState("one.png");
        assert.strictEqual(st.save, "failed", "row ends Not saved");
        assert.strictEqual(
          readPage(PAGE_ONE.slug),
          changed,
          "file left as it was",
        );
        fs.writeFileSync(pageFile(PAGE_ONE.slug), original);
      },
    );

    await t.test("3. a locked page is not saved", async () => {
      setLocked(PAGE_TWO.slug, true);
      const before = readPage(PAGE_TWO.slug);
      try {
        await openAccessibility(t);
        await setAlt("three.png", "Third image");
        await saveEdits();
        const st = await rowState("three.png");
        assert.strictEqual(st.save, "failed", "row ends Not saved");
        assert.ok(
          /locked/i.test(st.text),
          "row says the page is locked: " + st.text,
        );
        assert.strictEqual(readPage(PAGE_TWO.slug), before, "file unchanged");
      } finally {
        setLocked(PAGE_TWO.slug, false);
      }
    });

    await t.test(
      "4. the block change limit stops the run, a later click finishes",
      async () => {
        const { HAXCMS } = require("../../src/lib/HAXCMS.js");
        HAXCMS.config.security = HAXCMS.config.security || {};
        HAXCMS.config.security.blockOperationsRateLimit = {
          enabled: true,
          max: 2,
          windowMs: 3000,
        };
        await sleep(3500);
        await openAccessibility(t);
        await setAlt("one.png", "Rate one");
        await setAlt("two.png", "Rate two");
        await setAlt("three.png", "Rate three");
        const note = await saveEdits();
        assert.ok(/limit/i.test(note), "the limit message is shown: " + note);
        assert.strictEqual((await rowState("one.png")).save, "saved");
        assert.strictEqual((await rowState("two.png")).save, "saved");
        assert.strictEqual(
          (await rowState("three.png")).save,
          "",
          "page two stays edited, not failed",
        );
        assert.ok(
          readPage(PAGE_TWO.slug).indexOf("Rate three") === -1,
          "not written yet",
        );
        await sleep(3500);
        await saveEdits();
        assert.strictEqual((await rowState("three.png")).save, "saved");
        assert.ok(
          readPage(PAGE_TWO.slug).indexOf('alt="Rate three"') !== -1,
          "written",
        );
      },
    );
  },
);
