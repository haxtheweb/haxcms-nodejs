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
  return HAXCMS.getJWT(validRefresh.user);
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

function validateIAMAuthorizationIfNeeded() {
  if (typeof HAXCMS.validateIAMRouteAuthorization !== 'function') {
    return { allowed: true };
  }
  try {
    return HAXCMS.validateIAMRouteAuthorization(true);
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
function connectionTest(req, res) {
  let refreshed = false;
  let jwt = getValidatedJWTFromRequest(req, res);
  if (!jwt) {
    jwt = getValidatedJWTFromRefresh(req, res);
    refreshed = !!jwt;
  }

  if (!jwt) {
    res.cookie('haxcms_refresh_token', '1', { maxAge: 1 });
    return res.status(401).json({
      status: 401,
      authenticated: false,
      reason: 'invalid_session',
      message: 'Authentication failed',
    });
  }

  const iamAuthorization = validateIAMAuthorizationIfNeeded();
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

  return res.json({
    status: 200,
    authenticated: true,
    jwt,
    refreshed,
    user: resolveAuthenticatedUser(req, jwt),
  });
}

module.exports = connectionTest;
