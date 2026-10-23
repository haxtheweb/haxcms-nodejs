# Security Audit Playbook — @haxtheweb/haxcms-nodejs

Entry point for recurring security audits of this repo. One of five HAX repos audited on a regular cycle (`create`, `haxcms-nodejs`, `webcomponents`, `haxcms-php`, `HAXiam`) — see the project-specific rule in the PRAW rule registry (`haxtheweb/praw` `RULES.md`).

## Read order (do this first)

1. `AGENTS.md` — test tiers and PR gates
2. `security_best_practices_report.md` — canonical current state; it is a rolling document (dated re-audit sections are appended, prior findings get verified-fixed notes)
3. `security_post_fix_reaudit.md` — verification pass after the 2026-08 fix round
4. `SECURITY.md` — disclosure policy (private advisory at `haxtheweb/issues`, never public issues)

## Scope

- `src/` server-side code; exclude `src/public/build` (vendored browser bundles)
- Auth: `src/lib/HAXCMS.js` (HS256 allowlist, refresh-token family/jti rotation, scrypt passwords, 0600 secrets), `src/lib/loginRateLimiter.js`
- Egress: `src/lib/safeFetch.js` (scheme + all-IP SSRF checks, IP pinning, per-hop redirect re-validation, byte caps) — no raw `fetch()` to remote or author-controlled URLs
- Routes: `src/systemRoutes/v1/**`, `src/siteRoutes/v1/**` (fail-closed auth from the OpenAPI spec, site/user token HMAC, page-location containment)
- Uploads/files: `src/lib/HAXCMSFile.js`, `src/lib/stageRemoteFile.js` (0600 + `wx` + `crypto.randomUUID()`), `src/lib/FileContentScanner.js`
- Sanitization/CSP: `src/lib/sanitizeContent.js` (DOMPurify); nonce middleware in `src/app.js` (`'unsafe-eval'` is a documented, required bypass — do not remove)
- Process exec: argv-array `execFile` only; every `.exec(` hit should be `RegExp.prototype.exec`, not child_process
- Production dependencies: `npm audit --omit=dev`

## Commands

```bash
npm test                        # generic tests
npm run test:api-conformance    # v1 system + site routes vs OpenAPI specs (SSRF/security-layer cases live here)
npm run test:e2e                # UI workflow baseline
npm audit --omit=dev --audit-level=low --json
```

## Regression guards (must stay green)

- api-conformance suite (SSRF, actions-spec, auth assertions)
- e2e baseline (per-round pass/fail counts are recorded in the report)
- Every new security fix ships with a test in `test/unit/` or an api-conformance case

## Reporting convention

- `security_best_practices_report.md` is rolling: append a dated `Re-audit YYYY-MM-DD` section each round and re-verify prior findings
- Cite `file:line` with rule IDs (`EXPRESS-*`, `HAX-SEC-00x`)
- Mark fixes with inline `HAX-SEC-00x` / security comments in `src/`
- **Parity:** security and data-model fixes shared with the PHP backend must be mirrored in `haxcms-php` (PHP-parity comments mark the pairs)

## Disclosure

Vulnerabilities go through `SECURITY.md` (private advisory), never public issues.
