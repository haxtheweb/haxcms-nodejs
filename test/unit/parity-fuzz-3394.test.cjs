"use strict";

// Regression tests for the nodejs/php divergences the parity fuzzer in create
// found (https://github.com/haxtheweb/issues/issues/3394, seed 3386): the
// first ten, the next ten once those were fixed, and the ones a longer run
// (300 runs) found after that. Each test sends the request the fuzzer shrank
// the finding to, against a real server, and checks the answer both backends
// now give. The PHP twin is haxcms-php tests/Unit/ParityFuzz3394Test.php:
// keep the two in step.

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

test("haxtheweb/issues#3394: the parity fuzz findings answer the same on both backends", async (t) => {
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

  // findings 11-21: the next ones the same fuzz run found once 1-10 were
  // fixed, and the cases found next to them
  const NO_FILE = "00000000-0000-1000-8000-000000000000";

  await t.test(
    "11. updateFileByUuid: the file is looked up before the operation",
    async () => {
      const res = await site("PATCH", "/v1/files/" + NO_FILE, {
        operation: "",
      });
      expectError(res, 404, "Requested file was not found", "FILE_NOT_FOUND");
      const badUuid = await site("PATCH", "/v1/files/not-a-uuid", {
        operation: "",
      });
      expectError(
        badUuid,
        400,
        "File uuid is required and must be a valid UUID",
        "FILE_UUID_INVALID",
      );
    },
  );

  await t.test("12. the html form indents JSON 4 spaces", async () => {
    const res = await axios.get(base + apiBase + "/v1/items?format=html", {
      headers: siteHeaders,
      responseType: "text",
      transformResponse: [(data) => data],
      validateStatus: () => true,
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.startsWith("<pre>{\n    &quot;status&quot;: 200,"));
  });

  await t.test("13. deleteFileByUuid on a uuid no file has", async () => {
    const res = await site("DELETE", "/v1/files/" + NO_FILE);
    expectError(res, 404, "Requested file was not found", "FILE_NOT_FOUND");
  });

  await t.test(
    "14. an empty path segment is an unknown route, in JSON",
    async () => {
      const res = await site("GET", "/v1/blocks//usage");
      assert.equal(res.status, 404);
      assert.deepEqual(res.data, {
        status: 404,
        data: {
          message: "Unknown site API route",
          route: "v1/blocks//usage",
          code: "ROUTE_NOT_FOUND",
        },
      });
      const unknown = await site("GET", "/v1/no-such-route");
      assert.equal(unknown.status, 404);
      assert.equal(unknown.data.data.route, "v1/no-such-route");
    },
  );

  await t.test(
    "15. a block name that cannot be a tag is not found, not a 500",
    async () => {
      for (const p of ["/v1/blocks/!/usage", "/v1/blocks/!"]) {
        const res = await site("GET", p);
        expectError(res, 404, 'Block "!" not found', "BLOCK_NOT_FOUND", {
          name: "!",
        });
      }
      const blank = await site("GET", "/v1/blocks/%20");
      expectError(blank, 404, "Block not found", "BLOCK_NOT_FOUND");
    },
  );

  await t.test("16. the 405 route has no trailing slash", async () => {
    const res = await site("PATCH", "/v1/files/", { operation: "  " });
    assert.equal(res.status, 405);
    assert.equal(res.data.data.route, "v1/files");
  });

  await t.test(
    "17. updateSiteAlternativeFormats refuses a format that is not a string",
    async () => {
      for (const format of [[], 5, { rss: true }]) {
        const res = await site("POST", "/v1/site/updateAlternativeFormats", {
          format,
        });
        expectError(
          res,
          400,
          "Invalid format requested for alternative formats update",
          "ALT_FORMATS_FAILED",
        );
      }
    },
  );

  await t.test(
    "18-20. named lookups trim the name; a blank name is a 404",
    async () => {
      expectError(
        await site("GET", "/v1/themes/%20%20"),
        404,
        "Theme not found",
        "THEME_NOT_FOUND",
      );
      for (const p of ["/v1/themes/%20!%20", "/v1/themes/%0A!%20"]) {
        expectError(
          await site("GET", p),
          404,
          'Theme "!" not found',
          "THEME_NOT_FOUND",
          { name: "!" },
        );
      }
      expectError(
        await site("GET", "/v1/custom-elements/%20%20"),
        404,
        "Custom element not found",
        "CUSTOM_ELEMENT_NOT_FOUND",
      );
      expectError(
        await site("GET", "/v1/custom-elements/%20zz-a%20"),
        404,
        'Custom element "zz-a" not found',
        "CUSTOM_ELEMENT_NOT_FOUND",
        { name: "zz-a" },
      );
      expectError(
        await site("GET", "/v1/views/%20%20"),
        404,
        "View not found",
        "VIEW_NOT_FOUND",
      );
      // theme names match without regard to case, as on haxcms-php
      const upper = await site("GET", "/v1/themes/CLEAN-TWO");
      assert.equal(upper.status, 200);
    },
  );

  await t.test(
    "21. an id that is not a valid encoding is looked up as it is",
    async () => {
      const res = await site("PATCH", "/v1/content/%20%25%20", nameOnly);
      expectError(
        res,
        404,
        'Content not found for idOrSlug " % "',
        "ITEM_NOT_FOUND",
        { idOrSlug: " % " },
      );
    },
  );

  await t.test("none of the refused writes changed site.json", async () => {
    assert.equal(fs.readFileSync(siteJsonPath, "utf8"), siteJsonBefore);
  });
  // found by the longer run (300 runs): regions and reports read names like
  // themes do; these last ones write, so they run after the check above
  await t.test("22. regions: trimmed name, a blank name is a 404", async () => {
    expectError(
      await site("GET", "/v1/regions/%20%20"),
      404,
      "Region not found",
      "REGION_NOT_FOUND",
    );
    expectError(
      await site("GET", "/v1/regions/%20!%20"),
      404,
      'Region "!" not found',
      "REGION_NOT_FOUND",
      { name: "!" },
    );
  });

  await t.test("23. reports: trimmed name, a blank name is a 404", async () => {
    expectError(
      await site("GET", "/v1/reports/%20"),
      404,
      "Unknown report",
      "REPORT_UNKNOWN",
    );
    expectError(
      await site("GET", "/v1/reports/!%20"),
      404,
      'Unknown report "!"',
      "REPORT_UNKNOWN",
      { name: "!" },
    );
  });

  await t.test(
    "24. createItem: a parent that is not a page id is no parent",
    async () => {
      const res = await site("POST", "/v1/items", {
        site: { name: SITE_NAME },
        node: { title: "Unit one" },
        indent: null,
        parent: {},
        description: null,
      });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.data.parent, null);
      assert.equal(res.data.data.indent, 0);
      const saved = JSON.parse(fs.readFileSync(siteJsonPath, "utf8"));
      const item = saved.items.find((it) => it.id === res.data.data.id);
      assert.equal(item.parent, null, "site.json never holds an object parent");
    },
  );

  await t.test(
    "25. updateItem answers the links of the outline after the change",
    async () => {
      const created = await site("POST", "/v1/items", {
        site: { name: SITE_NAME },
        node: { title: "Unit two" },
      });
      assert.equal(created.status, 200);
      const id = encodeURIComponent(created.data.data.id);
      for (const operation of ["moveUp", "indent"]) {
        const patched = await site("PATCH", "/v1/items/" + id, {
          site: { name: SITE_NAME },
          operation,
        });
        assert.equal(patched.status, 200, JSON.stringify(patched.data));
        const read = await site("GET", "/v1/items/" + id);
        for (const rel of ["previous", "next", "parent"]) {
          assert.equal(
            patched.data.data.links[rel],
            read.data.data.links[rel],
            operation + " " + rel,
          );
        }
      }
    },
  );
  await t.test(
    "26. createItem: a description that is not a string is ignored",
    async () => {
      const res = await site("POST", "/v1/items", {
        site: { name: SITE_NAME },
        node: {},
        items: [],
        indent: null,
        order: null,
        parent: null,
        description: {},
      });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.data.description, "");
    },
  );

  await t.test(
    "27. bulk createItem: a page without a slug takes it from its title",
    async () => {
      const res = await site("POST", "/v1/items", {
        site: { name: SITE_NAME },
        items: [{}],
      });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.data.title, "New page");
      assert.match(res.data.data.slug, /^new-page(-\d+)?$/);
    },
  );

  await t.test(
    "28. setImage: image, else media; blank once cleaned removes it",
    async () => {
      const list = await site("GET", "/v1/items");
      const id = encodeURIComponent(list.data.data.items[0].id);
      const set = await site("PATCH", "/v1/items/" + id, {
        site: { name: SITE_NAME },
        operation: "setImage",
        media: "https://example.com/a.png",
      });
      assert.equal(set.status, 200, JSON.stringify(set.data));
      assert.equal(set.data.data.metadata.image, "https://example.com/a.png");
      const blank = await site("PATCH", "/v1/items/" + id, {
        site: { name: SITE_NAME },
        operation: "setImage",
        media: "  ",
      });
      assert.equal(blank.status, 200);
      assert.equal("image" in blank.data.data.metadata, false);
    },
  );

  await t.test("29. saveOutline refuses items sent as an object", async () => {
    const res = await site("PATCH", "/v1/site/outline", {
      site: { name: SITE_NAME },
      items: {},
    });
    expectError(
      res,
      400,
      "Outline payload requires an items array",
      "OUTLINE_INVALID",
    );
  });

  await t.test("30. a block name is lowercased like toLowerCase", async () => {
    expectError(
      await site("GET", "/v1/blocks/%EA%9D%96"),
      404,
      'Block "ꝗ" not found',
      "BLOCK_NOT_FOUND",
      { name: "ꝗ" },
    );
  });
});
