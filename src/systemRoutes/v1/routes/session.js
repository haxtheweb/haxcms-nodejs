const { HAXCMS } = require('../../../lib/HAXCMS.js')

function getRequestJWT(req) {
  if (
    req &&
    req.headers &&
    typeof req.headers.authorization === 'string' &&
    req.headers.authorization.trim() !== ''
  ) {
    const authorizationHeader = req.headers.authorization.trim()
    if (authorizationHeader.toLowerCase().indexOf('bearer ') === 0) {
      return authorizationHeader.substring(7).trim()
    }
  }
  return ''
}

function getAuthenticatedUserName(jwt = '') {
  const decoded = HAXCMS.decodeJWT(jwt)
  if (decoded && decoded.user) {
    return String(decoded.user)
  }
  return ''
}

function validateIAMAuthorizationIfNeeded(req, jwt) {
  if (typeof HAXCMS.validateIAMRouteAuthorization !== 'function') {
    return { allowed: true }
  }
  try {
    // Security (review 2026-10): validateIAMRouteAuthorization now exists
    // (was undefined -> silent allow); it needs the request to resolve the
    // tenant and principal.
    return HAXCMS.validateIAMRouteAuthorization(true, req, jwt)
  }
  catch (e) {
    return {
      allowed: false,
      status: 403,
      message: 'Access denied',
    }
  }
}

function sessionRoute(req, res) {
  const requestedJWT = getRequestJWT(req)
  if (requestedJWT === '') {
    return res.status(401).json({
      status: 401,
      authenticated: false,
      reason: 'missing_jwt',
      message: 'Authorization bearer token is required',
    })
  }
  if (!HAXCMS.validateJWT(req, res)) {
    return res.status(401).json({
      status: 401,
      authenticated: false,
      reason: 'invalid_jwt',
      message: 'Authentication failed',
    })
  }

  const iamAuthorization = validateIAMAuthorizationIfNeeded(req, requestedJWT)
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
    })
  }

  return res.json({
    status: 200,
    authenticated: true,
    jwt: requestedJWT,
    user: getAuthenticatedUserName(requestedJWT),
  })
}

module.exports = sessionRoute
