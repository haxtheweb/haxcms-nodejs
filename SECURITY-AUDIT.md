# Security Audit Playbook — @haxtheweb/haxcms-nodejs

Entry point for recurring security audits of this repo. One of five HAX repos audited on a regular cycle (`create`, `haxcms-nodejs`, `webcomponents`, `haxcms-php`, `HAXiam`) — see the project-specific rule in the PRAW rule registry (`haxtheweb/praw` `RULES.md`).

## Read order (do this first)

1. `AGENTS.md` — test tiers and PR gates
2. `SECURITY.md` — disclosure policy (private advisory at `haxtheweb/issues`, never public issues) and the documented CSP exceptions
3. "Security invariants" below: the rules this code keeps. They are the committed record; there is no checked-in findings report. Inline `// Security (SEC-...)` comments mark where a rule is enforced (the tag names the rule, never an audit finding), and the regression tests in `test/unit/` and `test/api-conformance/` keep them true. Start a new round by checking each invariant against the code, then `git grep -n "Security (" -- src ':!src/public/build'` for the enforcement points

## Scope

- `src/` server-side code; exclude `src/public/build` (vendored browser bundles)
- Auth: `src/lib/HAXCMS.js` (HS256 allowlist, refresh-token family/jti rotation, scrypt passwords, 0600 secrets), `src/lib/loginRateLimiter.js`
- Egress: `src/lib/safeFetch.js` (scheme + all-IP SSRF checks, IP pinning, per-hop redirect re-validation, byte caps) — no raw `fetch()` to remote or author-controlled URLs
- Routes: `src/systemRoutes/v1/**`, `src/siteRoutes/v1/**` (fail-closed auth from the OpenAPI spec, site/user token HMAC, page-location containment)
- Uploads/files: `src/lib/HAXCMSFile.js`, `src/lib/stageRemoteFile.js` (0600 + `wx` + `crypto.randomUUID()`), `src/lib/FileContentScanner.js`
- Sanitization/CSP: `src/lib/sanitizeContent.js` (DOMPurify); nonce middleware in `src/app.js` (`'unsafe-eval'` is a documented, required bypass — do not remove)
- Process exec: argv-array `execFile` only; every `.exec(` hit should be `RegExp.prototype.exec`, not child_process
- Production dependencies: `npm audit --omit=dev`

## Security invariants

The rules the code keeps. Each bullet is one inline tag; a comment may carry more than one (`// Security (SEC-SSRF, SEC-PATH): ...`). A fix that introduces a new class of rule adds a line here in the same PR; a change that weakens one needs a matching test change. The same list (and the same tags) is used in `haxcms-php`.

- **SEC-SESSION:** JWTs are HS256 only and verified with the shared key; refresh tokens rotate by family/jti (hashes only in `_config/settings/refreshSessions.json`, tombstones on revoke, a short grace window for the previous jti) and a reused or unknown family is revoked; the refresh cookie is `HttpOnly`, `SameSite`, `Secure` on HTTPS, and always set/cleared through `setRefreshTokenCookie`; request/user/site tokens are HMACs under a key domain-separated from the JWT key, compared constant-time and type-strict, and validated against the request's own identity (`getRequestTokenUserName()`), never the process-global user; cookie-authenticated state changes (`session/refresh`, `session/connection-test`) pass `isSameOriginRequest` (Origin/Referer host + `Sec-Fetch-Site`); passwords are verified with scrypt and legacy plaintext is rehashed on first login
- **SEC-ROUTE:** security requirements come from the OpenAPI specs and fail closed to `authenticated`; every mutation route declares bearer + user/site token; site-scoped system routes check object-level access (`userCanAccessSite` / `enforceSiteAccess`) in HAXiam mode; anonymous callers never get rendered binaries or exports; clients only ever see client-safe error text (`src/lib/clientErrorMessage.js`, `src/lib/requestErrorHandler.js`), never paths, stacks or request bodies in logs
- **SEC-SANITIZE:** every content write path (saveNode, createNode, saveOutline, style guide, importers, inline-image materialisation) runs `sanitizeHTMLForStorage` (`src/lib/sanitizeContent.js`, DOMPurify policy: no script/style/svg/srcdoc/`on*`, scheme allowlist); iframes get a normalised attribute set and a default sandbox that never grants `allow-same-origin` unless the author set it; page metadata is merged through per-field rules (`applyPageMetadata`); manifest-derived values are encoded for their output context (managed JSON/XML templates, `<base href>`, the single-site `config.php` fallback)
- **SEC-SSRF:** every outbound fetch of a user- or manifest-supplied URL (importers, `stageRemoteFile`, file-from-URL, link checks, integrations, oEmbed/video metadata, release checks) goes through `src/lib/safeFetch.js` (`safeFetch` / `safeFetchToFile`): scheme allowlist, ALL resolved A/AAAA records checked (including mapped/compat/NAT64/6to4 IPv6 forms), the connection pinned to the validated IP, every redirect hop re-validated and capped, byte cap and timeout; no raw `fetch()`/axios on a remote URL; integrations forward only the provider's allowlisted params
- **SEC-PATH:** null-byte reject + `..`-segment reject + realpath prefix check (`src/lib/pathConfinement.js` `resolveContainedPath`, `resolvePageLocationRealPath`, `recurseCopy`) at read AND write; page `location` is server-derived and ids/site names go through `generateMachineName` / `cleanTitle`; symlinks cannot redirect a read, write or rename out of its root
- **SEC-UPLOAD:** multipart routes authenticate before multer writes anything; uploads are capped (multer hard cap plus the site's `maxUploadSizeMb`, also for URL downloads); extensions are allowlisted and cross-checked against content; inline images must carry a PNG/JPEG/GIF/WebP signature before reaching sharp; `files/` markup is force-downloaded (`src/lib/uploadSecurity.js`); temp/staged files are created `wx`, 0600, with `crypto.randomUUID()` names and swept
- **SEC-EXEC:** child processes use argv arrays (`execFile` / `execFileSync`), never shell strings; git commit messages, branch names and remote URLs are validated (`sanitizeGitCommitMessage`, `GIT_BRANCH_PATTERN`, `isSafeGitRemoteUrl`; no leading `-`, no `ext::`); headless Chromium keeps its sandbox unless running as root; no `eval` / `Function` / `vm` on input; every `.exec(` hit is `RegExp.prototype.exec`
- **SEC-HEADERS:** per-request CSP nonce (`script-src 'nonce-...'`, no `'unsafe-inline'` for scripts; `'unsafe-eval'` is the documented exception in `SECURITY.md`), page content is never given the nonce (`neutralizeUntrustedScriptNonces`); `frame-ancestors`, `Referrer-Policy`, `nosniff`, no `X-Powered-By`; `X-Forwarded-*` and the client IP are trusted only from configured proxies (`resolveTrustedProtocol` / `resolveTrustedHost`, `config.security.trustedProxies`) and the Host is checked against `config.security.allowedHosts` when set
- **SEC-RATELIMIT:** login and Basic auth throttle per IP::username and per username (`src/lib/loginRateLimiter.js`, keyed on `req.ip`, bounded memory); one-time sign-in link redemption throttles per IP::link selector; authenticated file operations are rate limited per user:site (`src/lib/fileOpsRateLimiter.js`); every route has a per-IP request ceiling (`src/lib/requestRateLimiter.js`)
- **SEC-MAGICLINK:** one-time sign-in links (`session/magic-link`) are minted only by something with filesystem access to `_config` (the CLI or a server-side script), never over HTTP; a token is `selector.verifier` and only the verifier's SHA-256 is stored (`_config/settings/magicLinks.json`, 0600, every read-modify-write under an exclusive lock, files created as root handed to the settings directory's owner), compared constant-time, single use, short-lived (default 10 minutes, at most 24 hours), and a new link revokes the account's older ones; GET only renders a confirmation page and never consumes; POST passes `isSameOriginRequest`, is throttled per IP::link selector, and on success sets the refresh cookie through `setRefreshTokenCookie` exactly like password login; every failure is the same generic answer and never clears an existing session; on HAXiam deployments the feature is off unless the operator sets `HAXCMS_MAGIC_LINK_ENABLED` (tenant config can't turn it on or change its lifetime), `HAXCMS_MAGIC_LINK_DISABLED` turns it off everywhere, and when it's off the route answers 404 and minting refuses (`src/lib/magicLinks.js`, `src/systemRoutes/v1/routes/magicLink.js`)
- **SEC-INSTALL:** first run generates secrets with `crypto` randomness and stores the admin password as a scrypt hash, never the default `admin` credential; the seeded password is handed off once through a 0600 file; secret files (`.pk`, `.rpk`, `SALT.txt`, `.user`, `apiKeys.json`) are written and re-chmodded 0600
- **SEC-EXPORT:** download/export artifacts get unguessable names, are swept after a TTL, and are never left at a predictable public path (`_published/`)
- **SEC-DOS:** request bodies, URLs, YAML (no anchors/aliases, size cap) and uploads are size-capped; regexes that see untrusted input are linear-time (no backtracking lazy spans); upstream calls carry timeouts; in-memory trackers are bounded
- **SEC-DEPLOY:** `_config/`, `_archived/`, dotfiles and `.git` are never served (Express only serves the app and site directories, with explicit denies for config files and dot-segments; the shipped `.htaccess` files deny them under Apache); the Docker image installs runtime dependencies only and keeps secrets out of the build; the no-login bypass is loopback-only, never in production, answers only loopback `Host` headers (DNS rebinding) and hands its superuser JWT only to loopback same-origin clients
- **SEC-STATIC-DOTFILES (Node only):** static dotfile and `..` decisions are made on the decoded path segments (`src/lib/staticRequestGuards.js`); only `/.well-known/` is served
- **SEC-LOCAL-ORIGIN (Node only):** with the no-login bypass, only `1`/`true` enable it, and non-safe cross-site requests (foreign Origin or `Sec-Fetch-Site: cross-site`) are refused
- **Parity:** every shared rule holds identically in `haxcms-php`, and both `src/openapi/system-spec.yaml` / `site-spec.yaml` stay byte-identical with it

## Commands

```bash
npm test                        # generic tests
npm run test:api-conformance    # v1 system + site routes vs OpenAPI specs (SSRF/security-layer cases live here)
npm run test:e2e                # UI workflow baseline
npm audit --omit=dev --audit-level=low --json
```

## Regression guards (must stay green)

- api-conformance suite (SSRF, actions-spec, auth assertions)
- e2e baseline (per-round pass/fail counts go in the audit PR description)
- Every new security fix ships with a test in `test/unit/` or an api-conformance case

## Reporting convention

- Findings, their IDs and severities live in the audit PR description or the private advisory, never in committed files; the committed record is the rule, not the finding. One PR per logical fix, each with a regression test; prior fixes are re-verified by keeping their tests green
- A fix lands with an inline `// Security (<invariant>)` comment naming the rule it enforces (one or more of the tags under "Security invariants", e.g. `SEC-SSRF`, `SEC-SANITIZE`, `SEC-SESSION`), never a finding ID, audit round, severity or PR number; test names describe the behaviour under test the same way
- If the fix is a new class of rule, add a line under "Security invariants" in the same PR
- Cite `file:line` everywhere
- **Parity:** security and data-model fixes shared with the PHP backend must be mirrored in `haxcms-php` (PHP-parity comments mark the pairs)

## Disclosure

Vulnerabilities go through `SECURITY.md` (private advisory), never public issues.
