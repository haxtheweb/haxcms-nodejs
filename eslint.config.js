const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettierConfig = require("eslint-config-prettier");

// The runtime/CI Node version this repo actually targets (see
// .github/workflows/build.yml matrix, currently pinned to Node 24).
// `engines.node` in package.json is intentionally a much wider compatibility
// floor for consumers of the published package, so eslint-plugin-n's
// node-builtins check is pointed at the real runtime version here instead.
// >=22.0.0 is the minimum floor that clears node:test's describe/suite
// (stable since 22.0.0, backported to 20.13.0, but the backport window alone
// doesn't cover the full >=20.0.0 range) as well as fetch/FormData (stable
// since 21.0.0). CustomEvent/localStorage are still experimental-only in
// Node as of this writing and are handled per-file below where they're
// legitimately DOM globals, not Node runtime APIs.
const NODE_BUILTINS_VERSION = ">=22.0.0";

// TODO(lint follow-up): the rules below are downgraded to "warn" for this
// initial rollout because they surface pre-existing findings in legacy code
// (src/lib/HAXCMS.js in particular, which has known, previously-documented
// latent bugs) that are out of scope for a lint-tooling change. A dedicated
// follow-up pass should fix these findings and promote the rules back to
// "error".
const LEGACY_CODE_WARN_RULES = {
  "no-empty": "warn",
  "no-redeclare": "warn",
  "no-unreachable": "warn",
  "no-cond-assign": "warn",
  "no-prototype-builtins": "warn",
  "no-case-declarations": "warn",
  "no-fallthrough": "warn",
  "no-irregular-whitespace": "warn",
};

module.exports = [
  js.configs.recommended,
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "_sites/**",
      "_archived/**",
      "_published/**",
      "_config/**",
      "src/public/**",
      "src/lib/vendor/**",
      "src/boilerplate/**",
      "screenshots/**",
    ],
  },
  // Default: CommonJS source files
  {
    files: ["src/**/*.js", "scripts/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: "latest",
      globals: {
        ...globals.node,
      },
    },
    plugins: { n },
    rules: {
      ...n.configs["flat/recommended-script"].rules,
      "no-restricted-syntax": [
        "error",
        {
          selector: "ChainExpression",
          message: "Optional chaining (?.) is not allowed in this codebase.",
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "window",
          message: "Use globalThis instead of window for consistency.",
        },
      ],
      // bin entries point at dist/ (babel output of src/), so eslint-plugin-n
      // thinks the src/ shebangs are unneeded and --fix strips them. They must
      // stay: babel copies them into dist/ for local.js, cli.js and app.js.
      "n/hashbang": "off",
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-process-exit": "off",
      "n/no-unsupported-features/node-builtins": [
        "error",
        { version: NODE_BUILTINS_VERSION },
      ],
      // html-to-vdom is a transitive dependency of html-to-docx, resolved
      // deliberately via require.resolve(..., { paths: [...] }) in
      // exportImageResolver.js so parsing matches exactly what html-to-docx
      // itself uses at runtime (see SEC-SSRF comments in that file).
      "n/no-extraneous-require": ["error", { allowModules: ["html-to-vdom"] }],
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // TODO(lint follow-up): HAXCMS.js and JSONOutlineSchema.js contain
      // genuine legacy implicit-globals (undeclared assignments like
      // `response = {}`) in sparsely-tested methods. Downgraded to warn
      // for this rollout rather than hand-editing that behavior as a
      // side effect of adding lint tooling; see eslint-disable-line usage
      // note above.
      "no-undef": "warn",
      // Many Security-hardening regexes in this codebase deliberately match
      // control characters (e.g. stripping \x00-\x1f before writing to git
      // commit messages / XML / managed templates). These are intentional,
      // not bugs, so the rule is disabled rather than warned-on.
      "no-control-regex": "off",
      ...LEGACY_CODE_WARN_RULES,
    },
  },
  // cli.js uses ESM import/export (transpiled by Babel at build time)
  {
    files: ["src/cli.js"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: "latest",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ChainExpression",
          message: "Optional chaining (?.) is not allowed in this codebase.",
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "window",
          message: "Use globalThis instead of window for consistency.",
        },
      ],
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Tests: CommonJS with node:test globals
  {
    files: ["test/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: "latest",
      globals: {
        ...globals.node,
      },
    },
    plugins: { n },
    rules: {
      ...n.configs["flat/recommended-script"].rules,
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      // test/e2e helpers require their own axe-core/puppeteer-core/fs-extra/
      // etc. from test/e2e/helpers/package.json (a private, non-published
      // workspace-local package), which this rule can't resolve relative to
      // the repo root package.json.
      "n/no-extraneous-require": "off",
      // see matching comment on the src/**/*.js block above: intentional
      // process.exit() calls in standalone discovery/debug scripts (dotfiles,
      // excluded from the node --test glob) and a deliberately unreferenced
      // forced-exit safety valve in a test's teardown hook.
      "n/no-process-exit": "off",
      "n/no-unsupported-features/node-builtins": [
        "error",
        { version: NODE_BUILTINS_VERSION },
      ],
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // see matching comment in the src/**/*.js block above
      "no-control-regex": "off",
      ...LEGACY_CODE_WARN_RULES,
    },
  },
  // E2E tests + their helpers: Puppeteer page.evaluate()/evaluateHandle()
  // callbacks execute inside the real browser page, not Node, so `document`/
  // `window`/`localStorage` are legitimate globals there. A few helpers also
  // use `eval(walkSrc)` inside an evaluate() callback to inject a `walk`
  // function at runtime (so it can be shared as a string constant across
  // multiple evaluate() calls); ESLint can't see through the eval string, so
  // `walk` appears undefined even though it exists at runtime.
  {
    files: ["test/e2e/**/*.cjs"],
    languageOptions: {
      globals: {
        ...globals.browser,
        walk: "readonly",
      },
    },
    rules: {
      // localStorage/CustomEvent here run inside page.evaluate()/
      // evaluateHandle() callbacks, i.e. in the real browser page, not in
      // the Node process this rule is checking compatibility against (see
      // the matching comment on the globals.browser override above).
      "n/no-unsupported-features/node-builtins": [
        "error",
        {
          version: NODE_BUILTINS_VERSION,
          ignores: ["localStorage", "CustomEvent"],
        },
      ],
    },
  },
  // Plain CJS config/script files at repo root
  {
    files: ["*.js", "scripts/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: "latest",
      globals: {
        ...globals.node,
      },
    },
  },
  prettierConfig,
];
