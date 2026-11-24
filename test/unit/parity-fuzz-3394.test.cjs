"use strict";

// Regression tests for the ten nodejs/php divergences the parity fuzzer in
// create found (https://github.com/haxtheweb/issues/issues/3394, seed 3386).
// Each test sends the request the fuzzer shrank the finding to, against a
// real server, and checks the answer both backends now give. The PHP twin is
// haxcms-php tests/Unit/ParityFuzz3394Test.php: keep the two in step.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const axios = require("axios");

const {
  setupE2ERuntime,
  teardownE2ERuntime,
} = require("../e2e/helpers/harness.cjs");

const SITE_NAME = "parity3394";

function parseSettingsScript(src) {
  const sandbox = { window: {} };
  vm.runInNewContext(String(src || ""), sandbox, { timeout: 1000 });
  return sandbox.window.appSettings || {};
}

test("haxtheweb/issues#3394: the parity fuzz findings answer like haxcms-php", async (t) => {
  const runtime = await setupE2ERuntime();
  t.after(async () => {
    await teardownE2ERuntime(runtime);
  });
  const base = runtime.baseUrl;
  const systemHeaders = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: "Bearer " + runtime.jwt,
    [runtime.userTokenHeader]: runtime.userToken,
  };
  const created = await axios.post(
    base + "/system/api/v1/sites",
    {
      site: { name: SITE_NAME, theme: "clean-two" },
      build: { type: "website", structure: "course" },
    },
    { headers: systemHeaders, validateStatus: () => true },
  );
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const settingsRes = await axios.get(
    base + "/system/api/v1/session/connection-settings",
    {
      headers: {
        accept: "application/javascript",
        authorization: "Bearer " + runtime.jwt,
        referer: base + "/_sites/" + SITE_NAME + "/",
      },
      responseType: "text",
      transformResponse: [(data) => data],
      validateStatus: () => true,
    },
  );
  assert.equal(settingsRes.status, 200);
  const settings = parseSettingsScript(settingsRes.data);
  assert.ok(settings.siteToken, "a site token for the new site");
  const apiBase = (
    settings.siteApiBasePath || "/_sites/" + SITE_NAME + "/x/api"
  ).replace(/\/+$/, "");
  const siteHeaders = Object.assign({}, systemHeaders, {
    "X-HAXCMS-Site-Token": settings.siteToken,
  });
  const site = (method, specPath, data) =>
    axios({
      method,
      url: base + apiBase + specPath,
      headers: siteHeaders,
      data,
      validateStatus: () => true,
    });

  const siteJsonPath = path.join(
    runtime.runtimeRoot,
    "_sites",
    SITE_NAME,
    "site.json",
  );
  assert.ok(fs.existsSync(siteJsonPath), siteJsonPath);
  const siteJsonBefore = fs.readFileSync(siteJsonPath, "utf8");
  // the fuzzer's body: only the site name
  const nameOnly = { site: { name: SITE_NAME } };

  const expectError = (res, status, message, code, params) => {
    assert.equal(res.status, status, JSON.stringify(res.data));
    assert.equal(res.data.data.message, message);
    assert.equal(res.data.data.code, code);
    if (params === undefined) {
      assert.equal("params" in res.data.data, false, "no params");
    } else {
      assert.deepEqual(res.data.data.params, params);
    }
  };

  await t.test("1. updateSiteAppearance without a manifest", async () => {
    const res = await site("PATCH", "/v1/site/appearance", nameOnly);
    expectError(res, 400, "invalid manifest payload", "PARAM_INVALID", {
      param: "manifest",
    });
  });

  await t.test("2. updateSitePlatform without platform settings", async () => {
    const res = await site("PATCH", "/v1/site/platform", nameOnly);
    expectError(
      res,
      400,
      "missing platform settings",
      "PLATFORM_SETTINGS_MISSING",
    );
  });

  await t.test("3. deleteFileByUuid with a blank uuid", async () => {
    const res = await site("DELETE", "/v1/files/%20%20");
    expectError(
      res,
      400,
      "File uuid is required and must be a valid UUID",
      "FILE_UUID_INVALID",
    );
  });

  await t.test(
    "4. updateSiteAllowedBlocks without platform settings",
    async () => {
      const res = await site("PATCH", "/v1/site/blocks", nameOnly);
      expectError(
        res,
        400,
        "missing platform settings",
        "PLATFORM_SETTINGS_MISSING",
      );
    },
  );

  await t.test("5. updateSiteOutline with an empty object item", async () => {
    const res = await site("PATCH", "/v1/site/outline", {
      site: { name: SITE_NAME },
      items: [{}],
    });
    expectError(
      res,
      400,
      "Each outline item requires an id",
      "OUTLINE_INVALID",
    );
  });

  await t.test("6. updateSiteSummary without a form token", async () => {
    const res = await site("PATCH", "/v1/site", nameOnly);
    expectError(res, 403, "invalid request token", "USER_TOKEN_INVALID");
  });

  await t.test(
    "7. listCustomElements projected to no field is {} per entry",
    async () => {
      const res = await site("GET", "/v1/custom-elements?fields=!");
      assert.equal(res.status, 200);
      const list = res.data.data.customElements;
      assert.ok(Array.isArray(list) && list.length > 0);
      for (const entry of list) {
        assert.equal(Array.isArray(entry), false);
        assert.deepEqual(entry, {});
      }
    },
  );

  await t.test(
    "8. replaceContent with a search that is not a string",
    async () => {
      const res = await site("PATCH", "/v1/content", {
        site: { name: SITE_NAME },
        search: 0,
        replace: "",
        replaceConfirm: false,
      });
      expectError(res, 400, "Search query is required", "PARAM_REQUIRED", {
        param: "Search query",
      });
      // lengths are counted in characters on both: é is too short to replace
      const short = await site("PATCH", "/v1/content", {
        site: { name: SITE_NAME },
        search: "é",
        replace: "ab",
      });
      expectError(
        short,
        400,
        "Search text must be more than 1 character for replacement operations",
        "SEARCH_TEXT_TOO_SHORT",
      );
    },
  );

  await t.test(
    "9. updateSiteEditorSettings without platform settings",
    async () => {
      const res = await site("PATCH", "/v1/site/editor", nameOnly);
      expectError(
        res,
        400,
        "missing platform settings",
        "PLATFORM_SETTINGS_MISSING",
      );
    },
  );

  await t.test(
    "10. getItemByIdOrSlug: absent links left out, ISO dates",
    async () => {
      const list = await site("GET", "/v1/items");
      assert.equal(list.status, 200);
      const first = list.data.data.items[0];
      const res = await site(
        "GET",
        "/v1/items/" + encodeURIComponent(first.id) + "?include=jsonld",
      );
      assert.equal(res.status, 200);
      const record = res.data.data;
      // the first, top-level page has no previous page and no parent
      assert.equal("previous" in record.links, false);
      assert.equal("parent" in record.links, false);
      assert.equal(typeof record.links.children, "string");
      assert.match(
        record.jsonld.datePublished,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      assert.match(
        record.jsonld.dateModified,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    },
  );

  await t.test("none of the refused writes changed site.json", async () => {
    assert.equal(fs.readFileSync(siteJsonPath, "utf8"), siteJsonBefore);
  });
});
