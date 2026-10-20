/**
 * Host matching for URLs, so "is this a YouTube link" is decided by the parsed
 * hostname rather than by a substring that can also appear in a path, query
 * string or look-alike domain (https://evil.example/?u=youtube.com).
 */

/**
 * True when `value` is an http(s) URL (absolute or protocol-relative) whose
 * hostname is one of `domains` or a subdomain of one.
 * @param {string} value
 * @param {string[]} domains bare domains such as "youtube.com"
 * @returns {boolean}
 */
function urlHostMatches(value, domains) {
  if (typeof value !== "string" || value === "") {
    return false;
  }
  let url;
  try {
    // the base only resolves protocol-relative values ("//host/path");
    // relative paths resolve to the placeholder host, which never matches
    url = new URL(value, "https://placeholder.invalid/");
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return domains.some(
    (domain) => host === domain || host.endsWith("." + domain),
  );
}

module.exports = { urlHostMatches };
