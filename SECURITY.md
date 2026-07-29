# Security Policy

This repository follows the HAX security policy (source of truth for `haxtheweb/*`):
https://github.com/haxtheweb/issues/security/policy

To report a vulnerability, submit a private advisory:
https://github.com/haxtheweb/issues/security/advisories/new

If you need to discuss first, contact the core team:

- Discord: https://discord.gg/qGBZMBnHc
- Email: hax@psu.edu

Please do not open public issues for unpatched security vulnerabilities.

## Known CSP deviation (documented exception)

The Content-Security-Policy in `src/app.js` includes `'unsafe-inline'` and
`'unsafe-eval'` in `script-src`. This is a justified, ecosystem-constrained
deviation from the Express security best-practice guidance to avoid
`'unsafe-inline'`:

- `'unsafe-eval'` is required by HAXcms boot bundles (`build.js` /
  `build-haxcms.js`) and several web components which call `new Function()` /
  `eval()` at runtime (e.g. global detection, the wc-registry "magic" loader
  chain). Removing it causes a CSP `EvalError` that aborts `build.js`, so
  sites never finish loading.
- `'unsafe-inline'` is required for the inline scripts this repo injects at
  runtime (dev-reload WebSocket, importmap, deduping-fix).

The primary XSS mitigation is the DOMPurify-based content sanitizer
(`src/lib/sanitizeContent.js`) which strips event handlers, forbidden tags
(`script`/`svg`/`style`/`meta`/`link`/`base`), and enforces a URL protocol
allowlist. Tightening CSP (removing `'unsafe-inline'` via nonces, removing
`'unsafe-eval'` by refactoring the offending web components) is tracked as a
separate, ecosystem-wide effort across the `webcomponents` monorepo.
