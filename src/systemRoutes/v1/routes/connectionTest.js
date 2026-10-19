const { HAXCMS } = require('../../../lib/HAXCMS.js');

function getRequestJWT(req) {
  if (
    req &&
    req.headers &&
    typeof req.headers.authorization === 'string' &&
    req.headers.authorization.trim() !== ''
  ) {
    const authorizationHeader = req.headers.authorization.trim();
    if (authorizationHeader.toLowerCase().indexOf('bearer ') === 0) {
      return authorizationHeader.substring(7).trim();
    }
  }
  return null;
}

function getValidatedJWTFromRequest(req, res) {
  const requestedJWT = getRequestJWT(req);
  if (!requestedJWT) {
    return null;
  }
  if (!HAXCMS.validateJWT(req, res)) {
    return null;
  }
  return requestedJWT;
}

function getValidatedJWTFromRefresh(req, res) {
  const validRefresh = HAXCMS.validateRefreshToken(false, req, res);
  if (!validRefresh || !validRefresh.user) {
    return null;
  }
  const validUser = HAXCMS.validateUser(validRefresh.user);
  if (!validUser) {
    return null;
  }
  // Security (H1 rotation + SEC-SESSION): reject a revoked/stolen/unknown
  // refresh family before minting an access token. Only legacy tokens that
  // carry NO family claim are accepted without a store entry.
  if (!HAXCMS.validateRefreshSession(validRefresh.user, validRefresh.family, validRefresh.jti, validRefresh.iat)) {
    HAXCMS.revokeRefreshSession(validRefresh.user, validRefresh.family || null);
    HAXCMS.setRefreshTokenCookie(res, '', 1);
    return null;
  }
  // rotate the refresh cookie on recovery so a stolen cookie is bounded.
  // Security (SEC-SESSION): a rejected rotation (replay / revoked family)
  // is authoritative -- do NOT fall back to minting an access token.
  const rotated = HAXCMS.rotateRefreshTokenAndCookie(res, validRefresh);
  if (!rotated) {
    HAXCMS.revokeRefreshSession(validRefresh.user, validRefresh.family || null);
    HAXCMS.setRefreshTokenCookie(res, '', 1);
    return null;
  }
  return rotated;
}

function resolveAuthenticatedUser(req, jwt) {
  if (jwt) {
    const decoded = HAXCMS.decodeJWT(jwt);
    if (decoded && decoded.user) {
      return String(decoded.user);
    }
  }
  if (req && req.cookies && req.cookies.haxcms_refresh_token) {
    const refreshDecoded = HAXCMS.decodeRefreshToken(
      req.cookies.haxcms_refresh_token,
    );
    if (refreshDecoded && refreshDecoded.user) {
      return String(refreshDecoded.user);
    }
  }
  return '';
}

function validateIAMAuthorizationIfNeeded(req) {
  if (typeof HAXCMS.validateIAMRouteAuthorization !== 'function') {
    return { allowed: true };
  }
  try {
    return HAXCMS.validateIAMRouteAuthorization(true, req);
  }
  catch (e) {
    return {
      allowed: false,
      status: 403,
      message: 'Access denied',
    };
  }
}

/**
 * @OA\Get(
 *    path="/connectionTest",
 *    tags={"cms","user"},
 *    @OA\Response(
 *        response="200",
 *        description="Validate current auth state before presenting authenticated UI"
 *   )
 * )
 * @OA\Post(
 *    path="/connectionTest",
 *    tags={"cms","user"},
 *    @OA\Response(
 *        response="200",
 *        description="Validate current auth state before presenting authenticated UI"
 *   )
 * )
 */
async function connectionTest(req, res) {
  // Auth-state probes must never be cached: a cached authenticated body could
  // be served to a different user (token leak), and a cached anonymous body
  // could mask a now-logged-in session. Applies to every response branch.
  res.setHeader('Cache-Control', 'no-store');
  let refreshed = false;
  // Capture whether a Bearer credential was supplied so we can distinguish an
  // anonymous probe (no Authorization header, no valid refresh cookie) from a
  // supplied-but-rejected credential. The anonymous case is the majority
  // audience and must not surface a 401 just for checking session state.
  const suppliedBearerJWT = getRequestJWT(req);
  let jwt = getValidatedJWTFromRequest(req, res);
  if (!jwt) {
    // Security (SEC-SESSION): falling back to the refresh cookie ROTATES it
    // (state change authenticated only by a cookie), so apply the same
    // same-origin / Sec-Fetch-Site gate session/refresh uses.
    if (
      req &&
      req.cookies &&
      req.cookies.haxcms_refresh_token &&
      !HAXCMS.isSameOriginRequest(req)
    ) {
      HAXCMS.setRefreshTokenCookie(res, '', 1);
      return res.status(403).json({
        status: 403,
        authenticated: false,
        reason: 'cross_origin',
        message: 'Cross-origin request denied',
      });
    }
    jwt = getValidatedJWTFromRefresh(req, res);
    refreshed = !!jwt;
  }

  if (!jwt) {
    // Security (HAX-SEC / PHP [M3] parity): clear via the centralized helper so
    // the Secure/SameSite/HttpOnly flags match how the cookie was set (required
    // for the browser to actually delete it).
    HAXCMS.setRefreshTokenCookie(res, '', 1);
    // Anonymous probe (no Bearer and no valid refresh cookie): answer 200 with
    // authenticated:false so the logged-out majority doesn't see a 401 in the
    // console / network panel. Reserve 401 for when a credential was actually
    // supplied but rejected (stale/expired Bearer that validateJWT rejected).
    if (suppliedBearerJWT) {
      return res.status(401).json({
        status: 401,
        authenticated: false,
        reason: 'invalid_session',
        message: 'Authentication failed',
      });
    }
    return res.status(200).json({
      status: 200,
      authenticated: false,
      reason: 'no_session',
      message: 'No active session',
    });
  }

  const iamAuthorization = validateIAMAuthorizationIfNeeded(req);
  if (
    iamAuthorization &&
    typeof iamAuthorization === 'object' &&
    iamAuthorization.allowed === false
  ) {
    return res.status(iamAuthorization.status || 403).json({
      status: iamAuthorization.status || 403,
      authenticated: false,
      reason: 'not_authorized',
      message: iamAuthorization.message || 'Access denied',
    });
  }

  // Security (SEC-SESSION): include fresh request tokens (userToken, and
  // siteToken when a site context is resolvable) for an editor that booted
  // anonymously from connection-settings.
  let sessionTokens = {};
  try {
    sessionTokens = await HAXCMS.getSessionRequestTokens(req);
  }
  catch (e) {
    sessionTokens = {};
  }
  return res.json(Object.assign({
    status: 200,
    authenticated: true,
    jwt,
    refreshed,
    user: resolveAuthenticatedUser(req, jwt),
  }, sessionTokens));
}

module.exports = connectionTest;
