const { HAXCMS, systemStructureContext } = require("../../lib/HAXCMS.js");
const EntityRegistry = require("../../lib/EntityRegistry.js");
const FileStorage = require("../../lib/FileStorage.js");
const { getRequestHeaderValue } = require("./siteRouteUtils.js");

function getRequestPath(req) {
  if (req && typeof req.originalUrl === "string" && req.originalUrl !== "") {
    return req.originalUrl.split("?")[0];
  }
  if (req && typeof req.url === "string" && req.url !== "") {
    return req.url.split("?")[0];
  }
  return "";
}

function getMultisiteSiteNameFromPath(requestPath = "") {
  const parts = String(requestPath || "")
    .split("/")
    .filter((part) => part !== "");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === HAXCMS.sitesDirectory && parts[i + 1]) {
      return decodeURIComponent(parts[i + 1]);
    }
  }
  return "";
}

function getApiBasePath(req) {
  const requestPath = getRequestPath(req);
  const matched = String(requestPath || "").match(/^(.*\/x\/api)(?:\/.*)?$/);
  if (matched && matched[1]) {
    return matched[1];
  }
  return "/x/api";
}

function buildDiscoveryLinks(apiBasePath = "/x/api") {
  return {
    self: `${apiBasePath}/v1/entities`,
    site: `${apiBasePath}/v1/site`,
    schemas: `${apiBasePath}/v1/schemas`,
    openapi: `${apiBasePath}/openapi`,
    openapiJson: `${apiBasePath}/openapi.json`,
    openapiYaml: `${apiBasePath}/openapi.yaml`,
  };
}

// Source entity descriptors from the single merged entities.yaml registry.
// Both /x/api/v1/entities and /system/api/v1/entities read from the same
// EntityRegistry::getDefinitions(), so the API surface and the in-code
// object are one shape. Optional ?scope=site|system filters the merged set.
function buildEntityDescriptorsFromRegistry(registry, scope) {
  const definitions = registry.getDefinitions(scope || null);
  const entities = [];
  for (let i = 0; i < definitions.length; i++) {
    entities.push(definitions[i].toDescriptorArray());
  }
  return entities;
}

// Security (entity listing scope): the system-scope part of the entity
// registry (and the endpoints it names) is only listed to a caller that is
// signed in and sends its X-HAXCMS-User-Token. Everyone else gets the site
// scope only, whatever ?scope= asks for, so an unauthenticated request can
// not fingerprint the build from the system entities. A signed-in caller
// without a valid user token gets the same 403 envelopes as the
// authenticated-user routes. CLI and disabled-JWT modes are trusted, as the
// route gate already treats them. Kept identical in haxcms-php.
function resolveEntityListingAccess(req) {
  const auth = req && req.haxcmsSiteApiAuth;
  if (!auth || typeof auth !== "object" || auth.authenticated !== true) {
    return { full: false };
  }
  if (HAXCMS.isCLI() || HAXCMS.HAXCMS_DISABLE_JWT_CHECKS) {
    return { full: true };
  }
  const userToken = getRequestHeaderValue(req, "x-haxcms-user-token");
  if (userToken === "") {
    return {
      full: false,
      status: 403,
      message: "X-HAXCMS-User-Token header is required for this endpoint",
    };
  }
  if (!HAXCMS.validateRequestToken(userToken, String(auth.userName || ""))) {
    return {
      full: false,
      status: 403,
      message: "Invalid X-HAXCMS-User-Token header",
    };
  }
  return { full: true };
}

async function resolveSiteForRequest(req) {
  const requestPath = getRequestPath(req);
  const siteName = getMultisiteSiteNameFromPath(requestPath);
  if (siteName !== "") {
    return await HAXCMS.loadSite(siteName);
  }
  return await systemStructureContext();
}

async function entities(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      data: {
        message: "Unable to resolve site context for /x/api/v1/entities",
      },
    });
  }
  const apiBasePath = getApiBasePath(req);
  const registry = new EntityRegistry(site);
  // Register the real FileStorage adapter for site-scope contexts so
  // registry.getStorage('file') returns the writable adapter instead of
  // NotImplementedStorage. Only register when the resolved site has a
  // siteDirectory (real site context); the systemStructureContext fallback
  // (no siteDirectory) keeps NotImplementedStorage for file.
  if (site && site.siteDirectory) {
    FileStorage.registerOn(registry);
  }
  const access = resolveEntityListingAccess(req);
  if (access.status) {
    return res.status(access.status).json({
      status: access.status,
      data: { message: access.message },
    });
  }
  const requestedScope =
    req && req.query && typeof req.query.scope === "string"
      ? req.query.scope.trim()
      : "";
  const scope = access.full ? requestedScope : "site";
  const descriptors = buildEntityDescriptorsFromRegistry(registry, scope);
  return res.json({
    status: 200,
    data: {
      count: descriptors.length,
      entities: descriptors,
      links: buildDiscoveryLinks(apiBasePath),
    },
  });
}

module.exports = entities;
