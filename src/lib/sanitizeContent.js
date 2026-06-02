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
])
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
    if (isURLLikeAttribute(attributeName)) {
      const safeValue = sanitizeURLValue(data.attrValue, '')
      if (safeValue === '') {
        data.keepAttr = false
      } else {
        data.attrValue = safeValue
      }
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

function escapeXMLValue(value) {
  return String(value === null || value === undefined ? '' : value)
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
    if (isURLLikeAttribute(attributeName)) {
      const safeValue = sanitizeURLValue(attribute.value, '')
      if (safeValue === '') {
        element.removeAttribute(attribute.name)
      } else if (safeValue !== attribute.value) {
        element.setAttribute(attribute.name, safeValue)
      }
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
}
