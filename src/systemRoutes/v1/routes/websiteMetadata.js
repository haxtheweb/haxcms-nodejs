const { parse } = require("node-html-parser");
const { safeFetch } = require("../../../lib/safeFetch.js");

// the most of a page read for its metadata: the head is near the top
const WEBSITE_METADATA_MAX_BYTES = 2 * 1024 * 1024;
const WEBSITE_METADATA_TIMEOUT_MS = 10000;
const WEBSITE_METADATA_MAX_URL = 2048;

/**
 * { name: value } of a page's title, meta tags (by name or property) and
 * JSON-LD blocks (as "ld+json"), plus the url asked for. Same shape the
 * open-apis metadata service returned, so callers read it unchanged.
 */
function readWebsiteMetadata(html, url) {
  const metadata = {};
  const doc = parse(`<div id="wrapper">${html || ""}</div>`);
  const tags = doc.querySelectorAll(
    'title,meta,script[type="application/ld+json"]',
  );
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    let key = null;
    let value = null;
    if (tag.tagName === "SCRIPT") {
      key = "ld+json";
      try {
        value = JSON.parse(tag.innerText);
      } catch {
        value = null;
      }
    } else if (tag.tagName === "TITLE") {
      key = "title";
      value = tag.innerText;
    } else {
      key = tag.getAttribute("name") || tag.getAttribute("property") || null;
      value = tag.getAttribute("content") || null;
    }
    // never let a page set keys that would change the object itself
    if (key && value && key !== "__proto__" && key !== "constructor") {
      metadata[key] = value;
    }
  }
  metadata.url = url;
  return metadata;
}

/**
 * POST /system/api/v1/actions/website-metadata
 * Skim the title and metadata off a web page, for link previews and
 * inserting a link by URL in the editor.
 *
 * Expects JSON body with { q: url }.
 * Returns { status: 200, data: { title, "og:title", ..., url } }.
 *
 * Security (SEC-SSRF): the page is only ever read through safeFetch, so a
 * private, loopback or metadata address is refused (redirects included),
 * and no more than WEBSITE_METADATA_MAX_BYTES is read.
 */
async function websiteMetadata(req, res) {
  let body = {};
  if (req && req.body && typeof req.body === "object") {
    body = req.body;
  }
  const q = typeof body.q === "string" ? body.q.trim() : "";
  if (!q) {
    return res.status(400).json({
      status: 400,
      data: { error: "missing `q` param" },
    });
  }
  if (q.length > WEBSITE_METADATA_MAX_URL || !/^https?:\/\//i.test(q)) {
    return res.status(400).json({
      status: 400,
      data: { error: "invalid q param" },
    });
  }
  let html = "";
  try {
    const response = await safeFetch(q, {
      method: "GET",
      maxBytes: WEBSITE_METADATA_MAX_BYTES,
      timeoutMs: WEBSITE_METADATA_TIMEOUT_MS,
    });
    html = response.ok ? await response.text() : "";
  } catch {
    // unreachable or refused: answer with what we know, the url
    html = "";
  }
  return res.json({
    status: 200,
    data: readWebsiteMetadata(html, q),
  });
}

module.exports = { websiteMetadata, readWebsiteMetadata };
