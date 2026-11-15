# Security Policy

This repository follows the HAX security policy (source of truth for `haxtheweb/*`):
https://github.com/haxtheweb/issues/security/policy

To report a vulnerability, submit a private advisory:
https://github.com/haxtheweb/issues/security/advisories/new

If you need to discuss first, contact the core team:

- Discord: https://discord.gg/aCGxmRHEJP
- Email: hax@psu.edu

Please do not open public issues for unpatched security vulnerabilities.

## Content-Security-Policy (nonce-based) and documented exceptions

The Content-Security-Policy in `src/app.js` is nonce-based: every response
mints a per-request nonce (`cspNonceMiddleware`) and `script-src` carries
`'nonce-<n>'` with **no** `'unsafe-inline'`. The server stamps that nonce onto
the inline scripts it injects itself (importmap, dev-reload WebSocket,
deduping-fix) via `injectNonce`, and page content that reaches disk without the
save-time sanitizer never receives it. `base-uri 'self'`, `form-action 'self'`,
`object-src 'none'`, `base-uri 'self'` and `form-action 'self'` are also set. No `frame-ancestors` is sent by default because HAX sites are meant to be embedded by LMS and portal tools; operators can restrict framing with `config.security.frameAncestors` (an array of CSP sources).

Two deviations from the strictest policy remain and are deliberate:

- `'unsafe-eval'` (and `'wasm-unsafe-eval'`) in `script-src` is required by
  HAXcms boot bundles (`build.js` / `build-haxcms.js`) and several third-party
  libraries bundled into the build (mobx, lunr, monaco, model-viewer, pouch-db,
  moment, openseadragon, mammoth, html-midi-player, latex2html5) which call
  `new Function()` / `eval()` at runtime. Removing it causes a CSP `EvalError`
  that aborts `build.js`, so sites never finish loading. Do not remove it.
- `'unsafe-inline'` remains in `style-src` only: inline `<style>` blocks and the
  DDD design system rely on it.
- A single `sha256-…` hash allowlists the small inline script the YouTube
  IFrame API injects at runtime (Google's code, which cannot be nonced).

The primary XSS mitigation is the DOMPurify-based content sanitizer
(`src/lib/sanitizeContent.js`) which strips event handlers, forbidden tags
(`script`/`svg`/`style`/`meta`/`link`/`base`), enforces a URL protocol
allowlist and applies a sandbox to iframes. Removing `'unsafe-eval'` by refactoring the offending web
components is tracked as a separate, ecosystem-wide effort across the
`webcomponents` monorepo.
