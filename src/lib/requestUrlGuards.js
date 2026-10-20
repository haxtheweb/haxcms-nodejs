"use strict";

// Linear-time helpers for hot request paths (ReDoS hardening, CodeQL
// js/polynomial-redos alert #23).

// Maximum accepted req.url length (path + query string). Node's own header
// limit is 16 KB. Legit HAXcms URLs are far below this: the longest ones are
// GET requests that carry a JWT in the query string (a few hundred bytes to
// ~1 KB) plus a site name / path. 8192 matches the default request-line limit
// of nginx / most reverse proxies, leaves ample headroom for those URLs and
// still rejects the 16 KB pathological requests before any routing happens.
const MAX_REQUEST_URL_LENGTH = 8192;

function requestUrlGuard(req, res, next) {
  if (
    req &&
    typeof req.url === "string" &&
    req.url.length > MAX_REQUEST_URL_LENGTH
  ) {
    res.status(414).send("URI Too Long");
    return;
  }
  next();
}

function isLineTerminator(code) {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

// Equivalent of: s.replace(/\/(.*?)<token>/g, replacement) where `token`
// starts with "/" and is matched literally, and `.` does not cross line
// terminators. Runs in O(n) using indexOf instead of nested lazy scans.
function collapseThroughToken(s, token, replacement) {
  let out = "";
  let pos = 0; // start of text not yet emitted
  let from = 0; // earliest index a match-start "/" may have
  while (true) {
    const i = s.indexOf("/", from);
    if (i === -1) {
      break;
    }
    const j = s.indexOf(token, i + 1);
    if (j === -1) {
      break;
    }
    // (.*?) cannot span a line terminator; if one sits between, the match
    // must start at a "/" after the last such terminator.
    let lastLT = -1;
    for (let k = j - 1; k > i; k--) {
      if (isLineTerminator(s.charCodeAt(k))) {
        lastLT = k;
        break;
      }
    }
    if (lastLT !== -1) {
      from = lastLT + 1;
      continue;
    }
    out += s.slice(pos, i) + replacement;
    pos = j + token.length;
    from = pos;
  }
  return out + s.slice(pos);
}

function getBuildAssetRequestPath(url = "") {
  const requestPath = String(url || "").split("?")[0];
  let result = collapseThroughToken(requestPath, "/build/", "build/");
  result = collapseThroughToken(
    result,
    "/wc-registry.json",
    "wc-registry.json",
  );
  result = collapseThroughToken(result, "/build.js", "build.js");
  result = collapseThroughToken(result, "/build-haxcms.js", "build-haxcms.js");
  return result;
}

module.exports = {
  MAX_REQUEST_URL_LENGTH,
  requestUrlGuard,
  collapseThroughToken,
  getBuildAssetRequestPath,
};
