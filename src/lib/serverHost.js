// Security (review 2026-10): choose the network interface the HTTP(S) server
// binds to. No-login mode (HAXCMS_DISABLE_JWT_CHECKS, set by src/local.js, the
// `haxcms-nodejs` npx bin) turns every auth check into "allowed" and the
// connection-settings route prints a superuser JWT, so it must never be
// reachable from the network by default. In that mode we bind to loopback
// unless the operator explicitly opts in with HAXCMS_HOST. Normal (auth) mode
// keeps the historical "all interfaces" default but honours HAXCMS_HOST.

const LOOPBACK_HOST = '127.0.0.1';

function normalizeHost(host) {
  if (typeof host !== 'string') {
    return '';
  }
  let value = host.trim();
  // accept bracketed IPv6 literals ("[::1]") as well as bare ones
  if (value.length > 1 && value[0] === '[' && value[value.length - 1] === ']') {
    value = value.substring(1, value.length - 1);
  }
  return value;
}

function isLoopbackHost(host) {
  const value = normalizeHost(host).toLowerCase();
  if (value === '') {
    return false;
  }
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // 127.0.0.0/8, bare or IPv4-mapped IPv6
  const v4 = value.indexOf('::ffff:') === 0 ? value.substring(7) : value;
  return /^127(\.\d{1,3}){3}$/.test(v4);
}

/**
 * Resolve the listen host.
 * @param {object} options
 * @param {boolean} options.authDisabled whether no-login mode is ACTIVE (the
 *   effective HAXCMS.HAXCMS_DISABLE_JWT_CHECKS, which production ignores)
 * @param {string} [options.envHost] value of process.env.HAXCMS_HOST
 * @returns {{host: (string|undefined), warning: (string|null)}} host is
 *   undefined when Node's default (all interfaces) should be used.
 */
function resolveListenHost(options) {
  const opts = options || {};
  const envHost = normalizeHost(opts.envHost);
  if (opts.authDisabled) {
    if (envHost === '') {
      return { host: LOOPBACK_HOST, warning: null };
    }
    if (isLoopbackHost(envHost)) {
      return { host: envHost, warning: null };
    }
    return {
      host: envHost,
      warning:
        'SECURITY WARNING: HAXcms is running with authentication DISABLED ' +
        '(HAXCMS_DISABLE_JWT_CHECKS / no-login mode) and HAXCMS_HOST=' + envHost +
        ' exposes it beyond this machine. Anyone who can reach this address ' +
        'has full superuser access (including a superuser JWT from ' +
        'connection-settings). Unset HAXCMS_HOST to bind to 127.0.0.1 only.',
    };
  }
  if (envHost === '') {
    return { host: undefined, warning: null };
  }
  return { host: envHost, warning: null };
}

module.exports = {
  LOOPBACK_HOST,
  isLoopbackHost,
  resolveListenHost,
};
