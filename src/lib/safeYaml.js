'use strict';

const yaml = require('js-yaml');

/**
 * Security (SEC-SSRF / YAML alias amplification): js-yaml resolves aliases
 * (*name) to shared references, so a few hundred bytes of nested anchors
 * ("billion laughs") become an exponentially large object the moment it is
 * JSON.stringify'd or walked. HAX has no legitimate use for anchors/aliases
 * in the content it accepts, so they are rejected outright, and the input
 * size is capped before parsing.
 *
 * Parity with PHP (convertYamlToJson.php): same 256 KB limit, same error
 * messages, HTTP 400 at the route.
 */
const YAML_MAX_INPUT_BYTES = 262144;
const YAML_ALIAS_ERROR_MESSAGE = 'YAML anchors and aliases are not supported';
const YAML_TOO_LARGE_ERROR_MESSAGE = 'YAML input exceeds the maximum size of 262144 bytes';

function yamlError(message, code) {
  var err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

/**
 * Parse YAML with the size cap and anchor/alias rejection applied. Throws an
 * Error with .code YAML_TOO_LARGE or YAML_ALIAS (and .status 400) on policy
 * rejection; js-yaml syntax errors propagate unchanged.
 *
 * Detection uses js-yaml's parse-time `listener` hook: every node carrying an
 * anchor property (&name) is reported with state.anchor set, and an alias can
 * only reference an anchor defined earlier in the document (js-yaml throws
 * "unidentified alias" otherwise), so refusing the first anchor refuses every
 * alias before any expansion happens. Text that merely contains '&' or '*'
 * (plain scalars such as "Tom & Jerry" or "some *bold* text", quoted strings)
 * is not an anchor and still parses.
 */
function loadYamlSafely(input, options) {
  var text = typeof input === 'string' ? input : String(input === undefined || input === null ? '' : input);
  var opts = options || {};
  var maxBytes = typeof opts.maxBytes === 'number' && opts.maxBytes > 0 ? opts.maxBytes : YAML_MAX_INPUT_BYTES;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw yamlError(YAML_TOO_LARGE_ERROR_MESSAGE, 'YAML_TOO_LARGE');
  }
  return yaml.load(text, {
    listener: function (eventType, state) {
      if (state && state.anchor !== null && state.anchor !== undefined) {
        throw yamlError(YAML_ALIAS_ERROR_MESSAGE, 'YAML_ALIAS');
      }
    },
  });
}

module.exports = {
  loadYamlSafely,
  YAML_MAX_INPUT_BYTES,
  YAML_ALIAS_ERROR_MESSAGE,
  YAML_TOO_LARGE_ERROR_MESSAGE,
};
