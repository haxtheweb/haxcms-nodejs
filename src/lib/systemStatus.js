const fs = require('fs-extra');
const path = require('path');
const expressPackage = require('express/package.json');
const childProcess = require('child_process');
const v8 = require('v8');

const GITHUB_RELEASES_LATEST_URL =
  'https://api.github.com/repos/haxtheweb/haxcms-nodejs/releases/latest';
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000;
const RELEASES_PAGE_URL = 'https://github.com/haxtheweb/haxcms-nodejs/releases';
const DISCORD_SUPPORT_URL = 'https://discord.gg/qGBZMBnHc';
const UPLOAD_LIMIT_HELP_URL =
  'https://expressjs.com/en/resources/middleware/body-parser.html';

let latestReleaseCache = {
  expiresAt: 0,
  version: '',
};

function normalizeVersion(value = '') {
  let normalized = typeof value === 'string' ? value : `${value || ''}`;
  normalized = normalized.trim();
  if (normalized.toLowerCase().indexOf('v') === 0) {
    normalized = normalized.substring(1);
  }
  return normalized;
}

function getRuntimeVersionLabel() {
  const nodeVersion = process.versions && process.versions.node
    ? `${process.versions.node}`
    : '';
  if (nodeVersion) {
    const parts = nodeVersion.split('.');
    if (parts.length >= 2) {
      return `node${parts[0]}.${parts[1]}`;
    }
    return `node${nodeVersion}`;
  }
  return 'node';
}

function getServerVersionLabel(req) {
  const protocol = req && req.protocol === 'https' ? 'https' : 'http';
  const expressVersion =
    expressPackage && expressPackage.version
      ? `${expressPackage.version}`
      : '';
  if (expressVersion) {
    return `${protocol}-express/${expressVersion}`;
  }
  return `${protocol}-express`;
}

function getProcessOwnership() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  return {
    uid,
    gid,
  };
}
function formatBytes(value = 0) {
  const bytes = Number(value);
  if (!bytes || bytes < 0) {
    return 'Unknown';
  }
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  if (bytes >= gib) {
    return `${(bytes / gib).toFixed(2)} GiB`;
  }
  return `${(bytes / mib).toFixed(0)} MiB`;
}

function getNodeMemoryLimitLabel() {
  try {
    const heapStats = v8.getHeapStatistics();
    if (
      heapStats &&
      typeof heapStats.heap_size_limit === 'number' &&
      heapStats.heap_size_limit > 0
    ) {
      return formatBytes(heapStats.heap_size_limit);
    }
  }
  catch (e) {}
  return 'Unknown';
}

function getNodeUploadLimitLabel() {
  if (
    typeof process.env.HAXCMS_UPLOAD_LIMIT === 'string' &&
    process.env.HAXCMS_UPLOAD_LIMIT.trim() !== ''
  ) {
    return process.env.HAXCMS_UPLOAD_LIMIT.trim();
  }
  return '50mb';
}

function detectGitVersion() {
  try {
    const command = childProcess.spawnSync('git', ['--version'], {
      encoding: 'utf8',
    });
    if (command && command.status === 0) {
      if (typeof command.stdout === 'string' && command.stdout.trim() !== '') {
        return command.stdout.trim();
      }
      if (typeof command.stderr === 'string' && command.stderr.trim() !== '') {
        return command.stderr.trim();
      }
      return 'git installed';
    }
  }
  catch (e) {}
  return '';
}

function buildDirectoryStatusRow(directory = {}, processOwnership = {}) {
  const key = directory.key || 'directory';
  const title = directory.title || 'Directory';
  const required = directory.required !== false;
  const directoryPath = typeof directory.path === 'string' ? directory.path : '';
  if (!directoryPath) {
    return {
      key,
      tone: required ? 'error' : 'warning',
      title,
      value: 'Unavailable',
      description: 'Directory path could not be determined.',
      required,
    };
  }
  let exists = false;
  try {
    exists = fs.pathExistsSync(directoryPath);
  }
  catch (e) {
    exists = false;
  }
  if (!exists) {
    return {
      key,
      tone: required ? 'error' : 'warning',
      title,
      value: 'Missing',
      description: `Expected path: ${directoryPath}`,
      required,
    };
  }
  let stats = null;
  try {
    stats = fs.statSync(directoryPath);
  }
  catch (e) {
    stats = null;
  }
  if (!stats || !stats.isDirectory()) {
    return {
      key,
      tone: required ? 'error' : 'warning',
      title,
      value: 'Invalid',
      description: `Path exists but is not a directory: ${directoryPath}`,
      required,
    };
  }
  let writable = false;
  try {
    fs.accessSync(directoryPath, fs.constants.W_OK);
    writable = true;
  }
  catch (e) {
    writable = false;
  }
  const ownershipComparable =
    typeof processOwnership.uid === 'number' &&
    typeof processOwnership.gid === 'number';
  const ownerMatchesProcess = ownershipComparable
    ? stats.uid === processOwnership.uid && stats.gid === processOwnership.gid
    : true;
  let tone = 'ok';
  let value = 'Writable';
  if (!writable) {
    tone = required ? 'error' : 'warning';
    value = 'Read-only';
  }
  else if (!ownerMatchesProcess) {
    tone = 'warning';
    value = 'Writable (owner mismatch)';
  }
  return {
    key,
    tone,
    title,
    value,
    description: `Path: ${directoryPath}`,
    required,
  };
}

async function fetchLatestReleaseVersion() {
  const now = Date.now();
  if (latestReleaseCache.version && latestReleaseCache.expiresAt > now) {
    return latestReleaseCache.version;
  }
  let latestVersion = '';
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, 4000);
  try {
    const response = await fetch(GITHUB_RELEASES_LATEST_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'haxcms-nodejs-system-status',
      },
      signal: controller.signal,
    });
    if (response.ok) {
      const payload = await response.json();
      if (payload && typeof payload.tag_name === 'string') {
        latestVersion = normalizeVersion(payload.tag_name);
      }
    }
  }
  catch (e) {
    latestVersion = '';
  }
  clearTimeout(timeoutHandle);
  if (latestVersion) {
    latestReleaseCache = {
      version: latestVersion,
      expiresAt: now + RELEASE_CACHE_TTL_MS,
    };
  }
  return latestVersion;
}

function buildStatusRows(options = {}) {
  const rows = [];
  rows.push({
    key: 'runtime',
    tone: 'info',
    title: 'Programming language runtime',
    value: options.programmingLanguage || 'node',
    description: 'Detected runtime used by the active backend process.',
  });
  rows.push({
    key: 'server',
    tone: 'info',
    title: 'Server version',
    value: options.serverVersion || 'node-express',
    description: 'Detected web server stack serving this request.',
  });
  if (typeof options.configDirectory === 'string' && options.configDirectory !== '') {
    rows.push({
      key: 'config-directory-path',
      tone: 'info',
      title: 'Detected config directory',
      value: options.configDirectory,
      description: 'Resolved runtime configuration directory path.',
    });
  }
  rows.push({
    key: 'node-memory-limit',
    tone: 'info',
    title: 'Node.js memory limit',
    value: options.memoryLimit || 'Unknown',
    description: 'V8 heap size limit available to the Node.js process.',
  });
  rows.push({
    key: 'file-upload-limit',
    tone: 'info',
    title: 'File upload limit',
    value: options.uploadLimit || 'Unknown',
    description: `Increase upload limit via server/application settings: ${options.uploadLimitHelpUrl || UPLOAD_LIMIT_HELP_URL}`,
  });
  const gitVersion = typeof options.gitVersion === 'string' ? options.gitVersion : '';
  const gitInstalled = gitVersion !== '';
  rows.push({
    key: 'git-installed',
    tone: gitInstalled ? 'ok' : 'warning',
    title: 'Git availability',
    value: gitInstalled ? 'Installed' : 'Not detected',
    description: gitInstalled
      ? `Detected: ${gitVersion}`
      : 'Git is not detected on PATH.',
  });
  const processOwnership = getProcessOwnership();
  const directoryRows = [];
  let directoryErrors = 0;
  const directories = Array.isArray(options.directories) ? options.directories : [];
  for (let i = 0; i < directories.length; i++) {
    const row = buildDirectoryStatusRow(directories[i], processOwnership);
    if (row.required && row.tone === 'error') {
      directoryErrors++;
    }
    delete row.required;
    directoryRows.push(row);
  }
  rows.push({
    key: 'installation-state',
    tone: directoryErrors === 0 ? 'ok' : 'error',
    title: 'Installation directories',
    value: directoryErrors === 0 ? 'Installed' : 'Incomplete',
    description:
      'Checks required runtime directories for existence, writability, and ownership alignment.',
  });
  for (let i = 0; i < directoryRows.length; i++) {
    rows.push(directoryRows[i]);
  }
  rows.push({
    key: 'security-secrets',
    tone: options.securitySecretsLoaded ? 'ok' : 'error',
    title: 'Security secrets',
    value: options.securitySecretsLoaded ? 'Loaded' : 'Missing',
    description:
      'Checks SALT, private key, and refresh key loading in runtime configuration.',
  });
  rows.push({
    key: 'jwt-security',
    tone: options.jwtChecksEnabled ? 'ok' : 'warning',
    title: 'JWT security checks',
    value: options.jwtChecksEnabled ? 'Enabled' : 'Disabled',
    description: options.jwtChecksEnabled
      ? 'JWT validation is required for authenticated API routes.'
      : 'JWT validation is disabled for local development mode.',
  });
  const currentVersion = options.haxcmsVersionCurrent || 'unknown';
  const latestVersion = options.haxcmsVersionLatest || 'unknown';
  const releasePageUrl = options.releasePageUrl || RELEASES_PAGE_URL;
  let versionDescription = `Current: ${currentVersion} · Latest: ${latestVersion}`;
  if (
    currentVersion !== 'unknown' &&
    latestVersion !== 'unknown' &&
    currentVersion !== latestVersion
  ) {
    versionDescription += ` · Update: ${releasePageUrl}`;
  }
  rows.push({
    key: 'haxcms-version',
    tone:
      currentVersion !== 'unknown' &&
      latestVersion !== 'unknown' &&
      currentVersion === latestVersion
        ? 'ok'
        : 'warning',
    title: 'HAXcms version',
    value: currentVersion,
    description: versionDescription,
  });
  rows.push({
    key: 'community-support',
    tone: 'info',
    title: 'Community support',
    value: 'Discord',
    description: `Join community support: ${options.supportUrl || DISCORD_SUPPORT_URL}`,
  });
  return rows;
}

async function buildNodeSystemStatusReport(haxcms, req) {
  const currentVersion = haxcms && typeof haxcms.getHAXCMSVersion === 'function'
    ? normalizeVersion(await haxcms.getHAXCMSVersion())
    : '';
  const latestVersion = normalizeVersion(await fetchLatestReleaseVersion()) || currentVersion || 'unknown';
  const rootPath =
    haxcms && typeof haxcms.HAXCMS_ROOT === 'string'
      ? haxcms.HAXCMS_ROOT
      : process.cwd();
  const configDirectory =
    haxcms && typeof haxcms.configDirectory === 'string'
      ? haxcms.configDirectory
      : path.join(rootPath, '_config');
  const sitesDirectoryName =
    haxcms && typeof haxcms.sitesDirectory === 'string'
      ? haxcms.sitesDirectory
      : '_sites';
  const publishedDirectoryName =
    haxcms && typeof haxcms.publishedDirectory === 'string'
      ? haxcms.publishedDirectory
      : '_published';
  const archivedDirectoryName =
    haxcms && typeof haxcms.archivedDirectory === 'string'
      ? haxcms.archivedDirectory
      : '_archived';
  const directories = [
    {
      key: 'config-directory',
      title: 'Configuration directory',
      path: configDirectory,
      required: true,
    },
    {
      key: 'sites-directory',
      title: 'Sites directory',
      path: path.join(rootPath, sitesDirectoryName),
      required: true,
    },
    {
      key: 'published-directory',
      title: 'Published directory',
      path: path.join(rootPath, publishedDirectoryName),
      required: true,
    },
    {
      key: 'archived-directory',
      title: 'Archived directory',
      path: path.join(rootPath, archivedDirectoryName),
      required: true,
    },
    {
      key: 'user-files-directory',
      title: 'User files directory',
      path: path.join(configDirectory, 'user', 'files'),
      required: true,
    },
  ];
  const rows = buildStatusRows({
    programmingLanguage: getRuntimeVersionLabel(),
    serverVersion: getServerVersionLabel(req),
    haxcmsVersionCurrent: currentVersion || 'unknown',
    haxcmsVersionLatest: latestVersion,
    configDirectory,
    memoryLimit: getNodeMemoryLimitLabel(),
    uploadLimit: getNodeUploadLimitLabel(),
    uploadLimitHelpUrl: UPLOAD_LIMIT_HELP_URL,
    gitVersion: detectGitVersion(),
    releasePageUrl: RELEASES_PAGE_URL,
    supportUrl: DISCORD_SUPPORT_URL,
    directories,
    securitySecretsLoaded: !!(
      haxcms &&
      haxcms.salt &&
      haxcms.privateKey &&
      haxcms.refreshPrivateKey
    ),
    jwtChecksEnabled: !(haxcms && haxcms.HAXCMS_DISABLE_JWT_CHECKS),
  });
  return {
    summary: {
      programmingLanguage: getRuntimeVersionLabel(),
      serverVersion: getServerVersionLabel(req),
      haxcmsVersionCurrent: currentVersion || 'unknown',
      haxcmsVersionLatest: latestVersion,
      configDirectory,
    },
    rows,
  };
}

module.exports = {
  buildNodeSystemStatusReport,
  fetchLatestReleaseVersion,
};
