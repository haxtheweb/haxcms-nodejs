const { HAXCMS } = require("../../../lib/HAXCMS.js");
const { getLoginAttempt } = require("../../../lib/loginRateLimiter.js");
async function loginRoute(req, res) {
  // primary branch: username / password login
  if (req.body && req.body.username && req.body.password) {
    const u = req.body.username;
    const p = req.body.password;
    const settings = HAXCMS.getLoginRateLimitSettings();
    const now = Date.now();
    // Security: throttled on ip::username AND on the username alone so a
    // distributed guess against one account is still limited.
    const attempt = getLoginAttempt(req, u, now, settings);
    if (settings.enabled && attempt.isBlocked()) {
      const retryAfterSeconds = Math.ceil(
        (attempt.blockedUntil() - now) / 1000,
      );
      if (retryAfterSeconds > 0) {
        res.set("Retry-After", String(retryAfterSeconds));
      }
      // D2: JSON D1 envelope (was sendStatus plain-text)
      return res.status(429).json({
        status: 429,
        data: {
          message: "Too many failed login attempts. Please try again later.",
        },
      });
    }
    // test if this is a valid user login
    if (!HAXCMS.testLogin(u, p, true)) {
      if (settings.enabled) {
        attempt.registerFailure();
      }
      // D2/Q8: login failure returns 401 (was 403) with JSON D1 envelope
      return res.status(401).json({
        status: 401,
        data: { message: "Invalid username or password" },
      });
    }
    attempt.clear();
    // set a refresh_token COOKIE that will ship w/ all calls automatically
    // Security (HAX-SEC / PHP [M3] parity): use the centralized helper so
    // Secure/SameSite/HttpOnly/path flags are consistent at every call site.
    HAXCMS.setRefreshTokenCookie(
      res,
      HAXCMS.getRefreshToken(u),
      24 * 60 * 60 * 1000,
    );
    // Security (SEC-SESSION): connection-settings omits request tokens for
    // anonymous callers and the editor loads it once per page, so hand the
    // request tokens back with the JWT for an in-page login: userToken always,
    // siteToken when a site context resolves (login from a site page), the
    // same shape refresh and connection-test return.
    let sessionTokens = {};
    try {
      sessionTokens = await HAXCMS.getSessionRequestTokens(req);
    } catch {
      sessionTokens = {};
    }
    if (!sessionTokens || typeof sessionTokens.userToken !== "string") {
      // Security: `u` is the identity just verified by HAXCMS.testLogin above
      // for this request, so mint the fallback token against it rather than
      // a process-global username.
      sessionTokens = Object.assign({}, sessionTokens, {
        userToken: HAXCMS.getRequestToken(u),
      });
    }
    return res.json(
      Object.assign(
        {
          status: 200,
          jwt: HAXCMS.getJWT(u),
        },
        sessionTokens,
      ),
    );
  }
  // login end point requested yet a jwt already exists
  // this is something of a revalidate case (PHP parity: login.php login())
  else if (
    (req.body && Object.keys(req.body).length && req.body["jwt"]) ||
    (req.query && Object.keys(req.query).length && req.query["jwt"])
  ) {
    const user = getRevalidatedUser(req);
    if (user !== "") {
      // PHP parity: answer with a fresh token the client can store, not a
      // boolean
      return res.json({
        status: 200,
        jwt: HAXCMS.getJWT(user),
      });
    }
    // D2/Q8: JWT revalidate failure returns 401 (was 403) with JSON envelope
    return res.status(401).json({
      status: 401,
      data: { message: "Invalid token" },
    });
  } else {
    // D2/Q8: no credentials supplied returns 401 (was 403) with JSON envelope
    res.status(401).json({
      status: 401,
      data: { message: "Login is required" },
    });
  }
}

/**
 * The jwt sent with the revalidate request: body first, then query, the same
 * precedence PHP gets from its merged params.
 */
function getSuppliedJwt(req) {
  const sources = [req.body, req.query];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (source && typeof source.jwt === "string" && source.jwt.trim() !== "") {
      return source.jwt.trim();
    }
  }
  return "";
}

/**
 * Resolve who a revalidate request is for. PHP decodes the supplied (body /
 * query) jwt and falls back to the bearer header when it is blank; a token
 * only counts when it decodes, carries this server's user request token and
 * names a valid user (same checks as HAXCMS.validateJWT). Returns "" when
 * nothing verifies.
 */
function getRevalidatedUser(req) {
  if (
    HAXCMS.isCLI() ||
    (HAXCMS.HAXCMS_DISABLE_JWT_CHECKS && !HAXCMS.isProductionRuntime())
  ) {
    return HAXCMS.getActiveUserName() || "";
  }
  let token = getSuppliedJwt(req);
  if (
    token === "" &&
    req.headers &&
    typeof req.headers.authorization === "string"
  ) {
    const authorizationHeader = req.headers.authorization.trim();
    if (authorizationHeader.toLowerCase().indexOf("bearer ") === 0) {
      token = authorizationHeader.substring(7).trim();
    }
  }
  if (token === "") {
    return "";
  }
  const decoded = HAXCMS.decodeJWT(token);
  if (
    decoded &&
    typeof decoded.id === "string" &&
    // Security (L-7, PHP parity): constant-time, type-strict compare.
    HAXCMS.safeStringCompare(HAXCMS.getRequestToken("user"), decoded.id) &&
    decoded.user &&
    HAXCMS.validateUser(decoded.user)
  ) {
    return String(decoded.user);
  }
  return "";
}

module.exports = loginRoute;
