"use strict";

// Cache-Control for responses that must come fresh from the server
// (haxtheweb/issues#3244). Credentialed or token-bearing answers stay
// no-store; answers to requests with no credentials use `private, no-cache`
// so Chrome can keep the page in the back/forward cache.

const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const {
  NO_STORE,
  REVALIDATE,
  requestCarriesCredentials,
  setUncachedResponseHeaders,
} = require("../../src/lib/responseCache.js");
const {
  setupE2ERuntime,
  teardownE2ERuntime,
} = require("../e2e/helpers/harness.cjs");

function fakeRes() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

test("requestCarriesCredentials: bearer, request tokens and the refresh cookie count", () => {
  assert.equal(requestCarriesCredentials(null), false);
  assert.equal(requestCarriesCredentials({ headers: {} }), false);
  assert.equal(
    requestCarriesCredentials({ headers: { authorization: "   " } }),
    false,
  );
  assert.equal(
    requestCarriesCredentials({ headers: { cookie: "theme=dark; other=1" } }),
    false,
  );
  assert.equal(
    requestCarriesCredentials({ headers: { authorization: "Bearer x" } }),
    true,
  );
  assert.equal(
    requestCarriesCredentials({ headers: { authorization: "Basic eDp5" } }),
    true,
  );
  assert.equal(
    requestCarriesCredentials({ headers: { "x-haxcms-user-token": "t" } }),
    true,
  );
  assert.equal(
    requestCarriesCredentials({ headers: { "x-haxcms-site-token": "t" } }),
    true,
  );
  assert.equal(
    requestCarriesCredentials({
      headers: { cookie: "a=1; haxcms_refresh_token=abc" },
    }),
    true,
  );
  assert.equal(
    requestCarriesCredentials({
      headers: {},
      cookies: { haxcms_refresh_token: "" },
    }),
    true,
    "parsed cookie present, even empty",
  );
  assert.equal(
    requestCarriesCredentials({
      headers: { cookie: "not_haxcms_refresh_token=abc" },
    }),
    false,
    "a cookie that only ends with the name does not count",
  );
});

test("setUncachedResponseHeaders: revalidate for anonymous, no-store otherwise", () => {
  const anon = fakeRes();
  setUncachedResponseHeaders(anon, { headers: {} });
  assert.equal(anon.headers["Cache-Control"], REVALIDATE);
  assert.equal(anon.headers.Pragma, "no-cache");
  assert.equal(anon.headers.Expires, "0");
  assert.equal(
    anon.headers["Surrogate-Control"],
    "no-store",
    "CDNs still keep out",
  );

  const credentialed = fakeRes();
  setUncachedResponseHeaders(credentialed, {
    headers: { authorization: "Bearer x" },
  });
  assert.equal(credentialed.headers["Cache-Control"], NO_STORE);

  const sensitive = fakeRes();
  setUncachedResponseHeaders(sensitive, { headers: {} }, { sensitive: true });
  assert.equal(sensitive.headers["Cache-Control"], NO_STORE);

  assert.doesNotThrow(() => setUncachedResponseHeaders(null, null));
  assert.match(NO_STORE, /^no-store/);
  assert.doesNotMatch(REVALIDATE, /no-store/);
});

test("live server: page HTML, docs and session routes", async (t) => {
  const runtime = await setupE2ERuntime();
  t.after(async () => {
    await teardownE2ERuntime(runtime);
  });
  const base = runtime.baseUrl;
  const get = (url, headers) =>
    axios.get(base + url, {
      headers: headers || {},
      validateStatus: () => true,
      maxRedirects: 0,
    });
  // what a browser sends for a page (without it the site answers JSON)
  const HTML = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
  const created = await axios.post(
    base + "/system/api/v1/sites",
    {
      site: { name: "cachehdr", theme: "clean-two" },
      build: { type: "website", structure: "course" },
    },
    {
      headers: {
        Authorization: "Bearer " + runtime.jwt,
        [runtime.userTokenHeader]: runtime.userToken,
      },
      validateStatus: () => true,
    },
  );
  assert.equal(created.status, 200);

  await t.test(
    "anonymous page HTML is revalidated, not no-store (bfcache)",
    async () => {
      const res = await get("/_sites/cachehdr/", { Accept: HTML });
      assert.equal(res.status, 200);
      assert.match(String(res.headers["content-type"]), /text\/html/);
      assert.equal(res.headers["cache-control"], REVALIDATE);
    },
  );

  await t.test(
    "page HTML with a session cookie or bearer stays no-store",
    async () => {
      const withCookie = await get("/_sites/cachehdr/", {
        Accept: HTML,
        Cookie: "haxcms_refresh_token=anything",
      });
      assert.equal(withCookie.headers["cache-control"], NO_STORE);
      const withBearer = await get("/_sites/cachehdr/", {
        Accept: HTML,
        Authorization: "Bearer " + runtime.jwt,
      });
      assert.equal(withBearer.headers["cache-control"], NO_STORE);
    },
  );

  await t.test(
    "anonymous connection-settings is revalidated; with a session, no-store",
    async () => {
      const anon = await get("/system/api/v1/session/connection-settings");
      assert.equal(anon.status, 200);
      assert.doesNotMatch(
        String(anon.data),
        /"userToken"|"siteToken"|appSettings\.jwt/,
      );
      assert.equal(anon.headers["cache-control"], REVALIDATE);
      const authed = await get("/system/api/v1/session/connection-settings", {
        Authorization: "Bearer " + runtime.jwt,
      });
      assert.equal(authed.headers["cache-control"], NO_STORE);
    },
  );

  await t.test("anonymous connection-test is revalidated", async () => {
    const res = await axios.post(
      base + "/system/api/v1/session/connection-test",
      {},
      {
        validateStatus: () => true,
      },
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.authenticated, false);
    assert.equal(res.headers["cache-control"], REVALIDATE);
  });

  await t.test(
    "API description docs are revalidated for anonymous callers",
    async () => {
      for (const url of [
        "/system/api/v1/openapi.json",
        "/system/api/v1/openapi.yaml",
      ]) {
        const res = await get(url);
        assert.equal(res.status, 200, url);
        assert.equal(res.headers["cache-control"], REVALIDATE, url);
      }
    },
  );

  await t.test("every other system API answer stays no-store", async () => {
    const status = await get("/system/api/v1/status");
    assert.equal(status.headers["cache-control"], NO_STORE);
    // a login answer carries a JWT although the request had no credential header
    const login = await axios.post(
      base + "/system/api/v1/session/login",
      {
        username: runtime.credentials.username,
        password: runtime.credentials.password,
      },
      { validateStatus: () => true },
    );
    assert.equal(login.status, 200);
    assert.ok(login.data.jwt);
    assert.equal(login.headers["cache-control"], NO_STORE);
  });

  await t.test(
    "cache-busted reads (?t=) are revalidated for anonymous callers",
    async () => {
      const res = await get("/_sites/cachehdr/site.json?t=1");
      assert.equal(res.status, 200);
      assert.equal(res.headers["cache-control"], REVALIDATE);
    },
  );
});
