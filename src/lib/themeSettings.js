const fs = require('fs-extra');
const path = require('path');

function normalizeBoolean(value, defaultValue = true) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'off' ||
      normalized === 'no' ||
      normalized === 'disabled'
    ) {
      return false;
    }
    if (
      normalized === 'true' ||
      normalized === '1' ||
      normalized === 'on' ||
      normalized === 'yes' ||
      normalized === 'enabled'
    ) {
      return true;
    }
  }
  return defaultValue;
}

function normalizeMachineName(haxcms, value = '') {
  if (!haxcms || typeof haxcms.generateMachineName !== 'function') {
    return '';
  }
  const normalized = haxcms.generateMachineName(value);
  return typeof normalized === 'string' ? normalized : '';
}

function normalizeMachineNameList(haxcms, input = []) {
  const source = Array.isArray(input) ? input : [];
  const list = [];
  const seen = new Set();
  for (let i = 0; i < source.length; i++) {
    const machineName = normalizeMachineName(haxcms, `${source[i] || ''}`);
    if (!machineName || seen.has(machineName)) {
      continue;
    }
    seen.add(machineName);
    list.push(machineName);
  }
  return list;
}

function getEnabledThemesFilePath(haxcms) {
  const configDirectory = (
    haxcms &&
    typeof haxcms.configDirectory === 'string' &&
    haxcms.configDirectory
  ) ? haxcms.configDirectory : path.join(process.cwd(), '_config');
  return path.join(configDirectory, 'settings', 'enabledThemes.json');
}

function normalizeEnabledThemeMap(haxcms, input = {}) {
  let source = input;
  if (
    source &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    Object.prototype.hasOwnProperty.call(source, 'enabledThemes')
  ) {
    source = source.enabledThemes;
  }
  const normalized = {};
  if (Array.isArray(source)) {
    const names = normalizeMachineNameList(haxcms, source);
    for (let i = 0; i < names.length; i++) {
      normalized[names[i]] = true;
    }
    return normalized;
  }
  if (!source || typeof source !== 'object') {
    return normalized;
  }
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const machineName = normalizeMachineName(haxcms, keys[i]);
    if (!machineName) {
      continue;
    }
    normalized[machineName] = normalizeBoolean(source[keys[i]], true);
  }
  return normalized;
}

function isThemeEnabled(haxcms, machineName = '', enabledThemes = {}) {
  const normalizedMachineName = normalizeMachineName(haxcms, machineName);
  if (!normalizedMachineName) {
    return true;
  }
  const map = normalizeEnabledThemeMap(haxcms, enabledThemes);
  if (!Object.prototype.hasOwnProperty.call(map, normalizedMachineName)) {
    return true;
  }
  return map[normalizedMachineName] !== false;
}

function applyDetectedThemeDefaults(
  haxcms,
  enabledThemes = {},
  detectedNames = [],
) {
  const map = normalizeEnabledThemeMap(haxcms, enabledThemes);
  const names = normalizeMachineNameList(haxcms, detectedNames);
  let changed = false;
  for (let i = 0; i < names.length; i++) {
    const machineName = names[i];
    if (!Object.prototype.hasOwnProperty.call(map, machineName)) {
      map[machineName] = true;
      changed = true;
    }
  }
  return {
    enabledThemes: map,
    changed,
  };
}

async function readEnabledThemeMap(haxcms) {
  const filePath = getEnabledThemesFilePath(haxcms);
  if (!(await fs.pathExists(filePath))) {
    return {};
  }
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw || raw.trim() === '') {
      return {};
    }
    return normalizeEnabledThemeMap(haxcms, JSON.parse(raw));
  }
  catch (e) {
    return {};
  }
}

async function writeEnabledThemeMap(haxcms, enabledThemes = {}) {
  const filePath = getEnabledThemesFilePath(haxcms);
  const normalized = normalizeEnabledThemeMap(haxcms, enabledThemes);
  const keys = Object.keys(normalized).sort();
  const sorted = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    sorted[key] = normalized[key] !== false;
  }
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ enabledThemes: sorted }, null, 2)}\n`,
    'utf8',
  );
  return sorted;
}

function normalizeThemeCategory(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return [value.trim()];
  }
  return [];
}

function normalizeThemePriority(value) {
  const priority = Number(value);
  return Number.isFinite(priority) ? priority : 0;
}
function readThemeValue(theme = {}, key = '') {
  if (!theme || typeof theme !== 'object') {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(theme, key)) {
    return theme[key];
  }
  return undefined;
}

function readThemeMachineName(theme = {}) {
  const candidates = [
    readThemeValue(theme, 'machineName'),
    readThemeValue(theme, 'machine-name'),
    readThemeValue(theme, 'element'),
    readThemeValue(theme, 'name'),
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (
      typeof candidates[i] === 'string' &&
      candidates[i].trim() !== ''
    ) {
      return candidates[i].trim();
    }
  }
  return '';
}

function isThemeHidden(theme = {}) {
  return normalizeBoolean(readThemeValue(theme, 'hidden'), false);
}

function isThemeTerrible(theme = {}) {
  const machineName = readThemeMachineName(theme).toLowerCase();
  return (
    normalizeBoolean(readThemeValue(theme, 'terrible'), false) ||
    machineName.indexOf('terrible') === 0
  );
}

function getThemeScreenshot(theme = {}) {
  const candidates = [
    readThemeValue(theme, 'screenshot'),
    readThemeValue(theme, 'thumbnail'),
    readThemeValue(theme, 'preview'),
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (
      typeof candidates[i] === 'string' &&
      candidates[i].trim() !== ''
    ) {
      return candidates[i].trim();
    }
  }
  return '';
}

function normalizeThemeRecord(machineName = '', theme = {}, scope = 'registry') {
  const source = (
    theme &&
    typeof theme === 'object' &&
    !Array.isArray(theme)
  ) ? JSON.parse(JSON.stringify(theme)) : {};
  const normalized = {
    ...source,
    machineName,
    'machine-name': machineName,
    scope,
  };
  normalized.element = (
    typeof normalized.element === 'string' &&
    normalized.element.trim() !== ''
  ) ? normalized.element.trim() : machineName;
  normalized.path = (
    typeof normalized.path === 'string'
  ) ? normalized.path : '';
  normalized.name = (
    typeof normalized.name === 'string' &&
    normalized.name.trim() !== ''
  ) ? normalized.name.trim() : machineName;
  normalized.description = (
    typeof normalized.description === 'string'
  ) ? normalized.description : '';
  normalized.thumbnail = (
    typeof normalized.thumbnail === 'string'
  ) ? normalized.thumbnail : '';
  normalized.screenshot = getThemeScreenshot(normalized);
  normalized.category = normalizeThemeCategory(normalized.category);
  normalized.hidden = isThemeHidden(source);
  normalized.terrible = isThemeTerrible({
    ...source,
    machineName,
  });
  normalized.priority = normalizeThemePriority(source.priority);
  return normalized;
}

function getThemePathCandidates(haxcms, themePath = '') {
  const relativePath = `${themePath || ''}`
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!relativePath) {
    return [];
  }
  const candidates = [];
  const addCandidate = (candidate) => {
    if (!candidate || candidates.indexOf(candidate) !== -1) {
      return;
    }
    candidates.push(candidate);
  };
  const root = (
    haxcms &&
    typeof haxcms.HAXCMS_ROOT === 'string' &&
    haxcms.HAXCMS_ROOT
  ) ? haxcms.HAXCMS_ROOT : process.cwd();
  addCandidate(path.join(root, relativePath));
  addCandidate(path.join(root, 'build', 'es6', 'node_modules', relativePath));
  addCandidate(path.join(root, 'public', 'build', 'es6', 'node_modules', relativePath));
  addCandidate(path.join(root, 'src', 'public', 'build', 'es6', 'node_modules', relativePath));
  addCandidate(path.join(root, 'node_modules', relativePath));
  if (
    haxcms &&
    typeof haxcms.coreConfigPath === 'string' &&
    haxcms.coreConfigPath
  ) {
    const srcRoot = path.resolve(haxcms.coreConfigPath, '..');
    addCandidate(path.join(srcRoot, 'public', 'build', 'es6', 'node_modules', relativePath));
    addCandidate(path.join(srcRoot, '..', 'node_modules', relativePath));
  }
  return candidates;
}

async function isThemeDetectedOnFileSystem(haxcms, theme = {}) {
  const themePath = (
    theme &&
    typeof theme.path === 'string' &&
    theme.path.trim() !== ''
  ) ? theme.path.trim() : '';
  if (!themePath) {
    return true;
  }
  const candidates = getThemePathCandidates(haxcms, themePath);
  for (let i = 0; i < candidates.length; i++) {
    if (await fs.pathExists(candidates[i])) {
      return true;
    }
  }
  return false;
}

async function discoverThemes(haxcms) {
  let sourceThemes = {};
  if (haxcms && typeof haxcms.getThemes === 'function') {
    const themes = haxcms.getThemes();
    if (themes && typeof themes === 'object' && !Array.isArray(themes)) {
      sourceThemes = themes;
    }
  }
  const keys = Object.keys(sourceThemes);
  const themes = [];
  const seen = new Set();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const theme = sourceThemes[key];
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
      continue;
    }
    const machineName = normalizeMachineName(
      haxcms,
      key || theme.machineName || theme.element || theme.name || '',
    );
    if (!machineName || seen.has(machineName)) {
      continue;
    }
    const detected = await isThemeDetectedOnFileSystem(haxcms, theme);
    if (!detected) {
      continue;
    }
    themes.push(normalizeThemeRecord(machineName, theme, 'registry'));
    seen.add(machineName);
  }
  if (themes.length > 0) {
    return themes;
  }
  // fallback: if path detection cannot resolve in this environment, return registry themes
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const theme = sourceThemes[key];
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
      continue;
    }
    const machineName = normalizeMachineName(
      haxcms,
      key || theme.machineName || theme.element || theme.name || '',
    );
    if (!machineName || seen.has(machineName)) {
      continue;
    }
    themes.push(normalizeThemeRecord(machineName, theme, 'registry'));
    seen.add(machineName);
  }
  return themes;
}

function themesToMap(themes = []) {
  const source = Array.isArray(themes) ? [...themes] : [];
  source.sort((a, b) => {
    const aName = a && a.machineName ? `${a.machineName}` : '';
    const bName = b && b.machineName ? `${b.machineName}` : '';
    if (aName === bName) {
      return 0;
    }
    return aName < bName ? -1 : 1;
  });
  const map = {};
  for (let i = 0; i < source.length; i++) {
    const theme = source[i];
    if (!theme || !theme.machineName) {
      continue;
    }
    map[theme.machineName] = { ...theme };
  }
  return map;
}

module.exports = {
  normalizeBoolean,
  normalizeMachineNameList,
  normalizeEnabledThemeMap,
  applyDetectedThemeDefaults,
  isThemeEnabled,
  getEnabledThemesFilePath,
  readEnabledThemeMap,
  writeEnabledThemeMap,
  discoverThemes,
  themesToMap,
  isThemeHidden,
  isThemeTerrible,
  getThemeScreenshot,
};
