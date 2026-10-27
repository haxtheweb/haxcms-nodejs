"use strict";

// E2E test: logged-in editor can export the whole site and the active page as
// pdf / docx / epub through the REAL editor client code.
//
// Why this exists: the site API reads credentials only from the Authorization
// header (bearer JWT or basic), never from cookies. The editor's export
// buttons used to fetch x/api/v1/.../export/<format> with
// `credentials: "include"` and no Authorization header, so a logged-in editor
// was treated as anonymous and every binary export answered 401
// ("Authentication required for pdf site exports"). The API conformance
// suite never noticed because it calls the endpoints with a bearer token it
// builds itself, and the client unit tests mock fetch and only check the URL.
// This test drives the actual client methods against the actual server so a
// client/server auth mismatch fails here.
//
// Flow: boot isolated runtime (JWT auth ENABLED) -> login via UI -> create
// HAXSITEAUTOMATEDTESTING -> open the site editor -> call
// haxcms-site-editor-ui.exportSiteAs(fmt) / exportPageAs(fmt) for each binary
// format -> assert the export request carried a bearer token and returned 200.
//
// Constraints honored: CommonJS (.cjs), node:test + node:assert/strict,
// globalThis not window, no optional chaining.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setupE2ERuntime,
  teardownE2ERuntime,
  launchBrowser,
  newPage,
  createResponseCollector,
  FIXED_SITE_NAME,
  waitFor,
  patchHaxcmsRootForHarness,
  relocateCreatedSite,
  loginViaUI,
  createSiteViaUI,
} = require("./helpers");

const EXPECTED_SITE_NAME = FIXED_SITE_NAME.toLowerCase();
const BINARY_FORMATS = ["pdf", "docx", "epub"];

let runtime = null;
let browser = null;
let page = null;
let collector = null;
// export request url -> Authorization header the browser actually sent
const sentAuthByUrl = {};

test.before(
  async () => {
    runtime = await setupE2ERuntime();
    patchHaxcmsRootForHarness(runtime);
    browser = await launchBrowser();
    page = await newPage(browser);
    collector = createResponseCollector(page);
    page.on("request", (req) => {
      const url = req.url();
      if (url.indexOf("/export/") !== -1) {
        const headers = req.headers() || {};
        sentAuthByUrl[url] = headers.authorization || "";
      }
    });
  },
  { timeout: 120000 },
);

test.after(
  async () => {
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

function sentAuthFor(urlSubstring) {
  const keys = Object.keys(sentAuthByUrl);
  for (let i = keys.length - 1; i >= 0; i--) {
    if (keys[i].indexOf(urlSubstring) !== -1) {
      return sentAuthByUrl[keys[i]];
    }
  }
  return null;
}

async function runEditorExport(method, format) {
  return page.evaluate(
    async (m, f) => {
      const ui = globalThis.document.querySelector("haxcms-site-editor-ui");
      if (!ui || typeof ui[m] !== "function") {
        return "missing " + m;
      }
      await ui[m](f);
      return "ok";
    },
    method,
    format,
  );
}

async function assertExport(t, method, format, urlSubstring) {
  const result = await runEditorExport(method, format);
  assert.equal(result, "ok", `haxcms-site-editor-ui.${method} available`);
  let resp = null;
  try {
    resp = await collector.awaitCollectorFor(urlSubstring, 120000);
  } catch {
    // asserted below
  }
  assert.ok(resp, `${urlSubstring} response captured`);
  const auth = sentAuthFor(urlSubstring);
  t.diagnostic(
    `${urlSubstring} -> ${resp.status}, authorization sent: ${auth ? "yes" : "no"}`,
  );
  assert.ok(
    auth && auth.toLowerCase().indexOf("bearer ") === 0,
    `${urlSubstring} must send Authorization: Bearer <jwt>; the site API ignores cookies`,
  );
  assert.notEqual(
    resp.status,
    401,
    `${urlSubstring} answered 401 for a logged-in editor (client sent no usable credentials)`,
  );
  assert.equal(resp.status, 200, `${urlSubstring} returned 200`);
}

test(
  "logged-in editor exports site and page as pdf/docx/epub without 401",
  { timeout: 600000 },
  async (t) => {
    await loginViaUI(page, collector, runtime.baseUrl);
    await createSiteViaUI(page, collector, FIXED_SITE_NAME);
    relocateCreatedSite(runtime, FIXED_SITE_NAME);

    const editorUrl = runtime.baseUrl + "/_sites/" + EXPECTED_SITE_NAME + "/";
    try {
      await page.goto(editorUrl, { waitUntil: "networkidle2", timeout: 30000 });
    } catch {
      await page.goto(editorUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }
    await page.waitForSelector("haxcms-site-editor-ui", { timeout: 30000 });
    // wait for an active page so page-level exports have an item id
    const activeId = await waitFor(
      async () =>
        page.evaluate(() => {
          const s =
            globalThis.HAXCMS && globalThis.HAXCMS.requestAvailability
              ? globalThis.HAXCMS.requestAvailability().store
              : null;
          return s && s.activeId ? String(s.activeId) : false;
        }),
      30000,
    );
    assert.ok(activeId, "editor has an active page");

    for (const format of BINARY_FORMATS) {
      await t.test(`whole-site ${format} export`, async (st) => {
        await assertExport(
          st,
          "exportSiteAs",
          format,
          "/x/api/v1/site/export/" + format,
        );
      });
    }
    for (const format of BINARY_FORMATS) {
      await t.test(`page ${format} export`, async (st) => {
        await assertExport(
          st,
          "exportPageAs",
          format,
          "/x/api/v1/items/" +
            encodeURIComponent(activeId) +
            "/export/" +
            format,
        );
      });
    }
  },
);
