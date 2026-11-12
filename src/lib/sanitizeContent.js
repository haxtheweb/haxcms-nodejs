const createDOMPurify = require("dompurify");
const { JSDOM } = require("jsdom");
// Storage policy shared with haxcms-php (haxtheweb/issues#3273): which tags
// stay, which go with their content, attribute rules. Both backends run the
// same walk over it and must store the same HTML.
const POLICY = require("./haxcmsSanitizePolicy.json");

const EVENT_ATTRIBUTE_RE = /^on[a-z0-9_-]+$/i;
const PROTOCOL_PREFIX_RE = /^([a-z0-9+.-]+):/i;
const NORMALIZE_URL_RE = /[\u0000-\u001f\u007f\s]+/g;

const FORBIDDEN_TAGS = [
  "script",
  "svg",
  "frame",
  "frameset",
  "applet",
  "meta",
  "link",
  "base",
  "style",
];
const FORBIDDEN_TAG_SET = new Set(FORBIDDEN_TAGS);
const ALLOWED_TAG_SET = new Set(POLICY.allowedTags);
const REMOVE_WITH_CONTENT_SET = new Set(POLICY.removeWithContent);
const CUSTOM_ELEMENT_NAME_RE = new RegExp(POLICY.customElementName);
const RESERVED_CUSTOM_ELEMENT_SET = new Set(POLICY.reservedCustomElementNames);
const ATTRIBUTE_NAME_RE = new RegExp(POLICY.attributeName);
// DOMPurify drops an attribute holding one of these (mutation XSS guard)
const UNSAFE_ATTRIBUTE_VALUE_RE = new RegExp(POLICY.unsafeAttributeValue, "i");
const CLOBBER_TAG_SET = new Set(POLICY.clobberTags);
const CLOBBER_NAME_SET = new Set(POLICY.clobberNames);
const FORBIDDEN_ATTRIBUTES = new Set(POLICY.forbiddenAttributes);
const URL_ATTRIBUTE_NAMES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "srcset",
  "xlink:href",
  // Security (SEC-SANITIZE): HAX custom elements carry URLs in these
  // non-standard attribute names (simple-cta link, media-image source,
  // pdf-browser-viewer file, video-player sources/tracks). Keep in parity
  // with PHP SanitizeContent::URL_ATTRIBUTE_NAMES.
  "link",
  "source",
  "file",
  "sources",
  "tracks",
]);
// Security (SEC-SANITIZE): schemes that can execute script. Checked on
// attributes regardless of name (DOMPurify's CUSTOM_ELEMENT_HANDLING lets any
// attribute on a custom element through without a URI check). This is a
// denylist on purpose: HAX attribute values are routinely scheme-shaped
// (icon="icons:check", title="Note: hi") so the http/https/mailto/tel
// allowlist can only apply to URL-named attributes. data: is handled
// separately (only non-raster media types are removed).
const SCRIPT_CAPABLE_SCHEMES = new Set([
  "javascript",
  "vbscript",
  "livescript",
  "mocha",
]);
// raster image media types allowed in data: URIs
const SAFE_DATA_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);
const DATA_MEDIA_TYPE_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)/;
// human-readable text attributes: never treated as URLs
const TEXT_ATTRIBUTE_NAMES = new Set([
  "alt",
  "title",
  "label",
  "caption",
  "placeholder",
  "summary",
]);
// URL names added for SEC-SANITIZE; unchecked on main, where HAX content
// relies on raster data: URIs (media-image source="data:image/png;...")
const DATA_IMAGE_URL_ATTRIBUTE_NAMES = new Set([
  "link",
  "source",
  "file",
  "sources",
  "tracks",
]);
const SCHEME_PREFIX_RE = /^([a-z][a-z0-9+.-]*):/;
// browsers' URL parser removes TAB/LF/CR anywhere and C0/space at the start
const SCHEME_TAB_NEWLINE_RE = /[\t\n\r]+/g;
const SCHEME_LEADING_RE = /^[\u0000-\u0020]+/;
const SCHEME_ENTITY_RE =
  /&#[xX]([0-9a-fA-F]+);?|&#([0-9]+);?|&(colon|Tab|NewLine|plus|period);/g;
const SCHEME_NAMED_ENTITIES = {
  colon: ":",
  Tab: "\t",
  NewLine: "\n",
  plus: "+",
  period: ".",
};
const EXISTING_ENTITY_SAFE_AMP_RE =
  /&(?![a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g;
const XML_ILLEGAL_CHARS_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const ALLOWED_PROTOCOLS = new Set(["http", "https", "mailto", "tel"]);
const TEXT_TEMPLATE_HOSTS = new Set([
  "code-sample",
  "runkit-embed",
  "web-container",
]);
const IFRAME_ALLOWED_ATTRIBUTES = new Set([
  "src",
  "title",
  "width",
  "height",
  "loading",
  "allow",
  "allowfullscreen",
  "credentialless",
  "referrerpolicy",
  "sandbox",
]);
const IFRAME_SANDBOX_ALLOWED_TOKENS = new Set([
  "allow-downloads",
  "allow-forms",
  "allow-modals",
  "allow-pointer-lock",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-presentation",
  "allow-same-origin",
  "allow-scripts",
]);
// Security (SEC-SANITIZE): the default sandbox for iframes that carry no
// sandbox of their own. allow-scripts + allow-same-origin together let a
// SAME-origin frame remove its own sandbox, so allow-same-origin is only added
// for real cross-origin embeds: an absolute http(s) (or protocol-relative) src.
// Those frames keep their own origin (YouTube, Vimeo and most players need it
// for storage and cookies) and still cannot reach the page. Relative, about:,
// data:, blob:, javascript: or missing sources get the strict default, whose
// origin is opaque or would be the page's. Same rule as the editor's
// iframeSandboxForSource (haxtheweb/webcomponents#1177). Authors who set an
// explicit sandbox keep it unchanged. PHP parity: SanitizeContent.
const IFRAME_DEFAULT_SANDBOX = "allow-scripts allow-popups allow-forms";
const IFRAME_CROSS_ORIGIN_SANDBOX =
  IFRAME_DEFAULT_SANDBOX + " allow-same-origin";

function isCrossOriginEmbedSource(src) {
  if (typeof src !== "string") {
    return false;
  }
  const value = src.trim();
  return /^(?:https?:)?\/\/[^/\\\s]/i.test(value);
}
const REFERRER_POLICY_ALLOWED = new Set([
  "no-referrer",
  "origin",
  "strict-origin",
  "same-origin",
  "strict-origin-when-cross-origin",
  "origin-when-cross-origin",
  "unsafe-url",
]);

let domPurifyInstance = null;

function getDOMPurify() {
  if (domPurifyInstance !== null) {
    return domPurifyInstance;
  }

  const jsdom = new JSDOM("<!doctype html><html><body></body></html>");
  domPurifyInstance = createDOMPurify(jsdom.window);

  // DOMPurify runs after the shared policy as a backstop. The policy has
  // already decided every attribute, so DOMPurify keeps them as they are
  // (forceKeepAttr also skips its value trimming); it still removes any
  // attribute holding an mXSS sequence, which the policy removed first.
  domPurifyInstance.addHook("uponSanitizeAttribute", function (node, data) {
    if (data) {
      data.forceKeepAttr = true;
    }
  });

  return domPurifyInstance;
}

function sanitizeURLValue(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const stringValue = String(value).trim();
  if (stringValue === "") {
    return fallback;
  }
  if (stringValue[0] === "#") {
    return stringValue;
  }
  const normalizedValue = stringValue
    .replace(NORMALIZE_URL_RE, "")
    .toLowerCase();
  if (normalizedValue === "") {
    return fallback;
  }
  const protocolMatch = normalizedValue.match(PROTOCOL_PREFIX_RE);
  if (!protocolMatch) {
    return stringValue;
  }
  const protocol = protocolMatch[1];
  if (ALLOWED_PROTOCOLS.has(protocol)) {
    return stringValue;
  }
  return fallback;
}

// Security (SEC-SANITIZE): single-pass decode of the entity forms that can
// spell a scheme (numeric with or without ';', plus &colon; &Tab; &NewLine;
// &plus; &period;). Invalid code points decode to ''. Parity contract with PHP
// SanitizeContent::decodeSchemeEntities.
function decodeSchemeEntities(value) {
  return String(value).replace(
    SCHEME_ENTITY_RE,
    function (match, hex, dec, named) {
      if (named) {
        return SCHEME_NAMED_ENTITIES[named];
      }
      const codePoint = hex ? parseInt(hex, 16) : parseInt(dec, 10);
      if (
        !Number.isFinite(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return "";
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

// Security (SEC-SANITIZE): normalised attribute value for scheme
// detection: decodeSchemeEntities -> remove TAB/LF/CR anywhere -> strip
// leading [\x00-\x20] -> lowercase. Interior spaces are kept, as in browsers.
function normalizeSchemeValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return decodeSchemeEntities(value)
    .replace(SCHEME_TAB_NEWLINE_RE, "")
    .replace(SCHEME_LEADING_RE, "")
    .toLowerCase();
}

// leading scheme of the normalised value, '' when there is none
function getNormalizedScheme(value) {
  const match = normalizeSchemeValue(value).match(SCHEME_PREFIX_RE);
  return match ? match[1] : "";
}

function hasScriptCapableScheme(value) {
  return SCRIPT_CAPABLE_SCHEMES.has(getNormalizedScheme(value));
}

// data: URI with an explicit media type that is not a safe raster image
// (data:text/html, data:image/svg+xml, ...). "Data: 2024 results" and
// data:image/png survive.
function hasUnsafeDataMediaType(value) {
  const match = normalizeSchemeValue(value).match(DATA_MEDIA_TYPE_RE);
  return match !== null && !SAFE_DATA_IMAGE_TYPES.has(match[1]);
}

function isSafeRasterDataURI(value) {
  const match = normalizeSchemeValue(value).match(DATA_MEDIA_TYPE_RE);
  return match !== null && SAFE_DATA_IMAGE_TYPES.has(match[1]);
}

function isTextAttribute(attributeName) {
  return (
    TEXT_ATTRIBUTE_NAMES.has(attributeName) ||
    attributeName.indexOf("aria-") === 0
  );
}

// Security (SEC-SANITIZE): returns the value to keep, or null when the
// attribute must be removed (empty boolean attributes stay '').
//  - URL-named attributes: sanitizeURLValue allowlist (link/source/file/
//    sources/tracks additionally accept raster data:image URIs, as on main),
//    then the script-scheme / unsafe-data check.
//  - text attributes (alt, title, label, caption, placeholder, summary,
//    aria-*): kept as-is.
//  - everything else: removed when the scheme is javascript/vbscript/
//    livescript/mocha or a data: URI with a non-raster media type.
function sanitizeAttributeValue(attributeName, value) {
  let safeValue = value === null || value === undefined ? "" : String(value);
  if (isURLLikeAttribute(attributeName)) {
    if (
      !(
        DATA_IMAGE_URL_ATTRIBUTE_NAMES.has(attributeName) &&
        isSafeRasterDataURI(safeValue)
      )
    ) {
      safeValue = sanitizeURLValue(safeValue, "");
      if (safeValue === "") {
        return null;
      }
    }
  } else if (isTextAttribute(attributeName)) {
    return safeValue;
  }
  if (hasScriptCapableScheme(safeValue) || hasUnsafeDataMediaType(safeValue)) {
    return null;
  }
  return safeValue;
}

// doubleEncode=false mirrors PHP htmlspecialchars(..., double_encode: false):
// an '&' that already starts an entity is left alone, so values that
// round-trip through the editor (saveOutline sends every item's metadata
// back) do not accumulate &amp;amp;... on every save.
function sanitizeMetadataValue(value, doubleEncode = true) {
  if (value === null || value === undefined) {
    return "";
  }
  return escapeHTMLAttribute(value, doubleEncode);
}

function escapeHTMLAttribute(value, doubleEncode = true) {
  return String(value === null || value === undefined ? "" : value)
    .replace(
      doubleEncode === false ? EXISTING_ENTITY_SAFE_AMP_RE : /&/g,
      "&amp;",
    )
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeXMLValue(value) {
  return (
    String(value === null || value === undefined ? "" : value)
      // Security (SEC-SANITIZE): drop code points not allowed in XML 1.0
      // (allowed: #x9 #xA #xD [#x20-#xD7FF] [#xE000-#xFFFD] [#x10000-#x10FFFF]);
      // lone surrogates are dropped, valid surrogate pairs are kept.
      .replace(XML_ILLEGAL_CHARS_RE, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

function isURLLikeAttribute(attributeName) {
  if (URL_ATTRIBUTE_NAMES.has(attributeName)) {
    return true;
  }
  if (attributeName.indexOf("url") !== -1) {
    return true;
  }
  if (attributeName.endsWith("-src")) {
    return true;
  }
  if (attributeName.endsWith("-href")) {
    return true;
  }
  return false;
}

// Scratch documents for the two parse passes. Every `new JSDOM()` keeps
// about half a megabyte alive after window.close(), so a window per call grew
// the heap by about 1 MB per sanitize, without bound, on a long-running server.
// One shared window hands out a new document per call instead; a document
// made with createHTMLDocument has no browsing context, so its <iframe>s get
// no frame windows and there is nothing to close. Parsing is the same:
// body.innerHTML in a fresh HTML document.
//
// Invariant: heap stays flat across calls once the event loop turns. Inside a
// single synchronous run, each call's documents stay reachable until the run
// ends, because jsdom tracks NodeIterators (DOMPurify makes one per sanitize)
// through WeakRefs, and JavaScript keeps a WeakRef's target alive for the rest
// of the current job. Callers that sanitize many pages should await between
// pages (every current caller awaits a file write per page), so that memory
// is released as they go. test/unit/sanitize-heap.test.cjs guards both.
let scratchWindow = null;
function newScratchDocument() {
  if (scratchWindow === null) {
    scratchWindow = new JSDOM("<!doctype html><html><body></body></html>")
      .window;
  }
  return scratchWindow.document.implementation.createHTMLDocument("");
}

function escapeTemplateText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// In place, on the parsed document (parsing twice would drop a second
// leading newline in <pre> and change other markup that does not survive a
// round trip); mirrors haxcms-php SanitizeContent::preprocessTextTemplates.
function preprocessTextTemplateHosts(document) {
  const selector = Array.from(TEXT_TEMPLATE_HOSTS).join(",");
  if (selector !== "") {
    const hosts = document.querySelectorAll(selector);
    hosts.forEach(function (host) {
      const templates = host.querySelectorAll("template");
      templates.forEach(function (templateElement) {
        if (
          templateElement.content &&
          templateElement.content.querySelector("*")
        ) {
          templateElement.innerHTML = escapeTemplateText(
            templateElement.innerHTML,
          );
        }
      });
    });
  }
}

function normalizeSandboxValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const rawTokens = String(value).toLowerCase().split(/\s+/);
  const normalizedTokens = [];
  rawTokens.forEach(function (token) {
    if (
      token !== "" &&
      IFRAME_SANDBOX_ALLOWED_TOKENS.has(token) &&
      normalizedTokens.indexOf(token) === -1
    ) {
      normalizedTokens.push(token);
    }
  });
  return normalizedTokens.join(" ");
}

function normalizeIframeAttributes(iframe) {
  const src = iframe.getAttribute("src");
  if (src !== null) {
    const safeSrc = sanitizeURLValue(src, "");
    if (safeSrc === "") {
      iframe.removeAttribute("src");
    } else if (safeSrc !== src) {
      iframe.setAttribute("src", safeSrc);
    }
  }

  const loading = iframe.getAttribute("loading");
  if (loading === null || loading.trim() === "") {
    iframe.setAttribute("loading", "lazy");
  } else {
    const normalizedLoading = loading.toLowerCase();
    if (normalizedLoading !== "lazy" && normalizedLoading !== "eager") {
      iframe.setAttribute("loading", "lazy");
    } else {
      iframe.setAttribute("loading", normalizedLoading);
    }
  }

  const referrerPolicy = iframe.getAttribute("referrerpolicy");
  if (referrerPolicy === null || referrerPolicy.trim() === "") {
    iframe.setAttribute("referrerpolicy", "no-referrer");
  } else {
    const normalizedReferrerPolicy = referrerPolicy.toLowerCase();
    if (!REFERRER_POLICY_ALLOWED.has(normalizedReferrerPolicy)) {
      iframe.setAttribute("referrerpolicy", "no-referrer");
    } else {
      iframe.setAttribute("referrerpolicy", normalizedReferrerPolicy);
    }
  }

  const sandboxValue = normalizeSandboxValue(iframe.getAttribute("sandbox"));
  if (sandboxValue === "") {
    iframe.setAttribute(
      "sandbox",
      isCrossOriginEmbedSource(iframe.getAttribute("src"))
        ? IFRAME_CROSS_ORIGIN_SANDBOX
        : IFRAME_DEFAULT_SANDBOX,
    );
  } else {
    iframe.setAttribute("sandbox", sandboxValue);
  }

  if (iframe.hasAttribute("allowfullscreen")) {
    iframe.setAttribute("allowfullscreen", "allowfullscreen");
  }
}

function isCustomElementName(tagName) {
  return (
    CUSTOM_ELEMENT_NAME_RE.test(tagName) &&
    !RESERVED_CUSTOM_ELEMENT_SET.has(tagName)
  );
}

// A comment stays only when it cannot hide markup: no < or >, and not a
// processing instruction the HTML parser turned into a comment (<?php ?>).
function isSafeComment(data) {
  const value = String(data);
  return (
    value.indexOf("<") === -1 && value.indexOf(">") === -1 && value[0] !== "?"
  );
}

// Shared attribute policy, in order: invalid name, forbidden name or event
// handler, iframe allowlist, mXSS value, DOM clobbering name, then the value
// rules (URL allowlist, script-capable schemes). Returns null to remove.
function policyAttributeValue(tagName, attributeName, value) {
  if (!ATTRIBUTE_NAME_RE.test(attributeName)) {
    return null;
  }
  if (
    EVENT_ATTRIBUTE_RE.test(attributeName) ||
    FORBIDDEN_ATTRIBUTES.has(attributeName) ||
    attributeName.indexOf("xmlns:") === 0
  ) {
    return null;
  }
  if (tagName === "iframe" && !IFRAME_ALLOWED_ATTRIBUTES.has(attributeName)) {
    return null;
  }
  if (UNSAFE_ATTRIBUTE_VALUE_RE.test(value)) {
    return null;
  }
  if (
    (attributeName === "id" || attributeName === "name") &&
    CLOBBER_TAG_SET.has(tagName) &&
    CLOBBER_NAME_SET.has(value)
  ) {
    return null;
  }
  return sanitizeAttributeValue(attributeName, value);
}

function sanitizeElementAttributes(element) {
  const tagName = element.localName ? element.localName.toLowerCase() : "";
  const attributes = Array.from(element.attributes || []);
  attributes.forEach(function (attribute) {
    const attributeName = String(attribute.name).toLowerCase();
    const safeValue = policyAttributeValue(
      tagName,
      attributeName,
      attribute.value,
    );
    if (safeValue === null) {
      element.removeAttributeNode(attribute);
    } else if (safeValue !== attribute.value) {
      attribute.value = safeValue;
    }
  });

  if (tagName === "iframe") {
    normalizeIframeAttributes(element);
  }
}

// The shared policy walk. For each child, in order: comments that could hide
// markup and processing instructions go; elements in removeWithContent (or
// the extra forbidden tags) go with their content; elements that are neither
// allowed nor custom elements are unwrapped (their children, already
// sanitized, take their place); every other element has its attributes
// sanitized and its children walked. An iframe keeps no children. Mirrors
// haxcms-php SanitizeContent::sanitizeNodeTree.
function sanitizeElementTree(rootNode, extraRemove, dropComments) {
  const children = Array.from(rootNode.childNodes || []);
  children.forEach(function (node) {
    let child = node;
    if (child.nodeType === 8) {
      if (dropComments || !isSafeComment(child.data)) {
        child.remove();
      }
      return;
    }
    if (child.nodeType === 7) {
      child.remove();
      return;
    }
    if (child.nodeType !== 1) {
      return;
    }
    const tagName = child.localName ? child.localName.toLowerCase() : "";
    if (
      REMOVE_WITH_CONTENT_SET.has(tagName) ||
      FORBIDDEN_TAG_SET.has(tagName) ||
      extraRemove.has(tagName) ||
      child.namespaceURI !== "http://www.w3.org/1999/xhtml"
    ) {
      child.remove();
      return;
    }
    if (!ALLOWED_TAG_SET.has(tagName) && !isCustomElementName(tagName)) {
      sanitizeElementTree(child, extraRemove, dropComments);
      while (child.firstChild) {
        child.parentNode.insertBefore(child.firstChild, child);
      }
      child.remove();
      return;
    }

    if (child.hasAttribute("is")) {
      // serializing writes an element's "is" value back even without the
      // attribute, so rebuild the element without it
      const plain = child.ownerDocument.createElementNS(
        child.namespaceURI,
        child.localName,
      );
      Array.from(child.attributes).forEach(function (attribute) {
        if (attribute.name !== "is") {
          plain.setAttributeNode(attribute.cloneNode());
        }
      });
      const source = child.localName === "template" ? child.content : child;
      const target = child.localName === "template" ? plain.content : plain;
      while (source.firstChild) {
        target.appendChild(source.firstChild);
      }
      child.parentNode.replaceChild(plain, child);
      child = plain;
    }

    sanitizeElementAttributes(child);

    if (tagName === "iframe") {
      while (child.firstChild) {
        child.removeChild(child.firstChild);
      }
      return;
    }
    if (tagName === "template") {
      const parentTag =
        child.parentElement && child.parentElement.localName
          ? child.parentElement.localName.toLowerCase()
          : "";
      if (TEXT_TEMPLATE_HOSTS.has(parentTag)) {
        if (child.content && child.content.querySelector("*")) {
          child.innerHTML = escapeTemplateText(child.innerHTML);
        }
      } else if (child.content) {
        sanitizeElementTree(child.content, extraRemove, dropComments);
      }
      return;
    }

    sanitizeElementTree(child, extraRemove, dropComments);
  });
}

// An HTML parser drops one newline right after <pre>, <listing> and
// <textarea>, so stored content that starts with a newline there would lose
// it on the next save. Drop it now so saving is idempotent.
const LEADING_NEWLINE_TAGS = new Set(["pre", "listing", "textarea"]);
function dropLeadingNewlines(rootNode) {
  Array.from(rootNode.childNodes || []).forEach(function (child) {
    if (child.nodeType !== 1) {
      return;
    }
    const first = child.firstChild;
    if (
      LEADING_NEWLINE_TAGS.has(child.localName) &&
      first &&
      first.nodeType === 3 &&
      first.data[0] === "\n"
    ) {
      first.data = first.data.substring(1);
      if (first.data === "") {
        first.remove();
      }
    }
    dropLeadingNewlines(
      child.localName === "template" && child.content ? child.content : child,
    );
  });
}

// DOMPurify's markup probe (SAFE_FOR_XML), checked parent before children on
// the policy's output: an element with child nodes but no element children,
// whose text and whose serialized content both look like markup (a comment
// next to text such as "&lt;script&gt;"), is removed with its content.
// Mirrors haxcms-php SanitizeContent::removeMarkupProbeElements.
const ELEMENT_MARKUP_PROBE_RE = /<[/\w!]/;
function removeMarkupProbeElements(rootNode) {
  Array.from(rootNode.childNodes || []).forEach(function (child) {
    if (child.nodeType !== 1) {
      return;
    }
    const hasElementChild = Array.from(child.childNodes).some(
      (n) => n.nodeType === 1,
    );
    if (
      child.childNodes.length > 0 &&
      !hasElementChild &&
      ELEMENT_MARKUP_PROBE_RE.test(child.textContent) &&
      ELEMENT_MARKUP_PROBE_RE.test(child.innerHTML)
    ) {
      child.remove();
      return;
    }
    removeMarkupProbeElements(
      child.localName === "template" && child.content ? child.content : child,
    );
  });
}

function sanitizeHTMLForStorage(html, options = {}) {
  if (typeof html !== "string") {
    return "";
  }
  // optional extra tags to remove on top of the storage policy (e.g.
  // "iframe" for untrusted imports), and dropComments to remove every comment
  const dropComments = !!(options && options.dropComments);
  const extraForbiddenTags =
    options && Array.isArray(options.forbidTags)
      ? options.forbidTags.map((t) => String(t).toLowerCase())
      : [];

  // 1. the shared policy (identical in haxcms-php)
  const document = newScratchDocument();
  document.body.innerHTML = html;
  preprocessTextTemplateHosts(document);
  sanitizeElementTree(document.body, new Set(extraForbiddenTags), dropComments);
  removeMarkupProbeElements(document.body);
  dropLeadingNewlines(document.body);
  const policyHTML = document.body.innerHTML;
  if (policyHTML === "") {
    // DOMPurify turns empty input into an empty comment
    return "";
  }

  // 2. DOMPurify as a backstop. It keeps what the policy kept (same tags,
  // custom elements, comments, every attribute as is), so on policy output it
  // changes nothing; test/unit/sanitize-parity.test.cjs holds it to that.
  let clean = getDOMPurify().sanitize(policyHTML, {
    ALLOWED_TAGS: POLICY.allowedTags.concat(["#text", "#comment"]),
    FORBID_TAGS: POLICY.removeWithContent.concat(
      FORBIDDEN_TAGS,
      extraForbiddenTags,
    ),
    ALLOWED_ATTR: [],
    // parse as body content, so a leading comment or <template> is not
    // moved into <head> and lost
    FORCE_BODY: true,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    CUSTOM_ELEMENT_HANDLING: {
      tagNameCheck: CUSTOM_ELEMENT_NAME_RE,
      attributeNameCheck: ATTRIBUTE_NAME_RE,
      allowCustomizedBuiltInElements: false,
    },
  });
  if (typeof clean !== "string") {
    clean = String(clean);
  }
  return clean;
}

module.exports = {
  sanitizeHTMLForStorage,
  // exported for the parity tests
  sanitizePolicyOnly: function (html, options = {}) {
    const extra =
      options && Array.isArray(options.forbidTags)
        ? options.forbidTags.map((t) => String(t).toLowerCase())
        : [];
    const document = newScratchDocument();
    document.body.innerHTML = String(html);
    preprocessTextTemplateHosts(document);
    sanitizeElementTree(
      document.body,
      new Set(extra),
      !!(options && options.dropComments),
    );
    removeMarkupProbeElements(document.body);
    dropLeadingNewlines(document.body);
    return document.body.innerHTML;
  },
  sanitizeAttributeValue,
  hasScriptCapableScheme,
  hasUnsafeDataMediaType,
  sanitizeURLValue,
  sanitizeMetadataValue,
  escapeHTMLAttribute,
  escapeXMLValue,
};
