// Login revalidate parity with haxcms-php (haxtheweb/issues#3254).
//
// POST session/login with a `jwt` (body or query) and no username/password is
// the revalidate case. PHP (operations/login.php login()) decodes the
// supplied jwt (falling back to the bearer header when it is blank) and
// answers 200 with a FRESH token string; anything that doesn't verify is a
// 401 "Invalid token", and no credentials at all is a 401 "Login is required".
// Node used to read only the Authorization header, answered `jwt: true`, and
// used different messages.
//
// CommonJS, NO optional chaining, node:test + node:assert/strict.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const JWT = require("jsonwebtoken");

const { HAXCMS } = require("../../src/lib/HAXCMS.js");
const loginRoute = require("../../src/systemRoutes/v1/routes/login.js");

const ACTIVE_USER = HAXCMS.getActiveUserName();
let counter = 0;

function nextIp() {
  counter += 1;
  return "198.51.100." + counter;
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
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
    cookie() {},
  };
}

async function revalidate(req) {
  const res = fakeRes();
  await loginRoute(
    Object.assign({ body: {}, query: {}, headers: {}, ip: nextIp() }, req),
    res,
  );
  return res;
}

function assertFreshToken(res) {
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 200);
  assert.equal(typeof res.body.jwt, "string", "a token string, not a boolean");
  const decoded = HAXCMS.decodeJWT(res.body.jwt);
  assert.ok(decoded, "the returned token verifies");
  assert.equal(decoded.user, ACTIVE_USER);
}

describe("login revalidate (PHP parity)", () => {
  test("a valid body jwt with no bearer header answers 200 with a fresh token", async () => {
    assertFreshToken(
      await revalidate({ body: { jwt: HAXCMS.getJWT(ACTIVE_USER) } }),
    );
  });

  test("a valid query jwt answers 200 with a fresh token", async () => {
    assertFreshToken(
      await revalidate({ query: { jwt: HAXCMS.getJWT(ACTIVE_USER) } }),
    );
  });

  test("a valid bearer header with a matching body jwt still answers a token string", async () => {
    const jwt = HAXCMS.getJWT(ACTIVE_USER);
    assertFreshToken(
      await revalidate({
        body: { jwt: jwt },
        headers: { authorization: "Bearer " + jwt },
      }),
    );
  });

  test("the supplied jwt is what gets checked: a forged body jwt is refused even with a valid bearer", async () => {
    // PHP replaces the session jwt with the body one before validating
    const res = await revalidate({
      body: { jwt: "not-a-token" },
      headers: { authorization: "Bearer " + HAXCMS.getJWT(ACTIVE_USER) },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.data.message, "Invalid token");
  });

  test("a whitespace-only body jwt falls back to the bearer header", async () => {
    // PHP only swaps in the body jwt when it is non-blank after trim
    assertFreshToken(
      await revalidate({
        body: { jwt: "   " },
        headers: { authorization: "Bearer " + HAXCMS.getJWT(ACTIVE_USER) },
      }),
    );
  });

  test("a jwt signed with the wrong key is refused", async () => {
    const forged = JWT.sign(
      { id: HAXCMS.getRequestToken("user"), user: ACTIVE_USER },
      crypto.randomBytes(32).toString("hex"),
      { algorithm: "HS256" },
    );
    const res = await revalidate({ body: { jwt: forged } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.status, 401);
    assert.equal(res.body.data.message, "Invalid token");
  });

  test("a correctly signed jwt without this server's user token is refused", async () => {
    const wrongId = JWT.sign(
      { id: crypto.randomBytes(16).toString("hex"), user: ACTIVE_USER },
      HAXCMS.privateKey + HAXCMS.salt,
      { algorithm: "HS256" },
    );
    const res = await revalidate({ body: { jwt: wrongId } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.data.message, "Invalid token");
  });

  test("an expired jwt is refused", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = JWT.sign(
      {
        id: HAXCMS.getRequestToken("user"),
        user: ACTIVE_USER,
        iat: now - 7200,
        exp: now - 3600,
      },
      HAXCMS.privateKey + HAXCMS.salt,
      { algorithm: "HS256" },
    );
    const res = await revalidate({ body: { jwt: expired } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.data.message, "Invalid token");
  });

  test("no credentials at all answers 401 Login is required", async () => {
    const res = await revalidate({});
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.status, 401);
    assert.equal(res.body.data.message, "Login is required");
  });
});
