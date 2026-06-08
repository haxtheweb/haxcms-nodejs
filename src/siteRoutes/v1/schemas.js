const fs = require('fs');
const path = require('path');
const { HAXCMS } = require('../../lib/HAXCMS.js');
const {
  getApiBasePath,
  getQueryValue,
  sendFormattedResponse,
  resolveSiteForRequest,
} = require('./siteRouteUtils.js');
function parseImportPath(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    if (typeof value.path === 'string' && value.path !== '') {
      return value.path;
    }
    if (typeof value.import === 'string' && value.import !== '') {
      return value.import;
    }
  }
  return '';
}

function parsePackageName(importPath = '') {
  const cleanImport = String(importPath || '').trim();
  if (cleanImport === '') {
    return '';
  }
  const parts = cleanImport.split('/').filter((part) => part !== '');
  if (parts.length === 0) {
    return '';
  }
  if (parts[0].indexOf('@') === 0 && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function normalizeTagName(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getWebcomponentImportPath(site, webcomponentName = '') {
  const targetTag = normalizeTagName(webcomponentName);
  if (targetTag === '') {
    return '';
  }
  const wcMap = HAXCMS.getWCRegistryJson(site);
  if (!wcMap || typeof wcMap !== 'object') {
    return '';
  }
  if (Object.prototype.hasOwnProperty.call(wcMap, targetTag)) {
    return parseImportPath(wcMap[targetTag]);
  }
  for (const key in wcMap) {
    if (normalizeTagName(key) === targetTag) {
      return parseImportPath(wcMap[key]);
    }
  }
  return '';
}

function getHaxPropertiesSearchRoots(site) {
  const rootCandidates = [];
  if (site && site.siteDirectory) {
    rootCandidates.push(path.join(site.siteDirectory, 'build/es6/node_modules'));
    rootCandidates.push(path.join(site.siteDirectory, 'node_modules'));
  }
  rootCandidates.push(path.join(__dirname, '../../public/build/es6/node_modules'));
  rootCandidates.push(path.join(__dirname, '../../../node_modules'));
  rootCandidates.push(path.join(process.cwd(), 'src/public/build/es6/node_modules'));
  rootCandidates.push(path.join(process.cwd(), 'node_modules'));
  const roots = [];
  for (let i = 0; i < rootCandidates.length; i++) {
    const candidate = rootCandidates[i];
    if (!candidate || roots.indexOf(candidate) !== -1) {
      continue;
    }
    if (fs.existsSync(candidate)) {
      try {
        if (fs.lstatSync(candidate).isDirectory()) {
          roots.push(candidate);
        }
      }
      catch (e) {}
    }
  }
  return roots;
}

function getPathWithoutExtension(filePath = '') {
  const extension = path.extname(filePath);
  if (extension === '') {
    return filePath;
  }
  return filePath.substring(0, filePath.length - extension.length);
}

function buildHaxPropertiesCandidatePaths(
  searchRoot,
  importPath,
  webcomponentName,
) {
  const candidates = [];
  const packageName = parsePackageName(importPath);
  const importFilePath = path.join(searchRoot, importPath);
  const importDirectory = path.dirname(importFilePath);
  const importBaseName = path.basename(importFilePath, path.extname(importFilePath));
  const importFilePathNoExt = getPathWithoutExtension(importFilePath);
  const packageRoot = packageName ? path.join(searchRoot, packageName) : '';
  const tag = normalizeTagName(webcomponentName);
  candidates.push(`${importFilePathNoExt}.haxProperties.json`);
  candidates.push(path.join(importDirectory, `${importBaseName}.haxProperties.json`));
  candidates.push(path.join(importDirectory, 'lib', `${importBaseName}.haxProperties.json`));
  if (packageRoot !== '') {
    candidates.push(path.join(packageRoot, 'lib', `${importBaseName}.haxProperties.json`));
    if (tag !== '') {
      candidates.push(path.join(packageRoot, 'lib', `${tag}.haxProperties.json`));
      candidates.push(path.join(packageRoot, `${tag}.haxProperties.json`));
    }
  }
  const uniqueCandidates = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate && uniqueCandidates.indexOf(candidate) === -1) {
      uniqueCandidates.push(candidate);
    }
  }
  return uniqueCandidates;
}

function readJsonFile(filePath = '') {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  catch (e) {
    return null;
  }
}

function loadWebcomponentHaxProperties(site, webcomponentName = '') {
  const importPath = getWebcomponentImportPath(site, webcomponentName);
  if (importPath === '') {
    return null;
  }
  const roots = getHaxPropertiesSearchRoots(site);
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const candidates = buildHaxPropertiesCandidatePaths(
      root,
      importPath,
      webcomponentName,
    );
    for (let j = 0; j < candidates.length; j++) {
      const candidatePath = candidates[j];
      if (!fs.existsSync(candidatePath)) {
        continue;
      }
      let parsed = null;
      try {
        if (!fs.lstatSync(candidatePath).isFile()) {
          continue;
        }
        parsed = readJsonFile(candidatePath);
      }
      catch (e) {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function buildHaxSchemaFromProperties(webcomponentTag, haxProperties) {
  if (!haxProperties || typeof haxProperties !== 'object' || Array.isArray(haxProperties)) {
    return {
      tag: webcomponentTag,
      type: 'object',
      properties: {
        api: { type: 'string' },
        canScale: { type: 'boolean' },
        canPosition: { type: 'boolean' },
        canEditSource: { type: 'boolean' },
      },
    };
  }
  const api = Object.prototype.hasOwnProperty.call(haxProperties, 'api')
    ? haxProperties.api
    : '1';
  const canScale = Object.prototype.hasOwnProperty.call(haxProperties, 'canScale')
    ? Boolean(haxProperties.canScale)
    : true;
  const canPosition = Object.prototype.hasOwnProperty.call(haxProperties, 'canPosition')
    ? Boolean(haxProperties.canPosition)
    : true;
  const canEditSource = Object.prototype.hasOwnProperty.call(haxProperties, 'canEditSource')
    ? Boolean(haxProperties.canEditSource)
    : true;
  return {
    tag: webcomponentTag,
    api,
    canScale,
    canPosition,
    canEditSource,
  };
}

function buildHaxPropertiesSchema(webcomponentTag, haxProperties) {
  if (!haxProperties || typeof haxProperties !== 'object' || Array.isArray(haxProperties)) {
    return {
      tag: webcomponentTag,
      type: 'object',
      properties: {
        gizmo: { type: 'object' },
        settings: {
          type: 'object',
          properties: {
            configure: { type: 'array' },
            advanced: { type: 'array' },
            developer: { type: 'array' },
          },
        },
      },
    };
  }
  return {
    tag: webcomponentTag,
    ...haxProperties,
  };
}

function buildSchemaDescriptors(
  apiBasePath = '/x/api',
  webcomponentName = '',
  webcomponentHaxProperties = null,
) {
  const webcomponentTag = String(webcomponentName || '').trim() || '*';
  const haxPropertiesSchema = buildHaxPropertiesSchema(
    webcomponentTag,
    webcomponentHaxProperties,
  );
  const haxSchema = buildHaxSchemaFromProperties(
    webcomponentTag,
    webcomponentHaxProperties,
  );
  return [
    {
      id: 'json-outline-schema',
      title: 'JSON Outline Schema',
      version: '1.0.0',
      kind: 'jsonOutlineSchema',
      mediaType: 'application/json',
      appliesTo: ['site', 'item', 'content'],
      links: {
        spec: 'https://github.com/haxtheweb/json-outline-schema',
      },
      schema: {
        type: 'object',
        required: ['id', 'title', 'items'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          metadata: { type: 'object' },
          items: { type: 'array', items: { type: 'object' } },
        },
      },
    },
    {
      id: 'json-outline-schema-item',
      title: 'JSON Outline Schema Item',
      version: '1.0.0',
      kind: 'jsonOutlineSchemaItem',
      mediaType: 'application/json',
      appliesTo: ['item', 'content'],
      links: {
        spec: 'https://github.com/haxtheweb/json-outline-schema',
      },
      schema: {
        type: 'object',
        required: ['id', 'title', 'slug', 'location'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          slug: { type: 'string' },
          location: { type: 'string' },
          parent: { type: ['string', 'null'] },
          indent: { type: 'number' },
          order: { type: 'number' },
          description: { type: 'string' },
          metadata: { type: 'object' },
        },
      },
    },
    {
      id: 'oer-schema',
      title: 'OER Schema',
      version: '0.3.4',
      kind: 'oerSchema',
      mediaType: 'application/json',
      appliesTo: ['site', 'item', 'content'],
      links: {
        spec: 'https://github.com/open-curriculum/oerschema',
      },
      schema: {
        type: 'object',
        properties: {
          '@context': { type: ['string', 'object'] },
          '@type': { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          uri: { type: 'string' },
          sameAs: { type: 'string' },
          forCourse: { type: ['string', 'object'] },
          hasLearningObjective: { type: ['array', 'object'] },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'hax-properties',
      title: 'HAX Properties',
      version: '1.0.0',
      kind: 'haxProperties',
      mediaType: 'application/json',
      appliesTo: ['block', 'customElement'],
      links: {
        spec: 'https://github.com/haxtheweb/hax-schema',
      },
      schema: haxPropertiesSchema,
    },
    {
      id: 'hax-element-schema',
      title: 'HAX Element Schema',
      version: '1.0.0',
      kind: 'haxElementSchema',
      mediaType: 'application/json',
      appliesTo: ['block', 'customElement'],
      links: {
        spec: 'https://github.com/haxtheweb/hax-element-schema',
      },
      schema: {
        tag: webcomponentTag,
        type: 'object',
        properties: {
          tag: { type: 'string' },
          properties: { type: 'array' },
          slots: { type: 'array' },
        },
      },
    },
    {
      id: 'hax-schema',
      title: 'HAX Schema',
      version: '1.0.0',
      kind: 'haxSchema',
      mediaType: 'application/json',
      appliesTo: ['block', 'customElement'],
      links: {
        spec: 'https://github.com/haxtheweb/hax-schema',
      },
      schema: haxSchema,
    },
    {
      id: 'app-store-schema',
      title: 'HAX App Store Schema',
      version: '1.0.0',
      kind: 'appStoreSchema',
      mediaType: 'application/json',
      appliesTo: ['customElement', 'block'],
      links: {
        spec: 'https://github.com/haxtheweb/appstore-spec',
      },
      schema: {
        type: 'object',
        properties: {
          details: { type: 'object' },
          connection: { type: 'object' },
        },
      },
    },
    {
      id: 'view-display-schema',
      title: 'View/Display Schema',
      version: '1.0.0',
      kind: 'viewSchema',
      mediaType: 'application/json',
      appliesTo: ['view'],
      links: {
        views: `${apiBasePath}/v1/views`,
      },
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          query: { type: 'object' },
          display: { type: 'object' },
        },
      },
    },
    {
      id: 'xapi-statement-schema',
      title: 'xAPI Statement',
      version: '1.0.3',
      kind: 'xapi',
      mediaType: 'application/xapi+json',
      appliesTo: ['analytics'],
      links: {
        spec: 'https://github.com/adlnet/xAPI-Spec/blob/master/xAPI-Data.md#statement',
      },
      schema: {
        type: 'object',
        required: ['actor', 'verb', 'object'],
        properties: {
          id: { type: 'string' },
          actor: { type: 'object' },
          verb: { type: 'object' },
          object: { type: 'object' },
          result: { type: 'object' },
          context: { type: 'object' },
          timestamp: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    {
      id: 'query-contract-schema',
      title: 'Site API Query Contract',
      version: '1.0.0',
      kind: 'queryContract',
      mediaType: 'application/json',
      appliesTo: ['items', 'content', 'files', 'search', 'reports', 'views'],
      schema: {
        type: 'object',
        properties: {
          'filter.*': { type: 'object' },
          'page.limit': { type: 'number' },
          'page.offset': { type: 'number' },
          sort: { type: 'string' },
          fields: { type: 'string' },
          include: { type: 'string' },
          format: {
            type: 'string',
            enum: ['json', 'md', 'yaml', 'xml', 'html', 'xapi'],
          },
          mode: {
            type: 'string',
            enum: ['bundle', 'concat'],
          },
        },
      },
    },
  ];
}

async function schemas(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/schemas',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const filterKind = String(getQueryValue(req, 'filter.kind', '') || '').trim();
  const filterWebcomponentName = String(
    getQueryValue(req, 'filter.webcomponentName', '') || '',
  ).trim();
  let webcomponentHaxProperties = null;
  if (filterWebcomponentName !== '') {
    webcomponentHaxProperties = loadWebcomponentHaxProperties(
      site,
      filterWebcomponentName,
    );
  }
  let schemasList = buildSchemaDescriptors(
    apiBasePath,
    filterWebcomponentName,
    webcomponentHaxProperties,
  );
  if (filterKind !== '') {
    schemasList = schemasList.filter(
      (schema) => String(schema.kind || '') === filterKind,
    );
  }
  return sendFormattedResponse(
    req,
    res,
    {
      count: schemasList.length,
      schemas: schemasList,
      links: {
        self: `${apiBasePath}/v1/schemas`,
        entities: `${apiBasePath}/v1/entities`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

module.exports = schemas;
