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
 * fetch() wrapper that rejects SSRF targets before issuing the request.
 *
 * Signature matches global fetch: returns a standard Response. Throws on
 * SSRF rejection (see assertUrlNotSSRF) or on fetch/network failure. Callers
 * that already swallow fetch errors via try/catch need no other changes.
 *
 * DNS-rebinding note: this validates the hostname's resolved addresses and
 * then calls global fetch, which resolves the hostname again. The same
 * resolve-check-then-fetch window exists in the already-shipped build.files
 * path. Closing it fully requires an undici Agent with a pinned-IP lookup,
 * which is not available without adding undici as a runtime dependency; that
 * hardening should be a separate consistent pass across all fetch sites.
 */
async function safeFetch(urlString, options) {
  await assertUrlNotSSRF(urlString);
  return fetch(urlString, options);
}

module.exports = {
  safeFetch,
  assertUrlNotSSRF,
  isPrivateOrReservedIP,
  validateUrlNotSSRF: HAXCMSFile.validateUrlNotSSRF,
};
