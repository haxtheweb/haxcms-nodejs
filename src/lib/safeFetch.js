'use strict';

const dns = require('dns');
const HAXCMSFile = require('./HAXCMSFile.js');

const isPrivateOrReservedIP = HAXCMSFile.isPrivateOrReservedIP;

/**
 * Resolve a URL's hostname and reject if any resolved address is private,
 * reserved, loopback, link-local, or cloud-metadata (169.254.169.254).
 *
 * This mirrors the guard HAXCMSFile.save() applies to build.files remote
 * downloads (GHSA-q862-gcgq-5m6g) so that every remote-fetch site in the
 * system applies the same SSRF baseline. It checks ALL resolved addresses
 * (dns.lookup all:true) rather than just the first, so a hostname that
 * round-robins to an internal address is rejected.
 *
 * Returns the parsed URL on success. Throws an Error with a stable .code
 * on rejection so callers can distinguish SSRF rejections from network errors.
 */
async function assertUrlNotSSRF(urlString) {
  var parsed;
  try {
    parsed = new URL(urlString);
  } catch (e) {
    var err = new Error('Invalid URL');
    err.code = 'SSRF_INVALID_URL';
    throw err;
  }
  var protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    var protocolErr = new Error('Unsupported URL protocol');
    protocolErr.code = 'SSRF_PROTOCOL';
    throw protocolErr;
  }
  var hostname = parsed.hostname;
  if (!hostname) {
    var hostErr = new Error('URL is missing a hostname');
    hostErr.code = 'SSRF_HOSTNAME';
    throw hostErr;
  }
  var records;
  try {
    records = await dns.promises.lookup(hostname, { all: true });
  } catch (e) {
    var dnsErr = new Error('Unable to resolve URL hostname');
    dnsErr.code = 'SSRF_DNS';
    throw dnsErr;
  }
  if (!records || records.length === 0) {
    var noRecordsErr = new Error('URL hostname did not resolve to any address');
    noRecordsErr.code = 'SSRF_DNS';
    throw noRecordsErr;
  }
  for (var i = 0; i < records.length; i++) {
    if (isPrivateOrReservedIP(records[i].address)) {
      var privateErr = new Error('URL target resolves to a private, reserved, loopback, link-local, or metadata address');
      privateErr.code = 'SSRF_PRIVATE';
      throw privateErr;
    }
  }
  return parsed;
}

/**
 * fetch() wrapper that rejects SSRF targets before issuing the request and
 * follows redirects manually so every hop is re-validated against the SSRF
 * IP guard.
 *
 * Security (SEC-02): fetch()'s default redirect mode follows up to 20
 * redirects WITHOUT re-resolving or re-checking the destination, so a 302
 * from a validated public host to http://169.254.169.254/ would reach the
 * metadata endpoint unchallenged (redirect-rebinding SSRF). We set
 * redirect:'manual' and walk each Location hop ourselves, running
 * assertUrlNotSSRF on the resolved target before fetching it. A hop cap
 * (SAFE_FETCH_MAX_REDIRECTS) bounds the chain and a total timeout
 * (SAFE_FETCH_TIMEOUT_MS) prevents a slow/hanging host from holding a
 * request open. Callers may override `redirect`/`signal` via options.
 *
 * Signature matches global fetch: returns the final, non-3xx Response.
 * Throws on SSRF rejection (assertUrlNotSSRF), too many redirects
 * (SSRF_REDIRECTS), a bad Location (SSRF_REDIRECT), or fetch/timeout/abort.
 *
 * DNS-rebinding note: this validates each hop's resolved addresses and then
 * calls fetch, which re-resolves the hostname. The same-hop resolve-check-
 * then-fetch TOCTOU remains (closing it fully requires an undici Agent with
 * a pinned-IP lookup; deferred, see HAX-SEC-007). This change closes the
 * redirect-rebinding variant across all fetch sites and matches the PHP
 * SsrfGuard wrappers' redirect-disabled posture (PHP blocks redirects
 * outright; Node follows them safely to preserve legit http->https and
 * trailing-slash redirects that import flows rely on).
 */
const SAFE_FETCH_MAX_REDIRECTS = 5;
const SAFE_FETCH_TIMEOUT_MS = 15000;

async function safeFetch(urlString, options) {
  var fetchOptions = options || {};
  var redirectMode = fetchOptions.redirect || 'manual';
  var timeoutSignal = null;
  // Only add a timeout when the caller did not supply their own signal;
  // combining two signals would require AbortSignal.any (Node 20.3+), which
  // is not guaranteed available on the supported Node 18.20.3 LTS line.
  if (!fetchOptions.signal) {
    timeoutSignal = AbortSignal.timeout(SAFE_FETCH_TIMEOUT_MS);
  }
  var mergedOptions = Object.assign({}, fetchOptions, { redirect: redirectMode });
  if (timeoutSignal) {
    mergedOptions.signal = timeoutSignal;
  }
  var currentUrl = urlString;
  for (var hop = 0; hop <= SAFE_FETCH_MAX_REDIRECTS; hop++) {
    // re-validate the current URL each hop (initial URL + every redirect target)
    await assertUrlNotSSRF(currentUrl);
    var response = await fetch(currentUrl, mergedOptions);
    // not a redirect (or 304 Not Modified) -> final response
    if (response.status < 300 || response.status >= 400 || response.status === 304) {
      return response;
    }
    if (hop === SAFE_FETCH_MAX_REDIRECTS) {
      var tooManyErr = new Error('safeFetch exceeded the redirect hop cap');
      tooManyErr.code = 'SSRF_REDIRECTS';
      throw tooManyErr;
    }
    var locationHeader = response.headers.get('location');
    if (!locationHeader) {
      // 3xx with no Location header -> nothing to follow, return as-is
      return response;
    }
    var nextUrl;
    try {
      nextUrl = new URL(locationHeader, currentUrl).toString();
    } catch (e) {
      var badLocErr = new Error('safeFetch received an invalid redirect Location');
      badLocErr.code = 'SSRF_REDIRECT';
      throw badLocErr;
    }
    currentUrl = nextUrl;
  }
  // unreachable: the loop always returns or throws on the last allowed hop
  return fetch(currentUrl, mergedOptions);
}

module.exports = {
  safeFetch,
  assertUrlNotSSRF,
  isPrivateOrReservedIP,
  validateUrlNotSSRF: HAXCMSFile.validateUrlNotSSRF,
};
