// One-time sign-in ("magic") links for account recovery.
//
// haxtheweb/issues#2854. A link carries a split token `<selector>.<verifier>`:
//   - selector: random, non-secret lookup key for the stored record
//   - verifier: 256-bit secret; only its SHA-256 hash is persisted
// Records live in _config/settings/magicLinks.json next to refreshSessions.json
// (same protected directory, same 0o600 secret-file handling). No database.
//
// Issuance is deliberately NOT exposed over HTTP yet: today the only way to mint
// a link is from a process with filesystem access to _config (the HAX CLI,
// `hax site site:login-link`). Anyone who can write _config can already replace
// .user, so CLI issuance adds no new trust boundary. The record keeps a
// `channel` field so a later emailed-link request endpoint can share this store.
//
// The store is read and written with synchronous fs calls so that, inside one
// Node process, a consume is atomic (no await between check and invalidate).
// Writes go to a temp file and are renamed into place so a server process never
// reads a half-written file the CLI is producing (and vice versa).
//
// Constraints honored: CommonJS, no optional chaining, no new dependencies.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_TTL_SECONDS = 10 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_OUTSTANDING = 3;
const SELECTOR_PATTERN = /^[A-Za-z0-9_-]{12,64}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function clampInt(value, fallback, min, max) {
  var num = parseInt(value, 10);
  if (isNaN(num)) {
    num = fallback;
  }
  if (num < min) {
    num = min;
  }
  if (num > max) {
    num = max;
  }
  return num;
}

function isTruthyFlag(value) {
  if (typeof value !== "string") {
    return false;
  }
  var normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

// config.iam is set by HAXiam; deploymentProfile is derived from it (or set
// explicitly). Either one means a HAXiam-managed deployment.
function isHaxiamDeployment(haxcms) {
  if (!haxcms || !haxcms.config) {
    return false;
  }
  if (haxcms.config.iam) {
    return true;
  }
  return (
    String(haxcms.config.deploymentProfile || "").toLowerCase() ===
    "haxiam-managed"
  );
}

/**
 * Resolve magic-link policy.
 *   single-site / self-hosted multisite: on by default (with no HTTP issuance
 *     path, only links minted by someone with _config access can be redeemed);
 *     config.security.magicLink.enabled=false turns it off.
 *   HAXiam (config.iam or deploymentProfile haxiam-managed): off by default;
 *     HAXCMS_MAGIC_LINK_ENABLED (env) turns it on. Tenant config is ignored.
 *   HAXCMS_MAGIC_LINK_DISABLED (env) turns it off everywhere and wins.
 */
function getMagicLinkSettings(haxcms) {
  var source = {};
  if (
    haxcms &&
    haxcms.config &&
    haxcms.config.security &&
    haxcms.config.security.magicLink &&
    typeof haxcms.config.security.magicLink === "object"
  ) {
    source = haxcms.config.security.magicLink;
  }
  var enabled;
  if (isHaxiamDeployment(haxcms)) {
    // HAXiam: off by default. Most HAXiam deploys sign in through third-party
    // OAuth/SSO, so there's no local account to recover. Only the operator can
    // turn it on (env), never a tenant's config.
    enabled = isTruthyFlag(process.env.HAXCMS_MAGIC_LINK_ENABLED);
  } else {
    // single-site / self-hosted multisite: on unless config turns it off
    enabled = source.enabled !== false;
  }
  // System-level kill switch. Wins over everything, including
  // HAXCMS_MAGIC_LINK_ENABLED, so "off" is always the safe answer.
  if (isTruthyFlag(process.env.HAXCMS_MAGIC_LINK_DISABLED)) {
    enabled = false;
  }
  // on HAXiam a tenant's config doesn't shape the policy at all (lifetime
  // included); only the operator's environment does
  var policySource = isHaxiamDeployment(haxcms) ? {} : source;
  var ttlSeconds = clampInt(
    process.env.HAXCMS_MAGIC_LINK_TTL_SECONDS || policySource.ttlSeconds,
    DEFAULT_TTL_SECONDS,
    MIN_TTL_SECONDS,
    MAX_TTL_SECONDS,
  );
  var maxOutstanding = clampInt(
    policySource.maxOutstanding,
    DEFAULT_MAX_OUTSTANDING,
    1,
    20,
  );
  return {
    enabled: enabled,
    ttlSeconds: ttlSeconds,
    maxOutstanding: maxOutstanding,
  };
}

function getMagicLinksPath(haxcms) {
  var configDirectory =
    haxcms &&
    typeof haxcms.configDirectory === "string" &&
    haxcms.configDirectory
      ? haxcms.configDirectory
      : path.join(process.cwd(), "_config");
  return path.join(configDirectory, "settings", "magicLinks.json");
}

function hashVerifier(verifier) {
  return crypto
    .createHash("sha256")
    .update(String(verifier || ""), "utf8")
    .digest("hex");
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function loadLinks(haxcms) {
  var storePath = getMagicLinksPath(haxcms);
  try {
    if (!fs.existsSync(storePath)) {
      return {};
    }
    var parsed = JSON.parse(fs.readFileSync(storePath, { encoding: "utf8" }));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.links &&
      typeof parsed.links === "object"
    ) {
      return parsed.links;
    }
  } catch {
    // unreadable / corrupt store behaves as empty: every outstanding link is
    // invalid, which fails closed
  }
  return {};
}

function saveLinks(haxcms, links) {
  var storePath = getMagicLinksPath(haxcms);
  var dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  var tmpPath =
    storePath +
    "." +
    process.pid +
    "." +
    crypto.randomBytes(4).toString("hex") +
    ".tmp";
  var data = JSON.stringify({ links: links }, null, 2);
  if (process.platform === "win32") {
    fs.writeFileSync(tmpPath, data);
  } else {
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
  }
  fs.renameSync(tmpPath, storePath);
  matchSettingsOwner(storePath);
}

// Running the CLI as root (sudo) would leave a 0600 root-owned store the web
// server can't read, so every link would fail as "not found". Hand files we
// create back to whoever owns the settings directory.
function matchSettingsOwner(filePath) {
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    process.getuid() !== 0
  ) {
    return;
  }
  try {
    var owner = fs.statSync(path.dirname(filePath));
    if (owner.uid !== 0) {
      fs.chownSync(filePath, owner.uid, owner.gid);
    }
  } catch {
    // best-effort
  }
}

var LOCK_WAIT_MS = 3000;
var LOCK_STALE_MS = 10000;
var sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run fn() while holding an exclusive lock on the store. The CLI and the
 * server are separate processes writing the same file; without this, a CLI
 * mint could write back a link the server had just consumed (making it
 * usable again), or two processes could both redeem one link. The lock is a
 * create-exclusive sidecar file, released in finally; one left by a crashed
 * process is treated as stale after LOCK_STALE_MS.
 */
function withStoreLock(haxcms, fn) {
  var storePath = getMagicLinksPath(haxcms);
  var dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  var lockPath = storePath + ".lock";
  var deadline = Date.now() + LOCK_WAIT_MS;
  var fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (e) {
      if (!e || e.code !== "EEXIST") {
        throw e;
      }
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock vanished between open and stat: retry the open
        continue;
      }
      if (Date.now() > deadline) {
        var busy = new Error("The one-time link store is busy; try again.");
        busy.code = "MAGIC_LINK_STORE_BUSY";
        throw busy;
      }
      Atomics.wait(sleepCell, 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* best-effort */
    }
  }
}

function pruneLinks(links, nowSeconds) {
  var cleaned = {};
  var selectors = Object.keys(links);
  for (var i = 0; i < selectors.length; i++) {
    var record = links[selectors[i]];
    if (
      record &&
      typeof record.expiresAt === "number" &&
      record.expiresAt > nowSeconds &&
      !record.usedAt
    ) {
      cleaned[selectors[i]] = record;
    }
  }
  return cleaned;
}

function nowInSeconds(now) {
  return Math.floor((typeof now === "number" ? now : Date.now()) / 1000);
}

/**
 * Mint a one-time link for `user`. Returns { token, selector, user, expiresAt }.
 * Only the hash of the verifier is stored; the returned token is the only copy
 * of the secret, so callers must hand it to the person and not persist it.
 *
 * options:
 *   user               account name (defaults to the active HAXcms user)
 *   channel            'cli' (default) | future: 'email'
 *   ttlSeconds         override policy TTL (clamped to 60s..24h)
 *   revokeOutstanding  drop this user's earlier unused links first (default true)
 *   requestIp / requestUserAgent  audit metadata (optional)
 */
function issueMagicLink(haxcms, options) {
  return withStoreLock(haxcms, function () {
    return issueMagicLinkLocked(haxcms, options);
  });
}

function issueMagicLinkLocked(haxcms, options) {
  var opts = options || {};
  var settings = getMagicLinkSettings(haxcms);
  if (!settings.enabled) {
    var disabled = new Error(
      "One-time sign-in links are turned off for this HAXcms (off by default on HAXiam; see HAXCMS_MAGIC_LINK_ENABLED / HAXCMS_MAGIC_LINK_DISABLED / security.magicLink.enabled).",
    );
    disabled.code = "MAGIC_LINK_DISABLED";
    throw disabled;
  }
  var user =
    typeof opts.user === "string" && opts.user.trim() !== ""
      ? opts.user.trim()
      : haxcms && typeof haxcms.getActiveUserName === "function"
        ? haxcms.getActiveUserName()
        : "";
  if (
    !user ||
    !haxcms ||
    typeof haxcms.validateUser !== "function" ||
    !haxcms.validateUser(user)
  ) {
    var unknown = new Error(
      'No HAXcms account named "' +
        (user || "") +
        '" exists in this configuration.',
    );
    unknown.code = "MAGIC_LINK_UNKNOWN_USER";
    throw unknown;
  }
  var ttlSeconds =
    typeof opts.ttlSeconds !== "undefined"
      ? clampInt(
          opts.ttlSeconds,
          settings.ttlSeconds,
          MIN_TTL_SECONDS,
          MAX_TTL_SECONDS,
        )
      : settings.ttlSeconds;
  var issuedAt = nowInSeconds(opts.now);
  var links = pruneLinks(loadLinks(haxcms), issuedAt);
  // collect this user's outstanding links, oldest first
  var mine = Object.keys(links)
    .filter(function (selector) {
      return links[selector].user === user;
    })
    .sort(function (a, b) {
      return links[a].issuedAt - links[b].issuedAt;
    });
  var dropCount =
    opts.revokeOutstanding === false
      ? Math.max(0, mine.length - (settings.maxOutstanding - 1))
      : mine.length;
  for (var i = 0; i < dropCount; i++) {
    delete links[mine[i]];
  }
  var selector = randomToken(12);
  while (links[selector]) {
    selector = randomToken(12);
  }
  var verifier = randomToken(32);
  var expiresAt = issuedAt + ttlSeconds;
  links[selector] = {
    selector: selector,
    verifierHash: hashVerifier(verifier),
    user: user,
    channel:
      typeof opts.channel === "string" && opts.channel ? opts.channel : "cli",
    issuedAt: issuedAt,
    expiresAt: expiresAt,
    usedAt: null,
    requestIp: typeof opts.requestIp === "string" ? opts.requestIp : null,
    requestUserAgent:
      typeof opts.requestUserAgent === "string" ? opts.requestUserAgent : null,
  };
  saveLinks(haxcms, links);
  return {
    token: selector + "." + verifier,
    selector: selector,
    user: user,
    expiresAt: expiresAt,
    ttlSeconds: ttlSeconds,
  };
}

function parseToken(token) {
  if (typeof token !== "string") {
    return null;
  }
  var trimmed = token.trim();
  var dot = trimmed.indexOf(".");
  if (dot <= 0 || dot !== trimmed.lastIndexOf(".")) {
    return null;
  }
  var selector = trimmed.substring(0, dot);
  var verifier = trimmed.substring(dot + 1);
  if (!SELECTOR_PATTERN.test(selector) || !VERIFIER_PATTERN.test(verifier)) {
    return null;
  }
  return { selector: selector, verifier: verifier };
}

/**
 * Cheap shape check so routes can reject garbage before touching the store and
 * can safely echo a well-formed token into an HTML form.
 */
function isWellFormedToken(token) {
  return parseToken(token) !== null;
}

/**
 * The non-secret selector half of a well-formed token, or '' otherwise. Used
 * to key rate limiting per link rather than per client IP alone.
 */
function getTokenSelector(token) {
  var parsed = parseToken(token);
  return parsed ? parsed.selector : "";
}

/**
 * Redeem a link exactly once. Returns { ok: true, user } or
 * { ok: false, reason } where reason is one of
 * disabled | malformed | not_found | mismatch | expired | unknown_user.
 * Callers must surface a single generic failure to the client; `reason` is for
 * logs and tests only.
 */
function consumeMagicLink(haxcms, token, now) {
  // cheap checks first, without touching the store
  if (!getMagicLinkSettings(haxcms).enabled) {
    return { ok: false, reason: "disabled" };
  }
  if (!parseToken(token)) {
    return { ok: false, reason: "malformed" };
  }
  return withStoreLock(haxcms, function () {
    return consumeMagicLinkLocked(haxcms, token, now);
  });
}

function consumeMagicLinkLocked(haxcms, token, now) {
  var settings = getMagicLinkSettings(haxcms);
  if (!settings.enabled) {
    return { ok: false, reason: "disabled" };
  }
  var parsed = parseToken(token);
  if (!parsed) {
    return { ok: false, reason: "malformed" };
  }
  var nowSeconds = nowInSeconds(now);
  var raw = loadLinks(haxcms);
  var record = Object.prototype.hasOwnProperty.call(raw, parsed.selector)
    ? raw[parsed.selector]
    : null;
  if (!record || typeof record.verifierHash !== "string") {
    return { ok: false, reason: "not_found" };
  }
  var expected = Buffer.from(record.verifierHash, "hex");
  var submitted = Buffer.from(hashVerifier(parsed.verifier), "hex");
  if (
    expected.length !== submitted.length ||
    !crypto.timingSafeEqual(expected, submitted)
  ) {
    return { ok: false, reason: "mismatch" };
  }
  // the verifier matched, so this link is spent whatever happens next
  var links = pruneLinks(raw, nowSeconds);
  delete links[parsed.selector];
  saveLinks(haxcms, links);
  if (
    record.usedAt ||
    typeof record.expiresAt !== "number" ||
    record.expiresAt <= nowSeconds
  ) {
    return { ok: false, reason: "expired" };
  }
  if (
    typeof haxcms.validateUser !== "function" ||
    !haxcms.validateUser(record.user)
  ) {
    return { ok: false, reason: "unknown_user" };
  }
  return { ok: true, user: record.user, channel: record.channel };
}

/**
 * Drop every outstanding link (optionally only for one user). Returns the
 * number removed.
 */
function revokeMagicLinks(haxcms, user) {
  return withStoreLock(haxcms, function () {
    return revokeMagicLinksLocked(haxcms, user);
  });
}

function revokeMagicLinksLocked(haxcms, user) {
  var nowSeconds = nowInSeconds();
  var links = pruneLinks(loadLinks(haxcms), nowSeconds);
  var removed = 0;
  var selectors = Object.keys(links);
  for (var i = 0; i < selectors.length; i++) {
    if (!user || links[selectors[i]].user === user) {
      delete links[selectors[i]];
      removed++;
    }
  }
  saveLinks(haxcms, links);
  return removed;
}

function isMagicLinkEnabled(haxcms) {
  return getMagicLinkSettings(haxcms).enabled;
}

module.exports = {
  DEFAULT_TTL_SECONDS: DEFAULT_TTL_SECONDS,
  isMagicLinkEnabled: isMagicLinkEnabled,
  isHaxiamDeployment: isHaxiamDeployment,
  getMagicLinkSettings: getMagicLinkSettings,
  getMagicLinksPath: getMagicLinksPath,
  issueMagicLink: issueMagicLink,
  consumeMagicLink: consumeMagicLink,
  revokeMagicLinks: revokeMagicLinks,
  isWellFormedToken: isWellFormedToken,
  getTokenSelector: getTokenSelector,
};
