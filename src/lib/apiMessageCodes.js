'use strict';
// Translatable API messages (haxtheweb/issues#3157).
//
// Responses keep their English `message` (or `error`) text. This adds a
// stable `code` and any `params` next to it, so the editor and the hax CLI
// can show the message in the user's language (locales/haxcms-api.<lang>.json
// in @haxtheweb/haxcms-elements) and fall back to the English text.
//
// Codes come from the shared list in haxcmsApiCodes.json (the same file the
// PHP backend and the front end use). A handler can also set `code` and
// `params` itself; those are never overwritten.
//
// Constraints honored: CommonJS, no optional chaining.

const catalog = require('./haxcmsApiCodes.json');

// longer text is never one of our messages; skip it rather than run regexes on it
const MAX_MESSAGE_LENGTH = 1000;

const RULES = catalog.codes.map((entry) => ({
  code: entry.code,
  info: entry.kind === 'info',
  patterns: entry.match.map((source) => new RegExp('^(?:' + source + ')[.!]?$', 'i')),
}));
const RULES_BY_CODE = {};
RULES.forEach((rule) => {
  RULES_BY_CODE[rule.code] = rule;
});

/**
 * Find the code for an English message.
 * @param {string} message
 * @returns {{code: string, params: object, info: boolean}|null}
 */
function matchApiMessage(message) {
  if (typeof message !== 'string') {
    return null;
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return null;
  }
  const text = message.trim();
  if (text === '') {
    return null;
  }
  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[i];
    for (let j = 0; j < rule.patterns.length; j++) {
      const found = rule.patterns[j].exec(text);
      if (found) {
        const params = {};
        const groups = found.groups || {};
        Object.keys(groups).forEach((name) => {
          if (typeof groups[name] === 'string' && groups[name] !== '') {
            params[name] = groups[name];
          }
        });
        return { code: rule.code, params: params, info: rule.info };
      }
    }
  }
  return null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// add code/params to one object that carries a message
function annotateMessageHolder(holder, status) {
  if (!isPlainObject(holder) || Object.prototype.hasOwnProperty.call(holder, 'code')) {
    return;
  }
  const text = typeof holder.message === 'string'
    ? holder.message
    : (typeof holder.error === 'string' ? holder.error : null);
  if (text === null) {
    return;
  }
  const found = matchApiMessage(text);
  if (!found) {
    return;
  }
  // successful responses only get codes for messages meant for success
  const holderStatus = typeof holder.status === 'number' ? holder.status : status;
  if (!(holderStatus >= 400) && !found.info) {
    return;
  }
  holder.code = found.code;
  if (Object.keys(found.params).length > 0 && !Object.prototype.hasOwnProperty.call(holder, 'params')) {
    holder.params = found.params;
  }
}

/**
 * Add `code` / `params` next to the message in a response body.
 * Looks at the body itself, `body.data` and `body.__failed`.
 * @param {*} body response body (changed in place)
 * @param {number} status HTTP status of the response
 * @returns {*} the same body
 */
function annotateApiResponse(body, status) {
  if (!isPlainObject(body)) {
    return body;
  }
  const httpStatus = typeof status === 'number'
    ? status
    : (typeof body.status === 'number' ? body.status : 200);
  annotateMessageHolder(body, httpStatus);
  annotateMessageHolder(body.data, httpStatus);
  annotateMessageHolder(body.__failed, httpStatus);
  return body;
}

/**
 * Express middleware: annotate every JSON response.
 */
function apiMessageCodesMiddleware(req, res, next) {
  const json = res.json;
  res.json = function annotatedJson(body) {
    try {
      annotateApiResponse(body, res.statusCode);
    }
    catch (e) {
      // never let message codes break a response
    }
    return json.call(this, body);
  };
  next();
}

/**
 * English text for a code, with params filled in.
 */
function apiMessageText(code, params) {
  const entry = catalog.codes.find((item) => item.code === code);
  if (!entry) {
    return null;
  }
  const values = params || {};
  return entry.en.replace(/\{(\w+)\}/g, (placeholder, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder,
  );
}

module.exports = {
  matchApiMessage,
  annotateApiResponse,
  apiMessageCodesMiddleware,
  apiMessageText,
  API_MESSAGE_CODES: Object.keys(RULES_BY_CODE),
};
