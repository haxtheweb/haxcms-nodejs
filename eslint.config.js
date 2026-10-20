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
      // tests are not linted (they are exercised by `npm run test:*`).
      "test/**",
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
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-undef": "error",
      // Many Security-hardening regexes in this codebase deliberately match
      // control characters (e.g. stripping \x00-\x1f before writing to git
      // commit messages / XML / managed templates). These are intentional,
      // not bugs, so the rule is disabled rather than warned-on.
      "no-control-regex": "off",
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
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
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
