const UNSAFE_PROTOCOL_RE = /^\s*(?:javascript|vbscript|data\s*:\s*text\/html|data\s*:\s*application\/xhtml\+xml)\s*:/i
const EVENT_ATTRIBUTE_RE = /^on[a-z0-9_-]+$/i
const URL_LIKE_ATTRIBUTE_RE = /(?:^|[-_:])(?:href|src|action|formaction|poster|data|url)(?:$|[-_:])/i

function sanitizeURLValue(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback
  }
  const stringValue = String(value).trim()
  if (stringValue === '') {
    return fallback
  }
  if (UNSAFE_PROTOCOL_RE.test(stringValue)) {
    return fallback
  }
  return stringValue
}

function sanitizeMetadataValue(value) {
  if (value === null || value === undefined) {
    return ''
  }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function sanitizeHTMLForStorage(html) {
  if (typeof html !== 'string') {
    return ''
  }
  let clean = html
  clean = clean.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  clean = clean.replace(/\s+srcdoc\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
  clean = clean.replace(/\s+on[a-z0-9_-]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
  clean = clean.replace(
    /\s+([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g,
    function (match, attrName, attrValue, dqValue, sqValue, bareValue) {
      const attributeName = String(attrName).toLowerCase()
      if (EVENT_ATTRIBUTE_RE.test(attributeName)) {
        return ''
      }
      const value = dqValue || sqValue || bareValue || ''
      if (
        URL_LIKE_ATTRIBUTE_RE.test(attributeName) &&
        sanitizeURLValue(value, '') === ''
      ) {
        return ''
      }
      return match
    },
  )
  clean = clean.replace(
    /(<template\b[^>]*>)([\s\S]*?)(<\/template>)/gi,
    function (match, openTag, inner, closeTag) {
      return openTag + sanitizeHTMLForStorage(inner) + closeTag
    },
  )
  return clean
}

module.exports = {
  sanitizeHTMLForStorage,
  sanitizeURLValue,
  sanitizeMetadataValue,
}
