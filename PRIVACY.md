# Privacy and Data Handling

HAXcms is a self-hosted, file-based CMS: it runs on infrastructure you control. This document describes what data it touches, so campus adopters can complete privacy reviews (FERPA, GDPR, and institutional policy).

## What HAXcms stores

- **Site content** — plain HTML pages plus `site.json` under `_sites/<site>/`, and uploaded files under the site's `files/` directory. Content lives on your disk; nothing is sent anywhere except where you configure publishing (e.g. git push to gh-pages).
- **User data** — user settings and account data live in the instance's config directory (`userData.json`, plus per-user skeletons created via the UI). Passwords are not stored in plain text (the plaintext-password finding from the 2026 security review was fixed; see `security_best_practices_report.md`).
- **Sessions and tokens** — login sessions, and Bearer JWTs / site tokens for the v1 REST API (see `src/openapi/site-spec.yaml`; the API conformance suite tests the full auth matrix). Tokens are generated and validated on your server and do not leave it.

## What HAXcms does not do

- No analytics or telemetry is shipped; site visitor behavior is not tracked by HAXcms.
- No database — content and user data are files you can inspect, back up, and export at any time.

## Third-party calls

- Authoring UI and site assets load from the HAX component CDN by default (via the wc-registry "magic script" that imports components on demand); browsers fetch components from there unless you self-host assets. No user or content data is sent to the CDN.
- Conversion/analysis runs on-premises (`@system/`/`@site/` MFR namespaces)
- Any API integrations you add (media services, LTI, etc.) are configured by you and follow those services' policies.

## MCP tool access

`_config/config.json` controls MCP tool access: `deploymentProfile` (`single-site`, `self-hosted-multi-site`, `haxiam-managed`) plus `mcp.enabled` and `mcp.readOnly`. Managed deployments default MCP to disabled; other profiles default to enabled with read-only mode on. Future MCP write tools stay behind the `mcp.readOnly` write-protection toggle.

## Retention and compliance

Content persists until you delete the site — there is no server-side retention beyond the files themselves. Git history and your backups retain content per your own policies. Because HAXcms is self-hosted and file-backed, institutions can scope FERPA/GDPR compliance (access controls, retention, hosting region, logging) through their own infrastructure.
