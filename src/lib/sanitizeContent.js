const createDOMPurify = require('dompurify')
const { JSDOM } = require('jsdom')
const strip_tags = require('locutus/php/strings/strip_tags').strip_tags
const html_entity_decode = require('locutus/php/strings/html_entity_decode').html_entity_decode

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
  // Security (review 2026-10): HAX custom elements take URLs in attributes not
  // named like URLs (simple-cta link, media-image source, pdf-browser-viewer
  // file, video-player sources/tracks); mirrors PHP SanitizeContent
  'link',
  'source',
  'file',
  'sources',
  'tracks',
])
const ALLOWED_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel'])
// Security (review 2026-10): URL attributes whose value may be a JSON list of
// {src,...} objects (video-player sources / tracks); every nested URL is checked
const JSON_URL_ATTRIBUTE_NAMES = new Set(['sources', 'tracks'])
// Security (review 2026-10): attributes that browsers and HAX elements only ever
// treat as text; exempt from the executable-scheme check on other attributes so
// title="JavaScript: the good parts" keeps working
const TEXT_ONLY_ATTRIBUTE_NAMES = new Set(['title', 'alt', 'placeholder'])
const SCHEME_CHECK_STRIP_RE = /[\u0000-\u0020\u007f]+/g
const EXECUTABLE_SCHEME_RE = /^(?:javascript|vbscript|livescript):/
const DATA_URL_RE = /^data:(?:[a-z0-9.+-]+\/[a-z0-9.+-]+)?(?:;[^,]*)?,/
const ENTITY_RE = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi
const SCHEME_CHECK_NAMED_ENTITIES = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  nbsp: '\u00a0',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}
const JSON_URL_MAX_DEPTH = 32
const METADATA_MAX_DEPTH = 32
const METADATA_URL_KEYS = new Set(['image', 'linkUrl'])
const METADATA_ESCAPED_KEYS = new Set([
  'tags',
  'icon',
  'accentColor',
  'linkTarget',
  'relatedItems',
  'author',
])
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const METADATA_DROP = Symbol('drop')
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
  // Security (review 2026-10): decode character references once before the
  // scheme check so &#106;avascript: / javascript&colon; in raw strings (page
  // metadata, JSON attribute values) cannot slip past; mirrors PHP
  const normalizedValue = decodeEntitiesForSchemeCheck(stringValue)
    .replace(NORMALIZE_URL_RE, '')
    .toLowerCase()
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

function sanitizeMetadataValue(value) {
  if (value === null || value === undefined) {
    return ''
  }
  return escapeHTMLAttribute(value)
}

function escapeHTMLAttribute(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// Security (review 2026-10): characters that are not allowed anywhere in an
// XML 1.0 document (C0 controls other than tab/LF/CR, lone surrogates,
// U+FFFE/U+FFFF); a single one makes rss.xml / sitemap.xml unparseable.
// Mirrors PHP SanitizeContent::escapeXMLValue
const XML_ILLEGAL_CHARS_RE = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu

function escapeXMLValue(value) {
  return String(value === null || value === undefined ? '' : value)
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

// Security (review 2026-10): decode HTML character references exactly once,
// only to *detect* a scheme (the original value is what gets stored). Numeric
// references may omit the trailing semicolon, as browsers allow. Mirrors PHP
// SanitizeContent::decodeEntitiesForSchemeCheck
function decodeEntitiesForSchemeCheck(value) {
  return String(value).replace(ENTITY_RE, function (match, body) {
    const lowerBody = body.toLowerCase()
    if (lowerBody[0] === '#') {
      const codePoint = lowerBody[1] === 'x'
        ? parseInt(lowerBody.substring(2), 16)
        : parseInt(lowerBody.substring(1), 10)
      if (
        !Number.isFinite(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return match
      }
      return String.fromCodePoint(codePoint)
    }
    if (Object.prototype.hasOwnProperty.call(SCHEME_CHECK_NAMED_ENTITIES, lowerBody)) {
      return SCHEME_CHECK_NAMED_ENTITIES[lowerBody]
    }
    return match
  })
}

// Security (review 2026-10): true when a value that is not known to be a URL
// still starts with a scheme that executes script when a front-end element
// later uses it as a URL (javascript:, vbscript:, livescript:, data: URLs).
// This is a denylist on purpose: an allowlist would also hit plain text such
// as "Note: x" once whitespace is stripped. Mirrors PHP
// SanitizeContent::isExecutableSchemeValue
function isExecutableSchemeValue(value) {
  if (typeof value !== 'string') {
    return false
  }
  const normalizedValue = decodeEntitiesForSchemeCheck(value)
    .replace(SCHEME_CHECK_STRIP_RE, '')
    .toLowerCase()
  return EXECUTABLE_SCHEME_RE.test(normalizedValue) || DATA_URL_RE.test(normalizedValue)
}

function isTextOnlyAttribute(attributeName) {
  return TEXT_ONLY_ATTRIBUTE_NAMES.has(attributeName) || attributeName.indexOf('aria-') === 0
}

function isUnsafeURLString(value, key) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false
  }
  if (typeof key === 'string' && isURLLikeAttribute(key.toLowerCase())) {
    return sanitizeURLValue(value, '') === ''
  }
  return isExecutableSchemeValue(value)
}

function jsonContainsUnsafeURL(node, key, depth) {
  if (depth > JSON_URL_MAX_DEPTH) {
    return true
  }
  if (typeof node === 'string') {
    return isUnsafeURLString(node, key)
  }
  if (Array.isArray(node)) {
    return node.some(function (entry) {
      return jsonContainsUnsafeURL(entry, key, depth + 1)
    })
  }
  if (node && typeof node === 'object') {
    return Object.keys(node).some(function (childKey) {
      return jsonContainsUnsafeURL(node[childKey], childKey, depth + 1)
    })
  }
  return false
}

// Security (review 2026-10): single attribute policy used by both sanitizer
// passes. Returns the (possibly rewritten) value, or null to drop the
// attribute. Mirrors PHP SanitizeContent::sanitizeAttributeValue
function sanitizeAttributeValue(attributeName, value) {
  const stringValue = value === null || value === undefined ? '' : String(value)
  if (isURLLikeAttribute(attributeName)) {
    if (JSON_URL_ATTRIBUTE_NAMES.has(attributeName)) {
      const trimmed = stringValue.trim()
      if (trimmed[0] === '[' || trimmed[0] === '{') {
        let parsed
        let isJSON = false
        try {
          parsed = JSON.parse(trimmed)
          isJSON = true
        } catch (e) {
          isJSON = false
        }
        if (isJSON) {
          return jsonContainsUnsafeURL(parsed, attributeName, 0) ? null : stringValue
        }
      }
    }
    const safeValue = sanitizeURLValue(stringValue, '')
    return safeValue === '' ? null : safeValue
  }
  if (!isTextOnlyAttribute(attributeName) && isExecutableSchemeValue(stringValue)) {
    return null
  }
  return stringValue
}

// Security (review 2026-10): undo exactly what escapeHTMLAttribute produces so
// metadata that round-trips through the outline editor is not escaped again on
// every save (escape(unescape(x)) is idempotent). Mirrors PHP
function unescapeHTMLAttribute(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
}

function isEscapableMetadataScalar(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function sanitizeMetadataTree(value, depth) {
  if (depth > METADATA_MAX_DEPTH) {
    return METADATA_DROP
  }
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : METADATA_DROP
  }
  if (typeof value === 'string') {
    return isExecutableSchemeValue(value) ? METADATA_DROP : value
  }
  if (Array.isArray(value)) {
    const cleanList = []
    value.forEach(function (entry) {
      const cleanEntry = sanitizeMetadataTree(entry, depth + 1)
      if (cleanEntry !== METADATA_DROP) {
        cleanList.push(cleanEntry)
      }
    })
    return cleanList
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const cleanObject = {}
    Object.keys(value).forEach(function (childKey) {
      if (UNSAFE_OBJECT_KEYS.has(childKey)) {
        return
      }
      const cleanEntry = sanitizeMetadataTree(value[childKey], depth + 1)
      if (cleanEntry !== METADATA_DROP) {
        cleanObject[childKey] = cleanEntry
      }
    })
    return cleanObject
  }
  return METADATA_DROP
}

// Security (review 2026-10): sanitize a client-supplied page metadata object
// (saveOutline, createNode items, addPage) with the same per-field rules
// saveNode applies to page-break attributes. Known keys:
//   image, linkUrl                  -> sanitizeURLValue (blocked scheme -> '')
//   tags, icon, accentColor, linkTarget, relatedItems, author
//                                   -> escapeHTMLAttribute (idempotent; a list
//                                      is escaped entry by entry, non-scalar
//                                      entries dropped)
//   theme                           -> must name a theme in `themes`, else dropped
// Every other key is passed through (the outline editor round-trips created,
// updated, published, hideInMenu, locked, pageType, files, ...) but only as
// JSON-shaped data (null/bool/finite number/string/array/plain object), and
// any string anywhere inside it that starts with an executable scheme
// (javascript:, vbscript:, livescript:, data: URL) is dropped.
// Returns a new plain object; dropped keys are absent so the caller's merge
// keeps the previously stored value. Mirrors PHP
// SanitizeContent::sanitizePageMetadata
function sanitizePageMetadata(metadata, themes) {
  const result = {}
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return result
  }
  Object.keys(metadata).forEach(function (key) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      return
    }
    const value = metadata[key]
    if (METADATA_URL_KEYS.has(key)) {
      if (typeof value === 'string') {
        result[key] = sanitizeURLValue(value, '')
      }
      return
    }
    if (METADATA_ESCAPED_KEYS.has(key)) {
      if (isEscapableMetadataScalar(value)) {
        result[key] = escapeHTMLAttribute(unescapeHTMLAttribute(String(value)))
      } else if (Array.isArray(value)) {
        // tags / relatedItems are stored as lists in canonical site.json
        // (JSONOutlineSchema normalizeItemValues)
        result[key] = value.filter(isEscapableMetadataScalar).map(function (entry) {
          return escapeHTMLAttribute(unescapeHTMLAttribute(String(entry)))
        })
      }
      return
    }
    if (key === 'theme') {
      if (value === null) {
        result[key] = null
        return
      }
      let themeKey = null
      if (typeof value === 'string') {
        themeKey = value
      } else if (value && typeof value === 'object' && typeof value.key === 'string') {
        themeKey = value.key
      }
      if (
        themeKey !== null &&
        themes &&
        typeof themes === 'object' &&
        Object.prototype.hasOwnProperty.call(themes, themeKey) &&
        themes[themeKey] &&
        typeof themes[themeKey] === 'object'
      ) {
        result[key] = Object.assign({}, themes[themeKey], { key: themeKey })
      }
      return
    }
    const cleanValue = sanitizeMetadataTree(value, 0)
    if (cleanValue !== METADATA_DROP) {
      result[key] = cleanValue
    }
  })
  return result
}

// Security (review 2026-10): plain-text field cleanup for page title /
// description. Decode entities FIRST, then strip tags, exactly once: the old
// strip-then-decode order turned "&lt;img src=x onerror=alert(1)&gt;" into a
// live <img> in site.json. A double-encoded payload only decodes one level and
// stays inert text. Mirrors PHP SanitizeContent::sanitizeTextValue
function sanitizeTextValue(value) {
  if (value === null || value === undefined) {
    return ''
  }
  return strip_tags(html_entity_decode(String(value)))
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
  sanitizeURLValue,
  sanitizeMetadataValue,
  escapeHTMLAttribute,
  escapeXMLValue,
  isExecutableSchemeValue,
  sanitizeAttributeValue,
  sanitizePageMetadata,
  sanitizeTextValue,
}
