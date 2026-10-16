'use strict';

const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const HAXCMSFile = require('./HAXCMSFile.js');

const isPrivateOrReservedIP = HAXCMSFile.isPrivateOrReservedIP;

/**
 * Resolve a URL's hostname, validate the scheme, and reject if ANY resolved
 * address is private, reserved, loopback, link-local, or cloud-metadata
 * (169.254.169.254). Returns the parsed URL plus the first validated address
 * (and its family) so the caller can pin the TCP connection to that exact IP.
 *
 * This mirrors the guard HAXCMSFile.save() applies to build.files remote
 * downloads (GHSA-q862-gcgq-5m6g) so that every remote-fetch site in the
 * system applies the same SSRF baseline. It checks ALL resolved addresses
 * (dns.lookup all:true) rather than just the first, so a hostname that
 * round-robins to an internal address is rejected.
 *
 * Security (L1 / HAX-SEC-007): returning the validated IP lets safeFetch pin
 * the connection via a custom lookup, closing the resolve-check-then-fetch
 * TOCTOU where a DNS server returns a public IP for the check and a private
 * IP for the actual connect (DNS rebinding).
 *
 * Returns { parsed, pinnedIp, family } on success. Throws an Error with a
 * stable .code on rejection so callers can distinguish SSRF rejections from
 * network errors.
 */
async function resolveAndValidateUrl(urlString) {
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
  return {
    parsed: parsed,
    pinnedIp: records[0].address,
    family: records[0].family,
  };
}

/**
 * Backward-compatible SSRF validation (returns the parsed URL, throws on
 * private/invalid). Kept as the public export so existing callers that only
 * need the check (without pinning) continue to work. Internally delegates to
 * resolveAndValidateUrl and discards the pinned IP.
 */
async function assertUrlNotSSRF(urlString) {
  var resolved = await resolveAndValidateUrl(urlString);
  return resolved.parsed;
}

/**
 * Build the request options for a pinned-IP connect. We connect directly to
 * the pre-validated IP (host = pinnedIp) and set the Host header + TLS
 * servername to the original hostname, so virtual hosting and TLS SNI/cert
 * validation behave correctly while the TCP target is pinned to the exact
 * SSRF-validated address. This avoids a custom dns `lookup` (which Node 22's
 * autoSelectFamily/Happy-Eyeballs path mishandles as ERR_INVALID_IP_ADDRESS)
 * and is more portable across Node versions.
 */
function buildPinnedRequestOptions(parsed, fetchOptions, pinnedIp) {
  var isHttps = parsed.protocol === 'https:';
  var defaultPort = isHttps ? 443 : 80;
  var port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
  var pathWithQuery = parsed.pathname + parsed.search;
  var originalHost = parsed.hostname + (parsed.port ? ':' + parsed.port : '');
  var requestHeaders = Object.assign({}, fetchOptions.headers || {});
  // Force the Host header to the original hostname (not the pinned IP) so the
  // upstream vhost and TLS SNI match what the URL requested.
  requestHeaders.host = originalHost;
  var requestOptions = {
    method: fetchOptions.method || 'GET',
    host: pinnedIp,
    port: port,
    path: pathWithQuery,
    headers: requestHeaders,
  };
  if (isHttps) {
    // servername drives SNI + certificate hostname verification, so TLS still
    // validates the cert for the original hostname even though we connect to
    // the pinned IP.
    requestOptions.servername = parsed.hostname;
  }
  return requestOptions;
}

/**
 * Minimal fetch-Response-compatible object covering the surface safeFetch
 * callers use: .ok, .status, .statusText, .headers.get(name), .text(),
 * .json(), .arrayBuffer(). Built from a Node http.IncomingMessage + buffered
 * body. arrayBuffer() returns the raw buffered bytes so binary content (image
 * / file downloads staged by the site-import converter) round-trips without
 * the UTF-8 corruption that .text() would introduce.
 */
function buildResponseLike(statusCode, statusMessage, rawHeaders, bodyBuffer) {
  var ok = statusCode >= 200 && statusCode < 300;
  // Node lowercases header keys in response.headers; values are string or
  // string[] (for repeated headers). headers.get returns a single string.
  var headerMap = rawHeaders || {};
  return {
    ok: ok,
    status: statusCode,
    statusText: statusMessage || '',
    headers: {
      get: function (name) {
        var lower = String(name || '').toLowerCase();
        var val = headerMap[lower];
        if (val === undefined || val === null) {
          return null;
        }
        if (Array.isArray(val)) {
          return val.join(', ');
        }
        return String(val);
      },
    },
    text: function () {
      return Promise.resolve(bodyBuffer.toString('utf8'));
    },
    json: function () {
      return Promise.resolve(JSON.parse(bodyBuffer.toString('utf8')));
    },
    arrayBuffer: function () {
      // Return the raw buffered bytes. Buffer.from(await res.arrayBuffer())
      // works whether this is a Buffer or a real ArrayBuffer.
      return Promise.resolve(bodyBuffer);
    },
  };
}

/**
 * Perform a single (non-redirect-following) HTTP(S) request to the parsed
 * URL's hostname, pinning the TCP connection to the pre-validated pinnedIp
 * via a custom lookup. TLS hostname verification (SNI/cert) is preserved
 * because the request host stays the original hostname and only the
 * connection target IP is overridden. Supports a caller-supplied AbortSignal
 * and an idle/total timeout. Returns a fetch-Response-like object.
 */
function buildTooLargeError(maxBytes) {
  var err = new Error('Remote response exceeds the maximum allowed size of ' + maxBytes + ' bytes');
  err.code = 'SSRF_TOO_LARGE';
  return err;
}

function pinnedFetchSingle(parsed, fetchOptions, pinnedIp, family, timeoutMs, limits) {
  var isHttps = parsed.protocol === 'https:';
  var lib = isHttps ? https : http;
  var requestOptions = buildPinnedRequestOptions(parsed, fetchOptions, pinnedIp);
  var bodyData = fetchOptions.body;
  var signal = fetchOptions.signal;
  var maxBytes = limits && limits.maxBytes > 0 ? limits.maxBytes : 0;
  var filePath = limits && limits.filePath ? limits.filePath : null;
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = null;
    var fileStream = null;
    // Security (review 2026-10): on any failure after a file sink was opened,
    // close and delete the partial file so nothing half-written is left.
    function discardFile() {
      if (fileStream) {
        var stream = fileStream;
        fileStream = null;
        try { stream.destroy(); } catch (e) {}
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    }
    function fail(e) {
      if (settled) { return; }
      settled = true;
      if (timer) { clearTimeout(timer); }
      try { req.destroy(); } catch (destroyErr) {}
      discardFile();
      reject(e);
    }
    var req = lib.request(requestOptions, function (response) {
      // Security (review 2026-10): enforce a response byte cap. A declared
      // Content-Length over the cap is rejected before any body is read; the
      // running byte count aborts the request as soon as the cap is crossed,
      // so a hostile or endless upstream cannot exhaust memory or disk.
      if (maxBytes > 0) {
        var declared = parseInt(response.headers && response.headers['content-length'], 10);
        if (!isNaN(declared) && declared > maxBytes) {
          fail(buildTooLargeError(maxBytes));
          return;
        }
      }
      var isFinalSuccess = response.statusCode >= 200 && response.statusCode < 300;
      if (filePath && isFinalSuccess) {
        try {
          fileStream = fs.createWriteStream(filePath);
        } catch (e) {
          fail(e);
          return;
        }
        fileStream.on('error', function (e) { fail(e); });
      }
      var chunks = [];
      var received = 0;
      response.on('data', function (chunk) {
        if (settled) { return; }
        received += chunk.length;
        if (maxBytes > 0 && received > maxBytes) {
          fail(buildTooLargeError(maxBytes));
          return;
        }
        if (fileStream) {
          fileStream.write(chunk);
        }
        else {
          chunks.push(chunk);
        }
      });
      response.on('end', function () {
        if (settled) { return; }
        var bodyBuffer = Buffer.concat(chunks);
        if (fileStream) {
          var stream = fileStream;
          stream.end(function () {
            if (settled) { return; }
            settled = true;
            if (timer) { clearTimeout(timer); }
            var fileResponse = buildResponseLike(response.statusCode, response.statusMessage, response.headers, bodyBuffer);
            fileResponse.filePath = filePath;
            fileResponse.bytesWritten = received;
            resolve(fileResponse);
          });
          return;
        }
        settled = true;
        if (timer) { clearTimeout(timer); }
        resolve(buildResponseLike(response.statusCode, response.statusMessage, response.headers, bodyBuffer));
      });
      response.on('error', function (e) {
        fail(e);
      });
    });
    req.on('error', function (e) {
      fail(e);
    });
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(function () {
        var err = new Error('safeFetch timed out');
        err.code = 'SSRF_TIMEOUT';
        fail(err);
      }, timeoutMs);
    }
    if (signal) {
      var abortErr = new Error('safeFetch aborted');
      abortErr.code = 'SSRF_ABORT';
      if (signal.aborted) {
        fail(abortErr);
      }
      else {
        signal.addEventListener('abort', function onAbort() {
          fail(abortErr);
        });
      }
    }
    if (bodyData !== undefined && bodyData !== null) {
      if (typeof bodyData === 'string' || Buffer.isBuffer(bodyData)) {
        req.write(bodyData);
      }
      // other body types (stream) are not used by current callers; leave them
    }
    req.end();
  });
}

/**
 * fetch() wrapper that rejects SSRF targets before issuing the request,
 * pins each hop's TCP connection to the SSRF-validated IP, and follows
 * redirects manually so every hop is re-resolved and re-validated.
 *
 * Security (SEC-02 / L1): the previous implementation called global fetch()
 * after validating DNS, but fetch() re-resolved the hostname — leaving a
 * same-hop DNS-rebinding window where a public-IP check could be followed by
 * a private-IP connect. pinnedFetchSingle pins the connection to the exact
 * validated address via a custom lookup, closing that TOCTOU while preserving
 * the manual redirect walk (each Location hop is re-resolved + re-validated),
 * the hop cap, and the total timeout. A hop cap (SAFE_FETCH_MAX_REDIRECTS)
 * bounds the chain and a total timeout (SAFE_FETCH_TIMEOUT_MS) prevents a
 * slow/hanging host from holding a request open. Callers may override `signal`
 * via options.
 *
 * Signature matches global fetch: returns the final, non-3xx Response-like
 * object (with .ok/.status/.headers.get/.text/.json). Throws on SSRF rejection
 * (resolveAndValidateUrl), too many redirects (SSRF_REDIRECTS), a bad Location
 * (SSRF_REDIRECT), or fetch/timeout/abort.
 */
const SAFE_FETCH_MAX_REDIRECTS = 5;
const SAFE_FETCH_TIMEOUT_MS = 15000;
// Security (review 2026-10): default response byte cap. Text/JSON fetches
// (import APIs, page bodies, md/yaml links) never come near this; callers that
// download real files (site imports, build.files, URL uploads) pass
// maxBytes from getUploadMaxBytes() so the site's maxUploadSizeMb applies.
const SAFE_FETCH_DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Security (review 2026-10): byte limit for remote downloads that become site
 * files, tied to the configured media maxUploadSizeMb (same setting
 * HAXCMSFile.save enforces on uploads). Falls back to the media-settings
 * default when the settings cannot be read.
 */
async function getUploadMaxBytes() {
  var mediaSettings = require('./mediaSettings.js');
  try {
    var HAXCMS = require('./HAXCMS.js').HAXCMS;
    var settings = await mediaSettings.readMediaSettings(HAXCMS);
    if (settings && typeof settings.maxUploadSizeMb === 'number' && settings.maxUploadSizeMb > 0) {
      return settings.maxUploadSizeMb * 1024 * 1024;
    }
  }
  catch (e) {}
  var fallbackMb = mediaSettings.DEFAULT_MEDIA_SETTINGS && mediaSettings.DEFAULT_MEDIA_SETTINGS.maxUploadSizeMb
    ? mediaSettings.DEFAULT_MEDIA_SETTINGS.maxUploadSizeMb
    : 1024;
  return fallbackMb * 1024 * 1024;
}

/**
 * Options (beyond the fetch-like headers/method/body/signal):
 *  - maxBytes: response byte cap (default SAFE_FETCH_DEFAULT_MAX_BYTES).
 *    Exceeding it rejects with code SSRF_TOO_LARGE.
 *  - maxRedirects: redirect hop cap (default SAFE_FETCH_MAX_REDIRECTS).
 *  - timeoutMs: per-hop total timeout (default SAFE_FETCH_TIMEOUT_MS; ignored
 *    when the caller passes its own signal).
 *  - filePath: stream a final 2xx body to this path instead of buffering it;
 *    the partial file is deleted on any error. The response carries
 *    .filePath and .bytesWritten.
 */
async function safeFetch(urlString, options) {
  var fetchOptions = options || {};
  // Only add a timeout when the caller did not supply their own signal;
  // combining two signals would require AbortSignal.any (Node 20.3+), which
  // is not guaranteed available on the supported Node 18.20.3 LTS line.
  var timeoutMs = fetchOptions.signal
    ? 0
    : (fetchOptions.timeoutMs > 0 ? fetchOptions.timeoutMs : SAFE_FETCH_TIMEOUT_MS);
  var maxRedirects = typeof fetchOptions.maxRedirects === 'number' && fetchOptions.maxRedirects >= 0
    ? Math.min(fetchOptions.maxRedirects, SAFE_FETCH_MAX_REDIRECTS)
    : SAFE_FETCH_MAX_REDIRECTS;
  var limits = {
    maxBytes: fetchOptions.maxBytes > 0 ? fetchOptions.maxBytes : SAFE_FETCH_DEFAULT_MAX_BYTES,
    filePath: fetchOptions.filePath || null,
  };
  var currentUrl = urlString;
  for (var hop = 0; hop <= maxRedirects; hop++) {
    // Security (L1): resolve + validate, then pin the IP for the connect so
    // DNS rebinding cannot redirect the request to a private/metadata address
    // between the SSRF check and the actual TCP connection.
    var resolved = await resolveAndValidateUrl(currentUrl);
    var response = await pinnedFetchSingle(resolved.parsed, fetchOptions, resolved.pinnedIp, resolved.family, timeoutMs, limits);
    // not a redirect (or 304 Not Modified) -> final response
    if (response.status < 300 || response.status >= 400 || response.status === 304) {
      return response;
    }
    if (hop === maxRedirects) {
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
  throw new Error('safeFetch unexpected loop exit');
}

module.exports = {
  safeFetch,
  getUploadMaxBytes,
  SAFE_FETCH_DEFAULT_MAX_BYTES,
  assertUrlNotSSRF,
  isPrivateOrReservedIP,
  validateUrlNotSSRF: HAXCMSFile.validateUrlNotSSRF,
};
