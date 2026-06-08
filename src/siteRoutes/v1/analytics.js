const {
  getApiBasePath,
  resolveSiteForRequest,
  sendFormattedResponse,
} = require('./siteRouteUtils.js');

async function analytics(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/analytics',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const xapiSchemaLink = `${apiBasePath}/v1/schemas?filter.kind=xapi`;
  return sendFormattedResponse(
    req,
    res,
    {
      mode: 'read-only',
      xapi: {
        supported: true,
        schema: xapiSchemaLink,
        statementFormats: ['application/xapi+json', 'application/json'],
        notes: [
          'xAPI statement payloads are defined through the linked schema descriptor.',
        ],
      },
      notes: [
        'This endpoint currently reports analytics capability metadata only.',
        'xAPI schema discovery is available through /x/api/v1/schemas.',
      ],
      links: {
        self: `${apiBasePath}/v1/analytics`,
        reports: `${apiBasePath}/v1/reports`,
        xapiSchema: xapiSchemaLink,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

module.exports = analytics;
