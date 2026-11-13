/**
 * Platform update awareness for the system status report.
 *
 * Read-only by design: this module works out whether a newer release exists,
 * whether the installed version is missing a published security fix, and how
 * this install was put on the machine so the admin panel can show matching
 * upgrade steps. It never downloads, unpacks or writes release files; upgrades
 * run from a shell (`hax platform upgrade`), outside the web process.
 *
 * Mirrored in haxcms-php: system/backend/php/lib/PlatformUpdateService.php.
 * Both produce the same `update` object for SystemStatusData.
 */
const fs = require("fs-extra");
const path = require("path");
const { safeFetch } = require("./safeFetch.js");

// Security (SEC-SSRF): every outbound URL here is a fixed constant. No URL is
// ever taken from a request, from config or from a remote payload.
const RELEASES_LATEST_API_URL =
  "https://api.github.com/repos/haxtheweb/haxcms-nodejs/releases/latest";
const ADVISORIES_API_URL =
  "https://api.github.com/repos/haxtheweb/issues/security-advisories?state=published&per_page=100";
const RELEASES_PAGE_URL = "https://github.com/haxtheweb/haxcms-nodejs/releases";
const PACKAGE_KEY = "haxcms-nodejs";
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const MAX_ADVISORIES = 20;
// links shown in the admin panel must point at our own GitHub org
const TRUSTED_URL_PREFIX = "https://github.com/haxtheweb/";

const INSTALL_METHODS = [
  "node-npm",
  "node-docker",
  "node-source",
  "desktop",
  "php-archive",
  "php-git",
  "php-docker",
  "unknown",
];

let cache = {
  release: { expiresAt: 0, value: null },
  advisories: { expiresAt: 0, value: null },
};

/**
 * Reset the in-memory caches (tests).
 */
function resetPlatformUpdateCache() {
  cache = {
    release: { expiresAt: 0, value: null },
    advisories: { expiresAt: 0, value: null },
  };
}

function normalizeVersion(value = "") {
  let normalized = typeof value === "string" ? value : `${value || ""}`;
  normalized = normalized.trim();
  if (normalized.toLowerCase().indexOf("v") === 0) {
    normalized = normalized.substring(1);
  }
  return normalized;
}

/**
 * Parse the first x.y.z found in a version string ("v26.8.2", "10.0.3+",
 * ">= 26.0.1"). Returns [major, minor, patch] or null when there is none.
 */
function parseVersion(value = "") {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(`${value || ""}`);
  if (!match) {
    return null;
  }
  return [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    match[3] ? parseInt(match[3], 10) : 0,
  ];
}

/**
 * Compare two versions: -1 when a < b, 0 when equal, 1 when a > b, and null
 * when either one has no x.y.z in it.
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    if (left[i] < right[i]) {
      return -1;
    }
    if (left[i] > right[i]) {
      return 1;
    }
  }
  return 0;
}

/**
 * Advisory package names were entered by hand over the years
 * ("haxtheweb/haxcms-php", "/haxtheweb/haxcms-php", "haxcms/haxcms-php",
 * "HAXCMS PHP", "@haxtheweb/haxcms-nodejs", "haxcms-nodejs.operations").
 * Reduce one to a backend key: "haxcms-php", "haxcms-nodejs" or "" when it
 * names something else.
 */
function normalizeAdvisoryPackage(name = "") {
  let normalized = `${name || ""}`.trim().toLowerCase();
  normalized = normalized.replace(/^\/+/, "");
  normalized = normalized.replace(/^@?(haxtheweb|haxcms)\//, "");
  normalized = normalized.replace(/\.operations$/, "");
  normalized = normalized.replace(/\s+/g, "-");
  if (normalized === "haxcms-php") {
    return "haxcms-php";
  }
  if (normalized === "haxcms-nodejs") {
    return "haxcms-nodejs";
  }
  return "";
}

/**
 * Published advisories whose patched version for this backend is newer than
 * the installed version. Advisories without a parsable patched version are
 * skipped (they cannot be compared).
 */
function findSecurityAdvisories(
  advisories,
  currentVersion,
  packageKey = PACKAGE_KEY,
) {
  const found = [];
  if (!Array.isArray(advisories) || !parseVersion(currentVersion)) {
    return found;
  }
  for (let i = 0; i < advisories.length; i++) {
    const advisory = advisories[i];
    if (!advisory || typeof advisory !== "object") {
      continue;
    }
    if (advisory.withdrawn_at) {
      continue;
    }
    const vulnerabilities = Array.isArray(advisory.vulnerabilities)
      ? advisory.vulnerabilities
      : [];
    let patched = "";
    for (let j = 0; j < vulnerabilities.length; j++) {
      const vulnerability = vulnerabilities[j] || {};
      const pkg = vulnerability.package || {};
      if (normalizeAdvisoryPackage(pkg.name) !== packageKey) {
        continue;
      }
      const candidate = normalizeVersion(vulnerability.patched_versions || "");
      if (compareVersions(currentVersion, candidate) === -1) {
        patched = parseVersion(candidate).join(".");
        break;
      }
    }
    if (!patched) {
      continue;
    }
    const url =
      typeof advisory.html_url === "string" &&
      advisory.html_url.indexOf(TRUSTED_URL_PREFIX) === 0
        ? advisory.html_url
        : "";
    found.push({
      id: typeof advisory.ghsa_id === "string" ? advisory.ghsa_id : "",
      cve: typeof advisory.cve_id === "string" ? advisory.cve_id : "",
      severity: typeof advisory.severity === "string" ? advisory.severity : "",
      summary: typeof advisory.summary === "string" ? advisory.summary : "",
      url,
      patched,
    });
    if (found.length >= MAX_ADVISORIES) {
      break;
    }
  }
  return found;
}

/**
 * How this backend was installed, so the admin panel can show matching steps.
 * Node: Electron (desktop app), a container, a git checkout, or an npm install.
 */
function detectInstallMethod(options = {}) {
  const versions = options.versions || process.versions || {};
  const env = options.env || process.env || {};
  const exists =
    typeof options.exists === "function" ? options.exists : fs.pathExistsSync;
  const packageRoot =
    typeof options.packageRoot === "string"
      ? options.packageRoot
      : path.join(__dirname, "..", "..");
  if (versions.electron) {
    return "desktop";
  }
  if (env.HAXCMS_CONTAINER || exists("/.dockerenv")) {
    return "node-docker";
  }
  if (exists(path.join(packageRoot, ".git"))) {
    return "node-source";
  }
  if (packageRoot.split(path.sep).indexOf("node_modules") !== -1) {
    return "node-npm";
  }
  return "unknown";
}

/**
 * Release assets the admin panel may link to: name + https URL on our org.
 */
function pickReleaseAssets(release) {
  const assets = [];
  if (!release || !Array.isArray(release.assets)) {
    return assets;
  }
  for (let i = 0; i < release.assets.length; i++) {
    const asset = release.assets[i] || {};
    if (
      typeof asset.name === "string" &&
      typeof asset.browser_download_url === "string" &&
      asset.browser_download_url.indexOf(TRUSTED_URL_PREFIX) === 0
    ) {
      assets.push({ name: asset.name, url: asset.browser_download_url });
    }
  }
  return assets;
}

/**
 * Pure: assemble the `update` object of the status report.
 */
function buildUpdateInfo(options = {}) {
  const current = normalizeVersion(options.currentVersion || "") || "unknown";
  const managed = !!options.managed;
  const checkEnabled = !managed && options.checkEnabled !== false;
  const installMethod =
    INSTALL_METHODS.indexOf(options.installMethod) !== -1
      ? options.installMethod
      : "unknown";
  const release =
    checkEnabled && options.release && typeof options.release === "object"
      ? options.release
      : null;
  const latest =
    (release && normalizeVersion(release.tag_name || "")) || "unknown";
  const releaseUrl =
    release &&
    typeof release.html_url === "string" &&
    release.html_url.indexOf(TRUSTED_URL_PREFIX) === 0
      ? release.html_url
      : options.releasesPageUrl || RELEASES_PAGE_URL;
  const advisories = checkEnabled
    ? findSecurityAdvisories(
        options.advisories,
        current,
        options.packageKey || PACKAGE_KEY,
      )
    : [];
  return {
    checkEnabled,
    managed,
    current,
    latest,
    releasedAt:
      release && typeof release.published_at === "string"
        ? release.published_at
        : "",
    releaseUrl,
    updateAvailable: compareVersions(current, latest) === -1,
    security: advisories.length > 0,
    advisories,
    installMethod,
    assets: pickReleaseAssets(release),
  };
}

async function fetchJsonCached(slot, url) {
  const now = Date.now();
  if (cache[slot].value && cache[slot].expiresAt > now) {
    return cache[slot].value;
  }
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  let value = null;
  try {
    // Security (SEC-SSRF): fixed URL, routed through safeFetch (SSRF guard +
    // byte cap) with a hard timeout; a failure only hides the update notice.
    const response = await safeFetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "haxcms-nodejs-system-status",
      },
      signal: controller.signal,
    });
    if (response.ok) {
      value = await response.json();
    }
  } catch {
    value = null;
  }
  clearTimeout(timeoutHandle);
  if (value) {
    cache[slot] = { value, expiresAt: now + CACHE_TTL_MS };
  }
  return value;
}

function fetchLatestRelease() {
  return fetchJsonCached("release", RELEASES_LATEST_API_URL);
}

function fetchPublishedAdvisories() {
  return fetchJsonCached("advisories", ADVISORIES_API_URL);
}

/**
 * Whether outbound update checks are allowed: never on a host-managed
 * (HAXiam) deployment, and not when config.json sets updates.check to false.
 */
function getUpdateCheckPolicy(haxcms) {
  const profile =
    haxcms && typeof haxcms.getDeploymentProfile === "function"
      ? haxcms.getDeploymentProfile()
      : "single-site";
  const managed = profile === "haxiam-managed";
  const config = (haxcms && haxcms.config) || {};
  const updates = config.updates || {};
  return {
    managed,
    checkEnabled: !managed && updates.check !== false,
  };
}

/**
 * Build the `update` object for a running backend.
 */
async function buildPlatformUpdateInfo(haxcms, currentVersion) {
  const policy = getUpdateCheckPolicy(haxcms);
  let release = null;
  let advisories = null;
  if (policy.checkEnabled) {
    const results = await Promise.all([
      fetchLatestRelease(),
      fetchPublishedAdvisories(),
    ]);
    release = results[0];
    advisories = results[1];
  }
  return buildUpdateInfo({
    currentVersion,
    managed: policy.managed,
    checkEnabled: policy.checkEnabled,
    release,
    advisories,
    installMethod: detectInstallMethod(),
  });
}

module.exports = {
  ADVISORIES_API_URL,
  RELEASES_LATEST_API_URL,
  INSTALL_METHODS,
  buildPlatformUpdateInfo,
  buildUpdateInfo,
  compareVersions,
  detectInstallMethod,
  fetchLatestRelease,
  fetchPublishedAdvisories,
  findSecurityAdvisories,
  getUpdateCheckPolicy,
  normalizeAdvisoryPackage,
  parseVersion,
  pickReleaseAssets,
  resetPlatformUpdateCache,
};
