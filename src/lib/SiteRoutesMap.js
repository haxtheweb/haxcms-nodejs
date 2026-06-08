// object containing site API routes and required handlers
// this is intentionally separate from RoutesMap (system/admin APIs)
const SiteRoutesMap = {
  get: {
    '': require('../siteRoutes/discovery/api.js'),
    openapi: require('../siteRoutes/discovery/openapi.js'),
    'openapi.json': require('../siteRoutes/discovery/openapi.js'),
    'openapi.yaml': require('../siteRoutes/discovery/openapi.js'),
    'v1/site': require('../siteRoutes/v1/site.js'),
    'v1/site/export/:format': require('../siteRoutes/v1/exports.js').siteExport,
    'v1/entities': require('../siteRoutes/v1/entities.js'),
    'v1/schemas': require('../siteRoutes/v1/schemas.js'),
    'v1/items': require('../siteRoutes/v1/items.js').listItems,
    'v1/items/:idOrSlug': require('../siteRoutes/v1/items.js').itemDetail,
    'v1/items/:idOrSlug/export/:format':
      require('../siteRoutes/v1/exports.js').itemExport,
    'v1/content': require('../siteRoutes/v1/content.js').listContent,
    'v1/content/:idOrSlug': require('../siteRoutes/v1/content.js').contentDetail,
    'v1/files': require('../siteRoutes/v1/files.js'),
    'v1/tags': require('../siteRoutes/v1/tags.js'),
    'v1/search': require('../siteRoutes/v1/search.js'),
    'v1/custom-elements':
      require('../siteRoutes/v1/customElements.js').listCustomElements,
    'v1/custom-elements/:webcomponentName':
      require('../siteRoutes/v1/customElements.js').customElementDetail,
    'v1/blocks': require('../siteRoutes/v1/blocks.js').listBlocks,
    'v1/blocks/:webcomponentName/usage':
      require('../siteRoutes/v1/blocks.js').blockUsage,
    'v1/blocks/:webcomponentName':
      require('../siteRoutes/v1/blocks.js').blockDetail,
    'v1/regions': require('../siteRoutes/v1/regions.js').listRegions,
    'v1/regions/:regionName': require('../siteRoutes/v1/regions.js').regionDetail,
    'v1/themes': require('../siteRoutes/v1/themes.js').listThemes,
    'v1/themes/active': require('../siteRoutes/v1/themes.js').activeTheme,
    'v1/themes/:themeName': require('../siteRoutes/v1/themes.js').themeDetail,
    'v1/reports': require('../siteRoutes/v1/reports.js').listReports,
    'v1/reports/:report': require('../siteRoutes/v1/reports.js').reportDetail,
    'v1/analytics': require('../siteRoutes/v1/analytics.js'),
    'v1/views': require('../siteRoutes/v1/views.js').listViews,
    'v1/views/:viewId/results': require('../siteRoutes/v1/views.js').viewResults,
    'v1/views/:viewId': require('../siteRoutes/v1/views.js').viewDetail,
    'v1/displays': require('../siteRoutes/v1/views.js').listDisplays,
    'v1/displays/:viewId/results':
      require('../siteRoutes/v1/views.js').displayResults,
  },
};

module.exports = { SiteRoutesMap };
