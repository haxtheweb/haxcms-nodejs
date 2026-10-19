// Security parity with haxcms-php (security_best_practices_report_2026-10-19):
//   L-2  refresh cookie is Secure on HTTPS requests (not only NODE_ENV=production)
//   L-3  request tokens use a key domain-separated from the JWT signing key
//   L-7  JWT id claim compared constant-time and type-strict
// Constraints honored: CommonJS (.cjs), require(), no optional chaining.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");

function withKeys(t, privateKey, salt) {
  const saved = { privateKey: HAXCMS.privateKey, salt: HAXCMS.salt };
  HAXCMS.privateKey = privateKey;
  HAXCMS.salt = salt;
  t.after(() => {
    HAXCMS.privateKey = saved.privateKey;
    HAXCMS.salt = saved.salt;
  });
}

function withNodeEnv(t, value) {
  const saved = process.env.NODE_ENV;
  if (value === null) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
  t.after(() => {
    if (saved === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = saved;
    }
  });
}

function withSecurityConfig(t, security) {
  const saved = HAXCMS.config.security;
  HAXCMS.config.security = security;
  t.after(() => {
    HAXCMS.config.security = saved;
  });
}

// ---- L-3 -----------------------------------------------------------------

test("getRequestToken matches the PHP known-good literal (cross-backend parity)", (t) => {
  withKeys(t, "pk", "s");
  // same literal haxcms-php HAXCMSRequestTokenTest asserts for pk / s / 'user'
  assert.equal(
    HAXCMS.getRequestToken("user"),
    "qMulgGEW5_tZQ1jX6yE-c51mq5fN9v_D2e9DBzYCj3g",
  );
  assert.equal(
    HAXCMS.getRequestToken("alice:mysite"),
    "yfT3CEQxEvVqMfc7L8J6agoLpm4rIXGSTM5gJMg4SDw",
  );
});

test("request-token key is separated from the JWT signing key", (t) => {
  withKeys(t, "pk", "s");
  const direct = crypto
    .createHmac("sha256", "pks")
    .update("user")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.notEqual(HAXCMS.getRequestToken("user"), direct);
});

// ---- L-7 -----------------------------------------------------------------

test("validateRequestToken stays constant-time and rejects non-matching tokens", (t) => {
  const token = HAXCMS.getRequestToken("alice");
  const savedDisable = HAXCMS.HAXCMS_DISABLE_JWT_CHECKS;
  HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = false;
  t.mock.method(HAXCMS, "isCLI", () => false);
  t.after(() => {
    HAXCMS.HAXCMS_DISABLE_JWT_CHECKS = savedDisable;
  });
  assert.equal(HAXCMS.validateRequestToken(token, "alice"), true);
  assert.equal(HAXCMS.validateRequestToken(token, "bob"), false);
  assert.equal(HAXCMS.validateRequestToken("nope", "alice"), false);
});

test("a JWT whose id is not a string never authenticates", (t) => {
  const user = HAXCMS.getActiveUserName();
  const forged = require("jsonwebtoken").sign(
    {
      id: [HAXCMS.getRequestToken("user")],
      user: user,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    HAXCMS.privateKey + HAXCMS.salt,
  );
  assert.equal(
    HAXCMS.getRequestAuthenticatedUserName({
      headers: { authorization: "Bearer " + forged },
      cookies: {},
    }),
    "",
  );
  const good = HAXCMS.getJWT(user);
  assert.equal(
    HAXCMS.getRequestAuthenticatedUserName({
      headers: { authorization: "Bearer " + good },
      cookies: {},
    }),
    user,
  );
});

// ---- L-2 -----------------------------------------------------------------

test("refreshCookieShouldBeSecure: production, HTTPS request, or forceSecureCookie", (t) => {
  withNodeEnv(t, null);
  withSecurityConfig(t, {});
  assert.equal(
    HAXCMS.refreshCookieShouldBeSecure(null),
    false,
    "no request, dev",
  );
  assert.equal(
    HAXCMS.refreshCookieShouldBeSecure({ protocol: "http", headers: {} }),
    false,
    "plain HTTP dev stays non-Secure",
  );
  assert.equal(
    HAXCMS.refreshCookieShouldBeSecure({ protocol: "https", headers: {} }),
    true,
    "HTTPS request gets Secure",
  );
  // untrusted X-Forwarded-Proto is ignored (no trusted proxy configured)
  assert.equal(
    HAXCMS.refreshCookieShouldBeSecure({
      protocol: "http",
      headers: { "x-forwarded-proto": "https" },
    }),
    false,
  );
  HAXCMS.config.security = { forceSecureCookie: true };
  assert.equal(
    HAXCMS.refreshCookieShouldBeSecure({ protocol: "http", headers: {} }),
    true,
    "forceSecureCookie honoured",
  );
  HAXCMS.config.security = {};
  process.env.NODE_ENV = "production";
  assert.equal(
    HAXCMS.refreshCookieShouldBeSecure({ protocol: "http", headers: {} }),
    true,
    "production always Secure",
  );
});

test("setRefreshTokenCookie reads the request from res.req for the Secure flag", (t) => {
  withNodeEnv(t, null);
  withSecurityConfig(t, {});
  const calls = [];
  const res = {
    req: { protocol: "https", headers: {} },
    cookie: (name, value, options) => calls.push({ name, value, options }),
  };
  HAXCMS.setRefreshTokenCookie(res, "abc", 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.secure, true);
  assert.equal(calls[0].options.httpOnly, true);
  assert.equal(calls[0].options.sameSite, "lax");
  res.req = { protocol: "http", headers: {} };
  HAXCMS.setRefreshTokenCookie(res, "abc", 1000);
  assert.equal(calls[1].options.secure, false);
});
