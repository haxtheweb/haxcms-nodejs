"use strict";

// auth: session/login contract
//
// POST /system/api/v1/session/login (src/systemRoutes/v1/routes/login.js) is
// the only door to a JWT. This pins its whole truth table at the route level:
//   - credential login: 401 + attempt counted on bad credentials, 429 +
//     Retry-After once the limiter blocks (and the right password does NOT
//     get through while blocked), success clears the counter, sets the
//     refresh cookie with safe flags, and returns a JWT that validates plus
//     the request tokens (with the userToken fallback when the session token
//     helper fails or comes back empty)
//   - limiter disabled: failures are never counted
//   - JWT revalidate (body / query `jwt`): 200 for a valid bearer, 401 for a
//     forged one
//   - no credentials at all: 401 envelope
// Revalidate decodes the body / query jwt and answers a fresh token, as
// haxcms-php does.
//
// Parity: haxcms-php carries a test under the same name for the same route.
// Credentials are minted per run (crypto.randomBytes); the limiter is keyed by
// a per-test IP so tests never share counters. CommonJS, globalThis, NO
// optional chaining, node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JWT = require("jsonwebtoken");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const loginRoute = require("../../src/systemRoutes/v1/routes/login.js");
const loginRateLimiter = require("../../src/lib/loginRateLimiter.js");

const ACTIVE_USER = HAXCMS.getActiveUserName();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-login-route-"));
let counter = 0;

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function secret() {
  return crypto.randomBytes(12).toString("hex");
}

// a fresh client IP per test so limiter entries never collide
function nextIp() {
  counter += 1;
  return "203.0.113." + counter;
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    cookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    send(obj) {
      this.body = obj;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    cookie(name, value, options) {
      this.cookies.push({ name: name, value: value, options: options });
    },
  };
}

// hermetic: refresh-session store in a temp file, a known password check, and
// a limiter config the test controls
function setup(t, opts) {
  counter += 1;
  const storePath = path.join(
    tempRoot,
    "store-" + counter,
    "refreshSessions.json",
  );
  t.mock.method(HAXCMS, "getRefreshSessionsPath", () => storePath);
  const goodPassword = secret();
  // login.js checks passwords with testLoginAsync (off the event loop);
  // testLogin is mocked too so a caller on either path sees the same answer
  const checkPassword = (u, p) => u === ACTIVE_USER && p === goodPassword;
  t.mock.method(HAXCMS, "testLogin", checkPassword);
  t.mock.method(HAXCMS, "testLoginAsync", async (u, p) => checkPassword(u, p));
  const limiter = {
    enabled: !(opts && opts.limiterDisabled),
    windowMs: 60 * 1000,
    maxAttempts: 3,
    blockMs: 60 * 1000,
  };
  t.mock.method(HAXCMS, "getLoginRateLimitSettings", () => limiter);
  return { goodPassword: goodPassword, limiter: limiter };
}

async function login(ip, username, password, extra) {
  const res = fakeRes();
  const req = Object.assign(
    {
      body: { username: username, password: password },
      query: {},
      headers: {},
      ip: ip,
    },
    extra || {},
  );
  await loginRoute(req, res);
  return res;
}

describe("auth: session/login contract — credential login", () => {
  test("a wrong password is a 401 envelope and counts one failed attempt", async (t) => {
    const ctx = setup(t);
    const ip = nextIp();
    const res = await login(ip, ACTIVE_USER, secret());
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      status: 401,
      data: { message: "Invalid username or password" },
    });
    assert.equal(res.cookies.length, 0, "no refresh cookie on failure");
    const entry = loginRateLimiter.getTrackerEntry(
      loginRateLimiter.getAttemptKey({ ip: ip }, ACTIVE_USER),
      Date.now(),
      ctx.limiter,
    );
    assert.equal(entry.failedAttempts, 1);
  });

  test("reaching maxAttempts blocks with 429 + Retry-After, even for the right password", async (t) => {
    const ctx = setup(t);
    const ip = nextIp();
    for (let i = 0; i < ctx.limiter.maxAttempts; i++) {
      const res = await login(ip, ACTIVE_USER, secret());
      assert.equal(res.statusCode, 401, "attempt " + (i + 1));
    }
    const blocked = await login(ip, ACTIVE_USER, ctx.goodPassword);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.status, 429);
    assert.equal(
      blocked.body.data.message,
      "Too many failed login attempts. Please try again later.",
    );
    const retryAfter = Number(blocked.headers["Retry-After"]);
    assert.ok(retryAfter > 0 && retryAfter <= 60, "Retry-After within blockMs");
    assert.equal(
      blocked.cookies.length,
      0,
      "a blocked login never sets a cookie",
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(blocked.body, "jwt"),
      false,
      "a blocked login never hands back a JWT",
    );
  });

  test("the block is per ip+username: another IP can still log in", async (t) => {
    const ctx = setup(t);
    const ip = nextIp();
    for (let i = 0; i < ctx.limiter.maxAttempts; i++) {
      await login(ip, ACTIVE_USER, secret());
    }
    const other = await login(nextIp(), ACTIVE_USER, ctx.goodPassword);
    assert.equal(other.statusCode, 200);
    assert.equal(other.body.status, 200);
  });

  test("with the limiter disabled, failures are never counted or blocked", async (t) => {
    const ctx = setup(t, { limiterDisabled: true });
    const ip = nextIp();
    for (let i = 0; i < ctx.limiter.maxAttempts + 2; i++) {
      const res = await login(ip, ACTIVE_USER, secret());
      assert.equal(res.statusCode, 401);
    }
    const ok = await login(ip, ACTIVE_USER, ctx.goodPassword);
    assert.equal(ok.statusCode, 200);
  });

  test("success clears the counter, sets a safe refresh cookie and returns a valid JWT + user token", async (t) => {
    const ctx = setup(t);
    const ip = nextIp();
    await login(ip, ACTIVE_USER, secret());
    await login(ip, ACTIVE_USER, secret());
    const res = await login(ip, ACTIVE_USER, ctx.goodPassword);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 200);
    // the counter is gone: a fresh entry starts at zero
    const entry = loginRateLimiter.getTrackerEntry(
      loginRateLimiter.getAttemptKey({ ip: ip }, ACTIVE_USER),
      Date.now(),
      ctx.limiter,
    );
    assert.equal(entry.failedAttempts, 0);
    // refresh cookie flags
    assert.equal(res.cookies.length, 1);
    const cookie = res.cookies[0];
    assert.equal(cookie.name, "haxcms_refresh_token");
    assert.equal(typeof cookie.value, "string");
    assert.ok(cookie.value.length > 0);
    assert.equal(cookie.options.httpOnly, true);
    assert.equal(cookie.options.sameSite, "lax");
    assert.equal(cookie.options.path, "/");
    assert.equal(cookie.options.maxAge, 24 * 60 * 60 * 1000);
    // the JWT is a real access token for this user
    assert.equal(typeof res.body.jwt, "string");
    const decoded = HAXCMS.decodeJWT(res.body.jwt);
    assert.ok(decoded, "JWT verifies with the server key");
    assert.equal(decoded.user, ACTIVE_USER);
    assert.equal(decoded.exp - decoded.iat, 15 * 60, "15 minute access token");
    assert.ok(
      HAXCMS.validateJWT({
        headers: { authorization: "Bearer " + res.body.jwt },
      }),
      "the issued JWT passes validateJWT as a bearer",
    );
    assert.equal(res.body.userToken, HAXCMS.getRequestToken(ACTIVE_USER));
  });

  test("when the session token helper throws, userToken still comes back", async (t) => {
    const ctx = setup(t);
    t.mock.method(HAXCMS, "getSessionRequestTokens", async () => {
      throw new Error("boom");
    });
    const res = await login(nextIp(), ACTIVE_USER, ctx.goodPassword);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.userToken, HAXCMS.getRequestToken(ACTIVE_USER));
    assert.equal(typeof res.body.jwt, "string");
  });

  test("when the session token helper has no userToken, the fallback keeps its siteToken", async (t) => {
    const ctx = setup(t);
    const siteToken = secret();
    t.mock.method(HAXCMS, "getSessionRequestTokens", async () => ({
      siteToken: siteToken,
    }));
    const res = await login(nextIp(), ACTIVE_USER, ctx.goodPassword);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.userToken, HAXCMS.getRequestToken(ACTIVE_USER));
    assert.equal(res.body.siteToken, siteToken);
  });

  test("username without password (or the reverse) is not a credential login", async (t) => {
    setup(t);
    const onlyUser = fakeRes();
    await loginRoute(
      { body: { username: ACTIVE_USER }, query: {}, headers: {}, ip: nextIp() },
      onlyUser,
    );
    assert.equal(onlyUser.statusCode, 401);
    assert.deepEqual(onlyUser.body, {
      status: 401,
      data: { message: "Login is required" },
    });
    const onlyPass = fakeRes();
    await loginRoute(
      { body: { password: secret() }, query: {}, headers: {}, ip: nextIp() },
      onlyPass,
    );
    assert.equal(onlyPass.statusCode, 401);
    assert.equal(onlyPass.body.data.message, "Login is required");
  });
});

describe("auth: session/login contract — JWT revalidate and no credentials", () => {
  test("no body and no query is a 401 Login is required envelope", async () => {
    const res = fakeRes();
    await loginRoute({ headers: {}, ip: nextIp() }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      status: 401,
      data: { message: "Login is required" },
    });
  });

  test("an empty body and empty query is a 401 Login is required envelope", async () => {
    const res = fakeRes();
    await loginRoute({ body: {}, query: {}, headers: {}, ip: nextIp() }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.data.message, "Login is required");
  });

  test("revalidate with a forged jwt (body or query) is a 401 Invalid token", async () => {
    const forged = JWT.sign(
      { id: "x", user: ACTIVE_USER },
      crypto.randomBytes(32).toString("hex"),
    );
    const viaBody = fakeRes();
    await loginRoute(
      {
        body: { jwt: forged },
        query: {},
        headers: { authorization: "Bearer " + forged },
        ip: nextIp(),
      },
      viaBody,
    );
    assert.equal(viaBody.statusCode, 401);
    assert.deepEqual(viaBody.body, {
      status: 401,
      data: { message: "Invalid token" },
    });
    const viaQuery = fakeRes();
    await loginRoute(
      {
        body: {},
        query: { jwt: forged },
        headers: { authorization: "Bearer " + forged },
        ip: nextIp(),
      },
      viaQuery,
    );
    assert.equal(viaQuery.statusCode, 401);
    assert.equal(viaQuery.body.data.message, "Invalid token");
  });

  test("revalidate with a valid bearer answers 200", async () => {
    const jwt = HAXCMS.getJWT(ACTIVE_USER);
    const res = fakeRes();
    await loginRoute(
      {
        body: { jwt: jwt },
        query: {},
        headers: { authorization: "Bearer " + jwt },
        ip: nextIp(),
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 200);
  });

  // parity with haxcms-php login.php: the body jwt is what gets decoded
  test("revalidate with a valid body jwt and no bearer answers 200", async () => {
    const jwt = HAXCMS.getJWT(ACTIVE_USER);
    const res = fakeRes();
    await loginRoute(
      { body: { jwt: jwt }, query: {}, headers: {}, ip: nextIp() },
      res,
    );
    assert.equal(res.statusCode, 200);
  });

  // parity with haxcms-php login.php: a fresh token string, not a boolean
  test("revalidate returns a fresh JWT string", async () => {
    const jwt = HAXCMS.getJWT(ACTIVE_USER);
    const res = fakeRes();
    await loginRoute(
      {
        body: { jwt: jwt },
        query: {},
        headers: { authorization: "Bearer " + jwt },
        ip: nextIp(),
      },
      res,
    );
    assert.equal(typeof res.body.jwt, "string");
    assert.ok(HAXCMS.decodeJWT(res.body.jwt));
  });
});
