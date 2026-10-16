const yaml = require('js-yaml');

// Security (review 2026-10): YAML anchors/aliases ("billion laughs").
// js-yaml resolves an alias to a shared reference, so yaml.load() itself is
// cheap, but anything that serializes or walks the result (JSON.stringify)
// expands every reference: 296 bytes of nested aliases became 69 MB of JSON
// and ~380 bytes ran the process out of memory. Bound both the input size and
// the expanded size. The expanded size is measured by walking the loaded value
// and counting EVERY visit, including repeated visits to the same shared
// object; a seen-Set would stop at the first repeat and miss the expansion.
// Parity: PHP convertYamlToJson caps input at 256 KB and rejects alias bombs.
const MAX_YAML_BYTES = 256 * 1024;
const MAX_YAML_NODES = 100000;

class YamlLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'YamlLimitError';
  }
}

/**
 * Count nodes in the fully-expanded value, stopping as soon as the budget is
 * exceeded (so a bomb or a recursive alias costs at most maxNodes visits).
 * Returns true when the value fits the budget.
 */
function withinNodeBudget(value, maxNodes) {
  let count = 0;
  const stack = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    count++;
    if (count > maxNodes) {
      return false;
    }
    if (node && typeof node === 'object') {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          stack.push(node[i]);
        }
      }
      else if (!(node instanceof Date)) {
        const keys = Object.keys(node);
        for (let i = 0; i < keys.length; i++) {
          // a key is emitted too, so it counts toward the expanded size
          count++;
          stack.push(node[keys[i]]);
        }
      }
    }
  }
  return true;
}

/**
 * yaml.load() with an input-size cap and an expanded-node budget. Throws
 * YamlLimitError when either limit is exceeded; parse errors propagate as-is.
 */
function loadYamlBounded(text, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxBytes = typeof opts.maxBytes === 'number' ? opts.maxBytes : MAX_YAML_BYTES;
  const maxNodes = typeof opts.maxNodes === 'number' ? opts.maxNodes : MAX_YAML_NODES;
  const source = typeof text === 'string' ? text : String(text);
  if (Buffer.byteLength(source, 'utf8') > maxBytes) {
    throw new YamlLimitError(`YAML input exceeds the ${Math.floor(maxBytes / 1024)} KB limit`);
  }
  const parsed = yaml.load(source);
  if (!withinNodeBudget(parsed, maxNodes)) {
    throw new YamlLimitError(`YAML document expands beyond ${maxNodes} nodes (check anchors/aliases)`);
  }
  return parsed;
}

module.exports = {
  loadYamlBounded,
  withinNodeBudget,
  YamlLimitError,
  MAX_YAML_BYTES,
  MAX_YAML_NODES,
};
