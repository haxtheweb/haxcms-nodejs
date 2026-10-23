"use strict";

// Regression coverage for the site-API identity fix: legacy route handlers
// used to re-derive the "active user" from the process-global
// HAXCMS.getActiveUserName() singleton instead of the per-request
// authenticated identity resolved by validateSiteApiRouteAccess
// (req.haxcmsSiteApiAuth.userName). That meant a site token minted for one
// authenticated user could validate under a *different* authenticated
// request simply because the global singleton still pointed at the token's
// owner.
//
// These tests exercise the REAL (non-mocked) HAXCMS.getRequestToken /
// validateRequestToken crypto, then wire it through an actual route handler
// (deleteNode) to prove the end-to-end fix: a token minted for "alice" is
// rejected when the per-request identity is "bob", even when the stale
// global singleton still says "alice" -- and still succeeds when the
// per-request identity legitimately matches the token.
//
// Constraints honored: CommonJS (.cjs), require(), globalThis (not window),
// NO optional chaining (explicit && guards), node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const deleteNode = require("../../src/siteRoutes/v1/routes/deleteNode.js");

function withKeys(t, privateKey, salt) {
  const saved = { privateKey: HAXCMS.privateKey, salt: HAXCMS.salt };
  HAXCMS.privateKey = privateKey;
  HAXCMS.salt = salt;
  t.after(() => {
    HAXCMS.privateKey = saved.privateKey;
    HAXCMS.salt = saved.salt;
  });
}

// Forces validateRequestToken down its real crypto path (not the CLI /
// local-dev bypass), matching the production request-handling path.
function withRealTokenChecks(t) {
  const savedDisable = HAXCMS.HAXCMS_DISABLE_JWT_CHECKS;
  HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = false;
  t.mock.method(HAXCMS, "isCLI", () => false);
  t.after(() => {
    HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = savedDisable;
  });
}

// Simulates the legacy global-identity singleton pointing at a DIFFERENT
// user than the one actually authenticated on this request -- the exact
// condition the fix closes.
function withGlobalUser(t, name) {
  const saved = { user: HAXCMS.user, superUser: HAXCMS.superUser };
  HAXCMS.user = { name: name };
  HAXCMS.superUser = { name: name };
  t.after(() => {
    HAXCMS.user = saved.user;
    HAXCMS.superUser = saved.superUser;
  });
}

function stubRes() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    send(obj) {
      this.statusCode = this.statusCode || 200;
      this.sent = obj;
      return this;
    },
  };
}

function makeFakeSite(page) {
  return {
    manifest: { metadata: {}, items: [] },
    loadNode(id) {
      return id === page.id ? page : null;
    },
    async deleteNode() {
      return true;
    },
    async gitCommit() {},
  };
}

// ---- crypto-level: the token itself is bound to the identity it was minted for ----

test("getRequestToken/validateRequestToken: a token minted for one user does not validate for another", (t) => {
  withKeys(t, "pk", "s");
  withRealTokenChecks(t);
  const token = HAXCMS.getRequestToken("alice:mysite");
  assert.equal(HAXCMS.validateRequestToken(token, "alice:mysite"), true);
  assert.equal(HAXCMS.validateRequestToken(token, "bob:mysite"), false);
  // same user, different site must also fail -- the site name is part of
  // the signed value, not just the username
  assert.equal(HAXCMS.validateRequestToken(token, "alice:othersite"), false);
});

// ---- end-to-end: the route handler must gate on per-request identity ----

test('deleteNode: a token minted for "alice" is rejected when the authenticated request identity is "bob", even though the stale global singleton still says "alice"', async (t) => {
  withKeys(t, "pk", "s");
  withRealTokenChecks(t);
  // The legacy bug: the process-global identity still points at the token's
  // rightful owner. If deleteNode used HAXCMS.getActiveUserName() instead of
  // req.haxcmsSiteApiAuth.userName, this request would incorrectly succeed.
  withGlobalUser(t, "alice");

  const page = { id: "item-1", title: "Page" };
  const site = makeFakeSite(page);
  t.mock.method(HAXCMS, "loadSite", async () => site);

  // token minted for alice:mysite
  const token = HAXCMS.getRequestToken("alice:mysite");

  const req = {
    headers: { "x-haxcms-site-token": token },
    // the request is actually authenticated as bob, not alice
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "bob",
      siteName: "mysite",
    },
    body: { site: { name: "mysite" }, node: { id: "item-1" } },
  };
  const res = stubRes();
  await deleteNode(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.data.message, "Authentication required");
});

test("deleteNode: the same token succeeds when the authenticated request identity legitimately matches it", async (t) => {
  withKeys(t, "pk", "s");
  withRealTokenChecks(t);
  // Global singleton deliberately left pointing at a third, unrelated user
  // to prove the handler no longer consults it at all.
  withGlobalUser(t, "someone-else");

  const page = { id: "item-1", title: "Page" };
  const site = makeFakeSite(page);
  t.mock.method(HAXCMS, "loadSite", async () => site);

  const token = HAXCMS.getRequestToken("alice:mysite");

  const req = {
    headers: { "x-haxcms-site-token": token },
    haxcmsSiteApiAuth: {
      authenticated: true,
      securityLevel: "authenticated-site",
      userName: "alice",
      siteName: "mysite",
    },
    body: { site: { name: "mysite" }, node: { id: "item-1" } },
  };
  const res = stubRes();
  await deleteNode(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.sent.data.id, "item-1");
});

test("deleteNode: missing req.haxcmsSiteApiAuth (no per-request identity resolved) fails closed regardless of a valid-looking token", async (t) => {
  withKeys(t, "pk", "s");
  withRealTokenChecks(t);
  withGlobalUser(t, "alice");

  const page = { id: "item-1", title: "Page" };
  const site = makeFakeSite(page);
  t.mock.method(HAXCMS, "loadSite", async () => site);

  const token = HAXCMS.getRequestToken("alice:mysite");

  const req = {
    headers: { "x-haxcms-site-token": token },
    // no haxcmsSiteApiAuth at all -- simulates a code path that forgot to
    // run validateSiteApiRouteAccess
    body: { site: { name: "mysite" }, node: { id: "item-1" } },
  };
  const res = stubRes();
  await deleteNode(req, res);

  assert.equal(res.statusCode, 403);
});
