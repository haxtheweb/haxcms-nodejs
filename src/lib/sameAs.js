// The site's profiles elsewhere (GitHub, LinkedIn, Mastodon, YouTube...),
// published as schema.org sameAs on the site's Organization node so search
// engines and agents can tie them to the site (haxtheweb/issues#3367).
//
// Invariant: only absolute http(s) URLs with a host and no credentials are
// kept, each at most SAME_AS_MAX_LENGTH characters, deduplicated, at most SAME_AS_MAX_COUNT of
// them, in the order given. Anything else is dropped, never an error, so a
// stray line can't block saving the rest of the SEO settings. The same
// normalizer runs on save and again when the head is rendered, so a hand-
// edited site.json can't put another scheme into structured data.
// Mirrored by HAXCMSSameAs in haxcms-php.

const SAME_AS_MAX_COUNT = 12;
const SAME_AS_MAX_LENGTH = 2048;

function normalizeSameAsList(input) {
  let candidates = [];
  if (Array.isArray(input)) {
    candidates = input;
  } else if (typeof input === "string") {
    // one per line (the SEO form's textarea)
    candidates = input.split(/[\r\n]+/);
  } else {
    return [];
  }
  const seen = new Set();
  const list = [];
  for (let i = 0; i < candidates.length; i++) {
    if (list.length >= SAME_AS_MAX_COUNT) {
      break;
    }
    if (typeof candidates[i] !== "string") {
      continue;
    }
    const value = candidates[i].trim();
    if (value === "" || value.length > SAME_AS_MAX_LENGTH) {
      continue;
    }
    // the characters a WHATWG URL parser would rewrite (non-ASCII, spaces,
    // controls, <>"\^`{|}) and dot segments are refused, so both backends
    // keep exactly the same URLs, spelled the same way
    if (/[^\x21-\x7e]|[<>"\\^`{|}]/.test(value)) {
      continue;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      continue;
    }
    // written out as scheme://host, with the host as the parser keeps it
    // (no IPv4 shorthand or other rewriting) and no dot segments
    const raw = /^https?:\/\/([^/?#]*)([^?#]*)/i.exec(value);
    if (!raw) {
      continue;
    }
    const rawHost = raw[1]
      .toLowerCase()
      .replace(url.protocol === "https:" ? /:443$/ : /:80$/, "");
    if (rawHost !== url.host || /(^|\/)\.{1,2}(\/|$)/.test(raw[2])) {
      continue;
    }
    const href = url.href;
    if (seen.has(href)) {
      continue;
    }
    seen.add(href);
    list.push(href);
  }
  return list;
}

module.exports = {
  SAME_AS_MAX_COUNT,
  SAME_AS_MAX_LENGTH,
  normalizeSameAsList,
};
