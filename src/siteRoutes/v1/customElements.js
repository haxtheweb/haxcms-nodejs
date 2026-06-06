const { HAXCMS } = require('../../lib/HAXCMS.js');
const {
  getApiBasePath,
  getCsvQuery,
  getQueryValue,
  sortRecords,
  paginateRecords,
  projectCollection,
  projectRecord,
  resolveSiteForRequest,
  sendFormattedResponse,
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

function buildSchemaFragments(tag, importPath) {
  return {
    haxProperties: {
      gizmo: {
        title: tag,
        tag,
        icon: 'icons:extension',
      },
      settings: {
        configure: [],
        advanced: [],
        developer: [],
      },
      source: importPath,
    },
    haxSchema: {
      api: '1',
      canScale: true,
      canPosition: true,
      canEditSource: true,
    },
    haxElementSchema: {
      tag,
      properties: [],
      slots: [],
    },
  };
}

function buildCustomElementRecords(site, apiBasePath, include = []) {
  const wcMap = HAXCMS.getWCRegistryJson(site);
  const records = [];
  for (const key in wcMap) {
    const tag = String(key || '').trim();
    if (tag === '') {
      continue;
    }
    const importPath = parseImportPath(wcMap[key]);
    const record = {
      tag,
      import: importPath,
      package: parsePackageName(importPath),
      description: '',
      links: {
        self: `${apiBasePath}/v1/custom-elements/${encodeURIComponent(tag)}`,
        blocks: `${apiBasePath}/v1/blocks/${encodeURIComponent(tag)}`,
      },
    };
    const schemaFragments = buildSchemaFragments(tag, importPath);
    if (include.indexOf('haxProperties') !== -1) {
      record.haxProperties = schemaFragments.haxProperties;
    }
    if (include.indexOf('haxSchema') !== -1) {
      record.haxSchema = schemaFragments.haxSchema;
    }
    if (include.indexOf('haxElementSchema') !== -1) {
      record.haxElementSchema = schemaFragments.haxElementSchema;
    }
    records.push(record);
  }
  return records;
}

async function listCustomElements(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/custom-elements',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const include = getCsvQuery(req, 'include');
  const fields = getCsvQuery(req, 'fields');
  const filterTag = String(getQueryValue(req, 'filter.tag', '') || '')
    .trim()
    .toLowerCase();
  let records = buildCustomElementRecords(site, apiBasePath, include);
  if (filterTag !== '') {
    records = records.filter((record) =>
      String(record.tag || '').toLowerCase().includes(filterTag),
    );
  }
  records = sortRecords(records, getQueryValue(req, 'sort', ''), 'tag');
  const paged = paginateRecords(records, req, 100, 2000);
  const outputRecords = projectCollection(paged.records, fields);
  return sendFormattedResponse(
    req,
    res,
    {
      count: outputRecords.length,
      total: paged.page.total,
      page: paged.page,
      customElements: outputRecords,
      links: {
        self: `${apiBasePath}/v1/custom-elements`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

async function customElementDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message:
        'Unable to resolve site context for /x/api/v1/custom-elements/:webcomponentName',
    });
  }
  const webcomponentName =
    req && req.params && req.params.webcomponentName
      ? String(req.params.webcomponentName)
      : '';
  if (webcomponentName.trim() === '') {
    return res.status(404).json({
      status: 404,
      message: 'Custom element not found',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const include = getCsvQuery(req, 'include');
  const fields = getCsvQuery(req, 'fields');
  const records = buildCustomElementRecords(site, apiBasePath, include);
  const target = records.find(
    (record) => String(record.tag || '') === webcomponentName,
  );
  if (!target) {
    return res.status(404).json({
      status: 404,
      message: `Custom element "${webcomponentName}" not found`,
    });
  }
  const outputRecord = projectRecord(target, fields);
  return sendFormattedResponse(req, res, outputRecord, {
    allowedFormats: ['json'],
    defaultFormat: 'json',
  });
}

module.exports = {
  listCustomElements,
  customElementDetail,
};
