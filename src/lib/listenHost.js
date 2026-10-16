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

// Host to use in the printed / auto-opened URL. Wildcard and loopback binds
// keep the familiar `localhost`; a specific interface address is shown as-is
// (IPv6 bracketed) since `localhost` would not reach it.
function getBrowserHost(host) {
  if (typeof host !== 'string' || host.trim() === '') {
    return 'localhost';
  }
  const value = host.trim();
  if (value === '0.0.0.0' || value === '::' || value === '[::]' || isLoopbackHost(value)) {
    return 'localhost';
  }
  if (value.indexOf(':') !== -1 && value.charAt(0) !== '[') {
    return '[' + value + ']';
  }
  return value;
}

module.exports = {
  LOOPBACK_HOST,
  getBrowserHost,
  selectListenHost,
  isLoopbackHost,
  getBypassExposureWarning,
};
