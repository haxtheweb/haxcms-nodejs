// Security (SEC-DEPLOY): choose the network interface the HTTP(S) server binds.
//
// - HAXCMS_HOST, when set to a non-empty value, always wins. This is the
//   explicit escape hatch (e.g. HAXCMS_HOST=0.0.0.0 to reach a no-login local
//   instance from another device on the LAN, or a specific interface address).
// - Otherwise, when the local-development auth bypass (HAXCMS_DISABLE_JWT_CHECKS,
//   set by `npx @haxtheweb/haxcms-nodejs` / src/local.js) is active, bind the
//   IPv4 loopback only so an unauthenticated instance is never reachable from
//   the network by default.
// - Otherwise keep the historical behaviour: `undefined` lets Node bind every
//   interface (`::` / `0.0.0.0`), which containers and reverse proxies rely on.

const LOOPBACK_HOST = '127.0.0.1';

function selectListenHost(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  let explicit = typeof env.HAXCMS_HOST === 'string' ? env.HAXCMS_HOST.trim() : '';
  // accept a bracketed IPv6 literal ([::1]) — server.listen wants it bare
  if (explicit.charAt(0) === '[' && explicit.charAt(explicit.length - 1) === ']') {
    explicit = explicit.substring(1, explicit.length - 1).trim();
  }
  if (explicit !== '') {
    return explicit;
  }
  if (opts.jwtChecksDisabled) {
    return LOOPBACK_HOST;
  }
  return undefined;
}

function isLoopbackHost(host) {
  if (typeof host !== 'string') {
    // undefined / null means "all interfaces"
    return false;
  }
  let value = host.trim().toLowerCase();
  if (value.charAt(0) === '[' && value.charAt(value.length - 1) === ']') {
    value = value.substring(1, value.length - 1);
  }
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (value.indexOf('::ffff:') === 0) {
    value = value.substring(7);
  }
  // the whole 127.0.0.0/8 block is loopback
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

// Loud warning text when the auth bypass is active on a non-loopback bind.
// Returns null when no warning is needed.
function getBypassExposureWarning(host, jwtChecksDisabled) {
  if (!jwtChecksDisabled || isLoopbackHost(host)) {
    return null;
  }
  const shown = (typeof host === 'string' && host.trim() !== '') ? host : 'all interfaces';
  return [
    '***************************************************************',
    'SECURITY WARNING: HAXCMS_DISABLE_JWT_CHECKS is active (no login) and',
    `the server is listening on ${shown}. ANYONE who can reach this`,
    'machine over the network can read and modify every site WITHOUT',
    'authenticating. Unset HAXCMS_HOST (defaults to 127.0.0.1 in this',
    'mode) unless you fully trust the network.',
    '***************************************************************',
  ].join('\n');
}

// Host to use in the printed / auto-opened URL. Wildcard binds keep the
// familiar `localhost`. An IPv4 loopback bind uses that exact address:
// `localhost` may resolve to ::1 first, which nothing is listening on. Any
// other specific interface address is shown as-is (IPv6 bracketed).
function getBrowserHost(host) {
  if (typeof host !== 'string' || host.trim() === '') {
    return 'localhost';
  }
  let value = host.trim();
  if (value.charAt(0) === '[' && value.charAt(value.length - 1) === ']') {
    value = value.substring(1, value.length - 1);
  }
  if (value === '0.0.0.0' || value === '::' || value.toLowerCase() === 'localhost') {
    return 'localhost';
  }
  if (value.indexOf(':') !== -1 && value.charAt(0) !== '[') {
    return '[' + value + ']';
  }
  return value;
}

// Security (SEC-DEPLOY, PHP SEC-03 parity): may connection-settings embed the
// superuser JWT that the no-login bypass hands to the editor? Only when the
// bypass is active, never in production, and only for a loopback client —
// unless the operator explicitly exposed the bypass with a non-loopback
// HAXCMS_HOST (which already printed the exposure warning at startup).
// The peer address comes from the socket, NOT req.ip / X-Forwarded-For, so a
// remote client cannot spoof loopback through proxy headers.
function shouldEmbedBypassJwt(req, options) {
  const opts = options || {};
  if (!opts.jwtChecksDisabled || opts.isProduction) {
    return false;
  }
  const explicitHost = selectListenHost({ env: opts.env || process.env, jwtChecksDisabled: false });
  if (typeof explicitHost === 'string' && !isLoopbackHost(explicitHost)) {
    return true;
  }
  const socket = req && (req.socket || req.connection);
  const remoteAddress = socket && typeof socket.remoteAddress === 'string' ? socket.remoteAddress : '';
  return isLoopbackHost(remoteAddress) && remoteAddress.toLowerCase() !== 'localhost';
}

module.exports = {
  LOOPBACK_HOST,
  shouldEmbedBypassJwt,
  getBrowserHost,
  selectListenHost,
  isLoopbackHost,
  getBypassExposureWarning,
};
