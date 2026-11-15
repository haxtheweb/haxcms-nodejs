"use strict";

// Security regression guard for the site lifecycle system routes
// (clone / archive / download / download-skeleton / save-as-template).
//
// These routes are authorised by bearerAuth + userTokenHeader, which the
// router maps to the 'authenticated-user' policy (X-HAXCMS-User-Token
// validated against the bearer identity). They deliberately do NOT declare
// siteTokenHeader: the app-hax multisite dashboard never holds a per-site
// token (login / refresh only return siteToken when a site context resolves,
// which never happens on the dashboard) and builds its request headers from
// this spec, so adding siteTokenHeader here would break every dashboard
// lifecycle call. Both policy normalisers also treat any requirement that
// contains siteTokenHeader as 'authenticated-site' and stop enforcing
// userTokenHeader, so it would weaken rather than tighten the routes. A real
// per-site gate needs listSites / GET sites/{siteName} to hand out a per-site
// token that app-hax then sends. Until then this test pins the current
// contract so it cannot silently regress to public or lose the user token,
// and it must stay byte-identical with the haxcms-php system spec.
//
// Constraints honored: CommonJS (.cjs), require(), no optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const SPEC_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "src",
  "openapi",
  "system-spec.yaml",
);

const LIFECYCLE_ROUTES = [
  "/system/api/v1/sites/{siteName}/clone",
  "/system/api/v1/sites/{siteName}/archive",
  "/system/api/v1/sites/{siteName}/download",
  "/system/api/v1/sites/{siteName}/download-skeleton",
  "/system/api/v1/sites/{siteName}/save-as-template",
];

function loadSpec() {
  return YAML.parse(fs.readFileSync(SPEC_PATH, "utf8"));
}

test("lifecycle site routes require bearerAuth + userTokenHeader in one requirement", () => {
  const spec = loadSpec();
  for (let i = 0; i < LIFECYCLE_ROUTES.length; i++) {
    const route = LIFECYCLE_ROUTES[i];
    const pathItem = spec.paths[route];
    assert.ok(pathItem, route + " is declared in the system spec");
    assert.ok(pathItem.post, route + " declares POST");
    const security = pathItem.post.security;
    assert.ok(
      Array.isArray(security) && security.length > 0,
      route + " POST declares a non-empty security list",
    );
    for (let s = 0; s < security.length; s++) {
      const requirement = security[s];
      const keys = Object.keys(requirement || {}).sort();
      assert.deepEqual(
        keys,
        ["bearerAuth", "userTokenHeader"],
        route +
          " POST security requirement must be exactly bearerAuth + userTokenHeader (got " +
          JSON.stringify(keys) +
          ")",
      );
    }
    // the router has no other way to fall open for this route
    assert.equal(
      Object.prototype.hasOwnProperty.call(pathItem, "security"),
      false,
      route + " must not carry a path-level security override",
    );
  }
});

test("userTokenHeader and bearerAuth security schemes are the header-based ones the router enforces", () => {
  const spec = loadSpec();
  const schemes = spec.components.securitySchemes;
  assert.equal(schemes.bearerAuth.type, "http");
  assert.equal(schemes.bearerAuth.scheme, "bearer");
  assert.equal(schemes.userTokenHeader.type, "apiKey");
  assert.equal(schemes.userTokenHeader.in, "header");
  assert.equal(schemes.userTokenHeader.name, "X-HAXCMS-User-Token");
});
