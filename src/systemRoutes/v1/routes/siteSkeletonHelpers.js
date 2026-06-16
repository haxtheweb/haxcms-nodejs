const fs = require('fs-extra');
const path = require('path');
const { HAXCMS } = require('../../../lib/HAXCMS.js');

function isObjectLike(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value, fallback = null) {
  if (typeof value === 'undefined' || value === null) {
    return fallback;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  }
  catch (e) {
    return fallback;
  }
}

function normalizeMachineName(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return 'site-template';
  }
  let value = HAXCMS.generateMachineName(rawValue);
  if (!value || typeof value !== 'string') {
    return 'site-template';
  }
  value = value.replace(/\.json$/i, '').trim().toLowerCase();
  if (value === '') {
    return 'site-template';
  }
  return value;
}

function normalizeArrayValue(value) {
  if (Array.isArray(value)) {
    return cloneJson(value, []);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return [value.trim()];
  }
  return [];
}

function sanitizeItemLocation(location) {
  if (!location || typeof location !== 'string') {
    return '';
  }
  const normalized = location.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (
    normalized === '' ||
    normalized.indexOf('\0') !== -1 ||
    normalized.indexOf('..') !== -1
  ) {
    return '';
  }
  return normalized;
}

async function readItemContent(siteDirectory, item) {
  if (!item || typeof item !== 'object') {
    return '';
  }
  const safeLocation = sanitizeItemLocation(item.location);
  if (!safeLocation) {
    return '';
  }
  const targetPath = path.join(siteDirectory, safeLocation);
  try {
    if (!await fs.pathExists(targetPath)) {
      return '';
    }
    const stats = await fs.stat(targetPath);
    if (!stats.isFile()) {
      return '';
    }
    return await fs.readFile(targetPath, 'utf8');
  }
  catch (e) {
    return '';
  }
}

function normalizeItemMetadata(metadata) {
  const source = isObjectLike(metadata) ? cloneJson(metadata, {}) : {};
  if (!Array.isArray(source.tags)) {
    source.tags = [];
  }
  if (typeof source.published === 'undefined') {
    source.published = true;
  }
  if (typeof source.hideInMenu === 'undefined') {
    source.hideInMenu = false;
  }
  return source;
}

function resolveThemeData(manifestMetadata = {}) {
  const themeMetadata = isObjectLike(manifestMetadata.theme)
    ? cloneJson(manifestMetadata.theme, {})
    : {};
  const themeElement =
    typeof themeMetadata.element === 'string' && themeMetadata.element !== ''
      ? themeMetadata.element
      : HAXCMS.HAXCMS_DEFAULT_THEME;
  const themeVariables = isObjectLike(themeMetadata.variables)
    ? cloneJson(themeMetadata.variables, {})
    : {};
  const themesRegistry = HAXCMS.getThemes();
  let themeSettings = {};
  if (isObjectLike(themesRegistry) && isObjectLike(themesRegistry[themeElement])) {
    themeSettings = cloneJson(themesRegistry[themeElement], {});
  }
  Object.keys(themeMetadata).forEach((key) => {
    if (key !== 'element' && key !== 'variables') {
      themeSettings[key] = cloneJson(themeMetadata[key], themeMetadata[key]);
    }
  });
  const useCaseImage =
    typeof themeSettings.thumbnail === 'string' && themeSettings.thumbnail !== ''
      ? themeSettings.thumbnail
      : `@haxtheweb/haxcms-elements/lib/theme-screenshots/theme-${themeElement}-thumb.jpg`;
  return {
    themeElement,
    themeVariables,
    themeSettings,
    useCaseImage,
  };
}

function getSourceUrlForSite(siteName) {
  let basePath = HAXCMS.basePath || '/';
  if (basePath.charAt(basePath.length - 1) !== '/') {
    basePath += '/';
  }
  const cleanSitesDirectory = String(HAXCMS.sitesDirectory || '_sites').replace(
    /^\/+|\/+$/g,
    '',
  );
  return `${basePath}${cleanSitesDirectory}/${siteName}/`;
}

async function generateSiteSkeleton(site) {
  if (!site || !site.manifest || !isObjectLike(site.manifest)) {
    throw new Error('Invalid site requested');
  }
  const manifest = site.manifest;
  const manifestMetadata = isObjectLike(manifest.metadata) ? manifest.metadata : {};
  const siteMetadata = isObjectLike(manifestMetadata.site) ? manifestMetadata.site : {};
  const siteNameSource =
    typeof siteMetadata.name === 'string' && siteMetadata.name !== ''
      ? siteMetadata.name
      : typeof site.name === 'string' && site.name !== ''
        ? site.name
        : 'site-template';
  const siteName = normalizeMachineName(siteNameSource);
  const siteTitle =
    typeof manifest.title === 'string' && manifest.title !== ''
      ? manifest.title
      : siteName;
  const siteDescription =
    typeof manifest.description === 'string' && manifest.description !== ''
      ? `Template based on ${manifest.description}`
      : `Template based on ${siteTitle}`;
  const siteSettings = isObjectLike(siteMetadata.settings)
    ? cloneJson(siteMetadata.settings, {})
    : {};
  if (!siteSettings.lang) {
    siteSettings.lang = 'en-US';
  }
  if (typeof siteSettings.publishPagesOn === 'undefined') {
    siteSettings.publishPagesOn = true;
  }
  if (typeof siteSettings.canonical === 'undefined') {
    siteSettings.canonical = true;
  }
  const platformSettings = isObjectLike(manifestMetadata.platform)
    ? cloneJson(manifestMetadata.platform, {})
    : {};
  const category = normalizeArrayValue(siteMetadata.category);
  const tags = normalizeArrayValue(siteMetadata.tags);
  const themeData = resolveThemeData(manifestMetadata);
  const siteDirectory =
    typeof site.siteDirectory === 'string' && site.siteDirectory !== ''
      ? site.siteDirectory
      : path.join(site.directory, siteName);
  const sourceUrl = getSourceUrlForSite(siteName);
  const rawItems = Array.isArray(manifest.items) ? [...manifest.items] : [];
  rawItems.sort((a, b) => {
    const aOrder =
      a && typeof a.order !== 'undefined' && !Number.isNaN(Number(a.order))
        ? Number(a.order)
        : Number.MAX_SAFE_INTEGER;
    const bOrder =
      b && typeof b.order !== 'undefined' && !Number.isNaN(Number(b.order))
        ? Number(b.order)
        : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return 0;
  });
  const structure = [];
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    const id =
      item && typeof item.id === 'string' && item.id !== ''
        ? item.id
        : HAXCMS.generateUUID();
    const title =
      item && typeof item.title === 'string' && item.title !== ''
        ? item.title
        : `Page ${i + 1}`;
    const slug =
      item && typeof item.slug === 'string' && item.slug !== ''
        ? item.slug
        : `page-${i + 1}`;
    const parent =
      item && typeof item.parent !== 'undefined' && item.parent !== ''
        ? item.parent
        : null;
    const order =
      item && typeof item.order !== 'undefined' && !Number.isNaN(Number(item.order))
        ? Number(item.order)
        : i;
    const indent =
      item && typeof item.indent !== 'undefined' && !Number.isNaN(Number(item.indent))
        ? Number(item.indent)
        : 0;
    const metadata = normalizeItemMetadata(item ? item.metadata : {});
    const content = await readItemContent(siteDirectory, item);
    structure.push({
      id,
      title,
      slug,
      order,
      parent,
      indent,
      content,
      metadata,
    });
  }
  const skeleton = {
    meta: {
      name: siteName,
      machineName: siteName,
      priority: 0,
      description: siteDescription,
      version: '1.0.0',
      created: new Date().toISOString(),
      type: 'skeleton',
      sourceUrl,
      useCaseTitle: siteTitle,
      useCaseDescription: siteDescription,
      useCaseImage: themeData.useCaseImage,
      category,
      tags,
      attributes: [],
    },
    site: {
      name: siteName,
      description: siteDescription,
      theme: themeData.themeElement,
      settings: siteSettings,
      platform: platformSettings,
    },
    build: {
      type: 'skeleton',
      structure: 'from-skeleton',
      items: structure,
      files: [],
    },
    theme: {
      ...themeData.themeSettings,
    },
    _skeleton: {
      originalMetadata: {
        site: {
          category,
          tags,
          settings: siteSettings,
        },
        licensing: isObjectLike(manifestMetadata.licensing)
          ? cloneJson(manifestMetadata.licensing, {})
          : {},
        node: isObjectLike(manifestMetadata.node)
          ? cloneJson(manifestMetadata.node, {})
          : {},
        platform: platformSettings,
      },
      originalSettings: siteSettings,
      fullThemeConfig: {
        element: themeData.themeElement,
        variables: themeData.themeVariables,
        settings: {
          ...themeData.themeSettings,
        },
      },
    },
  };
  if (typeof manifest.license === 'string' && manifest.license !== '') {
    skeleton.site.license = manifest.license;
  }
  return skeleton;
}

module.exports = {
  generateSiteSkeleton,
  normalizeMachineName,
};
