const fs = require("fs-extra");
const path = require("path");

function normalizeBoolean(value, defaultValue = true) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "off" ||
      normalized === "no" ||
      normalized === "disabled"
    ) {
      return false;
    }
    if (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "on" ||
      normalized === "yes" ||
      normalized === "enabled"
    ) {
      return true;
    }
  }
  return defaultValue;
}

function normalizeMachineName(haxcms, value = "") {
  if (!haxcms || typeof haxcms.generateMachineName !== "function") {
    return "";
  }
  const normalized = haxcms.generateMachineName(value);
  return typeof normalized === "string" ? normalized : "";
}

function normalizeMachineNameList(haxcms, input = []) {
  const source = Array.isArray(input) ? input : [];
  const list = [];
  const seen = new Set();
  for (let i = 0; i < source.length; i++) {
    const machineName = normalizeMachineName(haxcms, `${source[i] || ""}`);
    if (!machineName || seen.has(machineName)) {
      continue;
    }
    seen.add(machineName);
    list.push(machineName);
  }
  return list;
}

function getSkeletonDirectories(haxcms) {
  return [
    {
      scope: "user",
      dir: path.join(haxcms.configDirectory, "user", "skeletons"),
    },
    {
      scope: "config",
      dir: path.join(haxcms.configDirectory, "skeletons"),
    },
    {
      scope: "core",
      dir: path.join(haxcms.coreConfigPath, "skeletons"),
    },
  ];
}

function getEnabledSkeletonsFilePath(haxcms) {
  const configDirectory =
    haxcms &&
    typeof haxcms.configDirectory === "string" &&
    haxcms.configDirectory
      ? haxcms.configDirectory
      : path.join(process.cwd(), "_config");
  return path.join(configDirectory, "settings", "enabledSkeletons.json");
}

function normalizeEnabledSkeletonMap(haxcms, input = {}) {
  let source = input;
  if (
    source &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    Object.prototype.hasOwnProperty.call(source, "enabledSkeletons")
  ) {
    source = source.enabledSkeletons;
  }
  const normalized = {};
  if (Array.isArray(source)) {
    const names = normalizeMachineNameList(haxcms, source);
    for (let i = 0; i < names.length; i++) {
      normalized[names[i]] = true;
    }
    return normalized;
  }
  if (!source || typeof source !== "object") {
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

function isSkeletonEnabled(haxcms, machineName = "", enabledSkeletons = {}) {
  const normalizedMachineName = normalizeMachineName(haxcms, machineName);
  if (!normalizedMachineName) {
    return true;
  }
  const map = normalizeEnabledSkeletonMap(haxcms, enabledSkeletons);
  if (!Object.prototype.hasOwnProperty.call(map, normalizedMachineName)) {
    return true;
  }
  return map[normalizedMachineName] !== false;
}

function applyDetectedSkeletonDefaults(
  haxcms,
  enabledSkeletons = {},
  detectedNames = [],
) {
  const map = normalizeEnabledSkeletonMap(haxcms, enabledSkeletons);
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
    enabledSkeletons: map,
    changed,
  };
}

async function readEnabledSkeletonMap(haxcms) {
  const filePath = getEnabledSkeletonsFilePath(haxcms);
  if (!(await fs.pathExists(filePath))) {
    return {};
  }
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw || raw.trim() === "") {
      return {};
    }
    return normalizeEnabledSkeletonMap(haxcms, JSON.parse(raw));
  } catch {
    return {};
  }
}

async function writeEnabledSkeletonMap(haxcms, enabledSkeletons = {}) {
  const filePath = getEnabledSkeletonsFilePath(haxcms);
  const normalized = normalizeEnabledSkeletonMap(haxcms, enabledSkeletons);
  const keys = Object.keys(normalized).sort();
  const sorted = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    sorted[key] = normalized[key] !== false;
  }
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ enabledSkeletons: sorted }, null, 2)}\n`,
    "utf8",
  );
  return sorted;
}

// Listing skeletons fills newly detected skeletons into the enabled map and
// saves it. That save is housekeeping: when the settings folder cannot be
// written (full disk, read-only or wrongly owned config folder), the list is
// still answered from the map in memory and the failure is logged, never a
// 500. The saveEnabledSkeletons route still reports a failed write.
async function persistDetectedSkeletonDefaults(haxcms, enabledSkeletons = {}) {
  try {
    await writeEnabledSkeletonMap(haxcms, enabledSkeletons);
    return true;
  } catch (e) {
    console.warn(
      "HAXcms: could not save " +
        getEnabledSkeletonsFilePath(haxcms) +
        " (" +
        (e && e.code ? e.code : "write failed") +
        "); listing skeletons from memory",
    );
    return false;
  }
}

async function discoverSkeletons(haxcms) {
  const items = [];
  const seen = new Set();
  const dirs = getSkeletonDirectories(haxcms);
  for (let i = 0; i < dirs.length; i++) {
    const entry = dirs[i];
    if (!(await fs.pathExists(entry.dir))) {
      continue;
    }
    let files = [];
    try {
      files = await fs.readdir(entry.dir);
    } catch {
      continue;
    }
    for (let j = 0; j < files.length; j++) {
      const file = files[j];
      if (file === "." || file === "..") {
        continue;
      }
      const filePath = path.join(entry.dir, file);
      let stats = null;
      try {
        stats = await fs.stat(filePath);
      } catch {
        continue;
      }
      if (
        !stats ||
        !stats.isFile() ||
        path.extname(file).toLowerCase() !== ".json"
      ) {
        continue;
      }
      const skeletonName = normalizeMachineName(
        haxcms,
        path.basename(file, ".json"),
      );
      if (!skeletonName || skeletonName === "default-starter") {
        continue;
      }
      if (seen.has(skeletonName)) {
        continue;
      }
      let skeleton = null;
      try {
        const json = await fs.readFile(filePath, "utf8");
        skeleton = JSON.parse(json);
      } catch {
        continue;
      }
      if (
        !skeleton ||
        typeof skeleton !== "object" ||
        Array.isArray(skeleton)
      ) {
        continue;
      }
      const meta =
        skeleton.meta &&
        typeof skeleton.meta === "object" &&
        !Array.isArray(skeleton.meta)
          ? skeleton.meta
          : {};
      const title = meta.useCaseTitle || meta.name || skeletonName;
      const description = meta.useCaseDescription || meta.description || "";
      const image = meta.useCaseImage || "";
      let priority = 0;
      if (typeof meta.priority !== "undefined") {
        const parsedPriority = Number(meta.priority);
        if (Number.isFinite(parsedPriority)) {
          priority = parsedPriority;
        }
      }
      let category = [];
      if (Array.isArray(meta.category)) {
        category = meta.category;
      } else if (Array.isArray(meta.tags)) {
        category = meta.tags;
      }
      const attributes = Array.isArray(meta.attributes) ? meta.attributes : [];
      const demo = meta.sourceUrl || "#";
      const skeletonUrl = `${haxcms.basePath}${haxcms.systemRequestBase}v1/skeletons/${encodeURIComponent(skeletonName)}`;
      items.push({
        title,
        description,
        image,
        priority,
        category,
        attributes,
        scope: entry.scope,
        machineName: skeletonName,
        "machine-name": skeletonName,
        "demo-url": demo,
        "skeleton-url": skeletonUrl,
      });
      seen.add(skeletonName);
    }
  }
  return items;
}

/**
 * The pages of the default-starter skeleton: the first page a site gets when
 * it is created without a build. Looked up in the same order as every other
 * skeleton (user, then config, then core), so a deployment can replace it.
 * Returns null when no readable default-starter has any pages.
 */
function readDefaultStarterItems(haxcms) {
  const dirs = getSkeletonDirectories(haxcms);
  for (let i = 0; i < dirs.length; i++) {
    const filePath = path.join(dirs[i].dir, "default-starter.json");
    let skeleton = null;
    try {
      if (!fs.pathExistsSync(filePath)) {
        continue;
      }
      skeleton = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (
      skeleton &&
      skeleton.build &&
      Array.isArray(skeleton.build.items) &&
      skeleton.build.items.length > 0
    ) {
      return skeleton.build.items;
    }
  }
  return null;
}

module.exports = {
  normalizeBoolean,
  readDefaultStarterItems,
  normalizeMachineNameList,
  normalizeEnabledSkeletonMap,
  applyDetectedSkeletonDefaults,
  isSkeletonEnabled,
  getEnabledSkeletonsFilePath,
  readEnabledSkeletonMap,
  writeEnabledSkeletonMap,
  persistDetectedSkeletonDefaults,
  discoverSkeletons,
};
