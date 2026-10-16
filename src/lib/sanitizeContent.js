const createDOMPurify = require('dompurify')
const { JSDOM } = require('jsdom')

const EVENT_ATTRIBUTE_RE = /^on[a-z0-9_-]+$/i
const PROTOCOL_PREFIX_RE = /^([a-z0-9+.-]+):/i
const NORMALIZE_URL_RE = /[\u0000-\u001f\u007f\s]+/g

const FORBIDDEN_TAGS = [
  'script',
  'svg',
  'frame',
  'frameset',
  'applet',
  'meta',
  'link',
  'base',
  'style',
]
const FORBIDDEN_TAG_SET = new Set(FORBIDDEN_TAGS)
const FORBIDDEN_ATTRIBUTES = new Set(['srcdoc', 'style'])
const URL_ATTRIBUTE_NAMES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'srcset',
  'xlink:href',
  // Security (SEC-SANITIZE): HAX custom elements carry URLs in these
  // non-standard attribute names (simple-cta link, media-image source,
  // pdf-browser-viewer file, video-player sources/tracks). Keep in parity
  // with PHP SanitizeContent::URL_ATTRIBUTE_NAMES.
  'link',
  'source',
  'file',
  'sources',
  'tracks',
])
// Security (SEC-SANITIZE): schemes that can execute script. Checked on EVERY
// attribute regardless of name (DOMPurify's CUSTOM_ELEMENT_HANDLING lets any
// attribute on a custom element through without a URI check). This is a
// denylist on purpose: HAX attribute values are routinely scheme-shaped
// (icon="icons:check", title="Note: hi") so the http/https/mailto/tel
// allowlist can only apply to URL-named attributes.
const SCRIPT_CAPABLE_SCHEMES = new Set(['javascript', 'vbscript', 'livescript', 'mocha', 'data'])
const SCHEME_PREFIX_RE = /^([a-z][a-z0-9+.-]*):/
const SCHEME_STRIP_RE = /[\u0000-\u0020\u007f]+/g
const SCHEME_ENTITY_RE = /&#[xX]([0-9a-fA-F]+);?|&#([0-9]+);?|&(colon|Tab|NewLine|plus|period);/g
const SCHEME_NAMED_ENTITIES = {
  colon: ':',
  Tab: '\t',
  NewLine: '\n',
  plus: '+',
  period: '.',
}
const EXISTING_ENTITY_SAFE_AMP_RE = /&(?![a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g
const XML_ILLEGAL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const ALLOWED_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel'])
const TEXT_TEMPLATE_HOSTS = new Set(['code-sample', 'runkit-embed', 'web-container'])
const IFRAME_ALLOWED_ATTRIBUTES = new Set([
  'src',
  'title',
  'width',
  'height',
  'loading',
  'allow',
  'allowfullscreen',
  'credentialless',
  'referrerpolicy',
  'sandbox',
])
const IFRAME_SANDBOX_ALLOWED_TOKENS = new Set([
  'allow-downloads',
  'allow-forms',
  'allow-modals',
  'allow-pointer-lock',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-presentation',
  'allow-same-origin',
  'allow-scripts',
])
const IFRAME_DEFAULT_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-forms'
const REFERRER_POLICY_ALLOWED = new Set([
  'no-referrer',
  'origin',
  'strict-origin',
  'same-origin',
  'strict-origin-when-cross-origin',
  'origin-when-cross-origin',
  'unsafe-url',
])

let domPurifyInstance = null

function getDOMPurify() {
  if (domPurifyInstance !== null) {
    return domPurifyInstance
  }

  const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
  domPurifyInstance = createDOMPurify(jsdom.window)

  domPurifyInstance.addHook('uponSanitizeAttribute', function (node, data) {
    if (!data || !data.attrName) {
      return
    }
    const attributeName = String(data.attrName).toLowerCase()
    const nodeName = node && node.nodeName ? String(node.nodeName).toLowerCase() : ''

    if (EVENT_ATTRIBUTE_RE.test(attributeName) || FORBIDDEN_ATTRIBUTES.has(attributeName)) {
      data.keepAttr = false
      return
    }
    if (nodeName === 'iframe' && !IFRAME_ALLOWED_ATTRIBUTES.has(attributeName)) {
      data.keepAttr = false
      return
    }
    const safeValue = sanitizeAttributeValue(attributeName, data.attrValue)
    if (safeValue === null) {
      data.keepAttr = false
    } else {
      data.attrValue = safeValue
    }
  })

  return domPurifyInstance
}

function sanitizeURLValue(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback
  }
  const stringValue = String(value).trim()
  if (stringValue === '') {
    return fallback
  }
  if (stringValue[0] === '#') {
    return stringValue
  }
  const normalizedValue = stringValue.replace(NORMALIZE_URL_RE, '').toLowerCase()
  if (normalizedValue === '') {
    return fallback
  }
  const protocolMatch = normalizedValue.match(PROTOCOL_PREFIX_RE)
  if (!protocolMatch) {
    return stringValue
  }
  const protocol = protocolMatch[1]
  if (ALLOWED_PROTOCOLS.has(protocol)) {
    return stringValue
  }
  return fallback
}

// Security (SEC-SANITIZE): single-pass decode of the entity forms that can
// spell a scheme (numeric with or without ';', plus &colon; &Tab; &NewLine;
// &plus; &period;). Invalid code points decode to ''. Parity contract with PHP
// SanitizeContent::decodeSchemeEntities.
function decodeSchemeEntities(value) {
  return String(value).replace(SCHEME_ENTITY_RE, function (match, hex, dec, named) {
    if (named) {
      return SCHEME_NAMED_ENTITIES[named]
    }
    const codePoint = hex ? parseInt(hex, 16) : parseInt(dec, 10)
    if (
      !Number.isFinite(codePoint) ||
      codePoint <= 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return ''
    }
    return String.fromCodePoint(codePoint)
  })
}

// Security (SEC-SANITIZE): leading scheme of an attribute value after
// decoding entities, removing ASCII whitespace/control chars and lowercasing;
// '' when the value has no leading scheme.
function getNormalizedScheme(value) {
  if (value === null || value === undefined) {
    return ''
  }
  const normalized = decodeSchemeEntities(value).replace(SCHEME_STRIP_RE, '').toLowerCase()
  const match = normalized.match(SCHEME_PREFIX_RE)
  return match ? match[1] : ''
}

function hasScriptCapableScheme(value) {
  return SCRIPT_CAPABLE_SCHEMES.has(getNormalizedScheme(value))
}

// Security (SEC-SANITIZE): returns the value to keep, or null when the
// attribute must be removed (empty boolean attributes stay ''). URL-named attributes go through the
// sanitizeURLValue allowlist; every attribute is then rejected if its
// normalised value starts with a script-capable scheme.
function sanitizeAttributeValue(attributeName, value) {
  let safeValue = value === null || value === undefined ? '' : String(value)
  if (isURLLikeAttribute(attributeName)) {
    safeValue = sanitizeURLValue(safeValue, '')
    if (safeValue === '') {
      return null
    }
  }
  if (hasScriptCapableScheme(safeValue)) {
    return null
  }
  return safeValue
}

// doubleEncode=false mirrors PHP htmlspecialchars(..., double_encode: false):
// an '&' that already starts an entity is left alone, so values that
// round-trip through the editor (saveOutline sends every item's metadata
// back) do not accumulate &amp;amp;... on every save.
function sanitizeMetadataValue(value, doubleEncode = true) {
  if (value === null || value === undefined) {
    return ''
  }
  return escapeHTMLAttribute(value, doubleEncode)
}

function escapeHTMLAttribute(value, doubleEncode = true) {
  return String(value === null || value === undefined ? '' : value)
    .replace(doubleEncode === false ? EXISTING_ENTITY_SAFE_AMP_RE : /&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function escapeXMLValue(value) {
  return String(value === null || value === undefined ? '' : value)
    // Security (SEC-SANITIZE): drop code points not allowed in XML 1.0
    // (allowed: #x9 #xA #xD [#x20-#xD7FF] [#xE000-#xFFFD] [#x10000-#x10FFFF]);
    // lone surrogates are dropped, valid surrogate pairs are kept.
    .replace(XML_ILLEGAL_CHARS_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function isURLLikeAttribute(attributeName) {
  if (URL_ATTRIBUTE_NAMES.has(attributeName)) {
    return true
  }
  if (attributeName.indexOf('url') !== -1) {
    return true
  }
  if (attributeName.endsWith('-src')) {
    return true
  }
  if (attributeName.endsWith('-href')) {
    return true
  }
  return false
}

function escapeTemplateText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function preprocessTextTemplateHosts(html) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const document = dom.window.document
  document.body.innerHTML = html

  const selector = Array.from(TEXT_TEMPLATE_HOSTS).join(',')
  if (selector !== '') {
    const hosts = document.querySelectorAll(selector)
    hosts.forEach(function (host) {
      const templates = host.querySelectorAll('template')
      templates.forEach(function (templateElement) {
        if (templateElement.content && templateElement.content.querySelector('*')) {
          templateElement.innerHTML = escapeTemplateText(templateElement.innerHTML)
        }
      })
    })
  }

  const clean = document.body.innerHTML
  dom.window.close()
  return clean
}

function getElementChildren(node) {
  const children = []
  if (!node || !node.childNodes) {
    return children
  }
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i]
    if (child && child.nodeType === 1) {
      children.push(child)
    }
  }
  return children
}

function normalizeSandboxValue(value) {
  if (value === null || value === undefined) {
    return ''
  }
  const rawTokens = String(value).toLowerCase().split(/\s+/)
  const normalizedTokens = []
  rawTokens.forEach(function (token) {
    if (
      token !== '' &&
      IFRAME_SANDBOX_ALLOWED_TOKENS.has(token) &&
      normalizedTokens.indexOf(token) === -1
    ) {
      normalizedTokens.push(token)
    }
  })
  return normalizedTokens.join(' ')
}

function normalizeIframeAttributes(iframe) {
  const src = iframe.getAttribute('src')
  if (src !== null) {
    const safeSrc = sanitizeURLValue(src, '')
    if (safeSrc === '') {
      iframe.removeAttribute('src')
    } else if (safeSrc !== src) {
      iframe.setAttribute('src', safeSrc)
    }
  }

  const loading = iframe.getAttribute('loading')
  if (loading === null || loading.trim() === '') {
    iframe.setAttribute('loading', 'lazy')
  } else {
    const normalizedLoading = loading.toLowerCase()
    if (normalizedLoading !== 'lazy' && normalizedLoading !== 'eager') {
      iframe.setAttribute('loading', 'lazy')
    } else {
      iframe.setAttribute('loading', normalizedLoading)
    }
  }

  const referrerPolicy = iframe.getAttribute('referrerpolicy')
  if (referrerPolicy === null || referrerPolicy.trim() === '') {
    iframe.setAttribute('referrerpolicy', 'no-referrer')
  } else {
    const normalizedReferrerPolicy = referrerPolicy.toLowerCase()
    if (!REFERRER_POLICY_ALLOWED.has(normalizedReferrerPolicy)) {
      iframe.setAttribute('referrerpolicy', 'no-referrer')
    } else {
      iframe.setAttribute('referrerpolicy', normalizedReferrerPolicy)
    }
  }

  const sandboxValue = normalizeSandboxValue(iframe.getAttribute('sandbox'))
  if (sandboxValue === '') {
    iframe.setAttribute('sandbox', IFRAME_DEFAULT_SANDBOX)
  } else {
    iframe.setAttribute('sandbox', sandboxValue)
  }

  if (iframe.hasAttribute('allowfullscreen')) {
    iframe.setAttribute('allowfullscreen', 'allowfullscreen')
  }
}

function sanitizeElementAttributes(element) {
  const tagName = element.tagName ? element.tagName.toLowerCase() : ''
  const attributes = Array.from(element.attributes || [])
  attributes.forEach(function (attribute) {
    const attributeName = String(attribute.name).toLowerCase()
    if (EVENT_ATTRIBUTE_RE.test(attributeName) || FORBIDDEN_ATTRIBUTES.has(attributeName)) {
      element.removeAttribute(attribute.name)
      return
    }
    if (tagName === 'iframe' && !IFRAME_ALLOWED_ATTRIBUTES.has(attributeName)) {
      element.removeAttribute(attribute.name)
      return
    }
    const safeValue = sanitizeAttributeValue(attributeName, attribute.value)
    if (safeValue === null) {
      element.removeAttribute(attribute.name)
    } else if (safeValue !== attribute.value) {
      element.setAttribute(attribute.name, safeValue)
    }
  })

  if (tagName === 'iframe') {
    normalizeIframeAttributes(element)
  }
}

function sanitizeElementTree(rootNode) {
  const children = getElementChildren(rootNode)
  children.forEach(function (child) {
    const tagName = child.tagName ? child.tagName.toLowerCase() : ''
    if (FORBIDDEN_TAG_SET.has(tagName)) {
      child.remove()
      return
    }

    sanitizeElementAttributes(child)

    if (tagName === 'template') {
      const parentTag = child.parentElement && child.parentElement.tagName
        ? child.parentElement.tagName.toLowerCase()
        : ''
      if (TEXT_TEMPLATE_HOSTS.has(parentTag)) {
        if (child.content && child.content.querySelector('*')) {
          child.innerHTML = escapeTemplateText(child.innerHTML)
        }
      } else if (child.content) {
        sanitizeElementTree(child.content)
      }
      return
    }

    sanitizeElementTree(child)
  })
}

function sanitizeHTMLForStorage(html) {
  if (typeof html !== 'string') {
    return ''
  }

  const domPurify = getDOMPurify()
  const preparedHTML = preprocessTextTemplateHosts(html)
  let clean = domPurify.sanitize(preparedHTML, {
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ['srcdoc', 'style'],
    ADD_TAGS: ['iframe', 'template'],
    ADD_ATTR: [
      'src',
      'title',
      'width',
      'height',
      'loading',
      'allow',
      'allowfullscreen',
      'referrerpolicy',
      'sandbox',
      // #3112: embed elements emit credentialless for COEP pages; kept in
      // IFRAME_ALLOWED_ATTRIBUTES above but DOMPurify strips it first unless
      // allowlisted here as well
      'credentialless',
      // legacy question-element serialization on standard <input> elements;
      // data-correct is the target form and survives by default (#3113)
      'correct',
    ],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    CUSTOM_ELEMENT_HANDLING: {
      tagNameCheck: /^[a-z][a-z0-9._-]*-[a-z0-9._-]*$/,
      attributeNameCheck: /^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/,
      allowCustomizedBuiltInElements: false,
    },
  })

  if (typeof clean !== 'string') {
    clean = String(clean)
  }

  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const document = dom.window.document
  document.body.innerHTML = clean
  sanitizeElementTree(document.body)
  clean = document.body.innerHTML
  dom.window.close()
  return clean
}

module.exports = {
  sanitizeHTMLForStorage,
  sanitizeAttributeValue,
  hasScriptCapableScheme,
  sanitizeURLValue,
  sanitizeMetadataValue,
  escapeHTMLAttribute,
  escapeXMLValue,
}
