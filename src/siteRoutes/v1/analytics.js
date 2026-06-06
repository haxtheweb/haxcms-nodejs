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
  return sendFormattedResponse(
    req,
    res,
    {
      mode: 'read-only',
      xapi: {
        supported: false,
        statementFormats: ['application/json'],
        notes: [
          'xAPI statement capture is planned for a future authenticated endpoint set.',
        ],
      },
      notes: [
        'This endpoint currently reports analytics capability metadata only.',
        'User-level analytics and xAPI exports are intentionally deferred.',
      ],
      links: {
        self: `${apiBasePath}/v1/analytics`,
        reports: `${apiBasePath}/v1/reports`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

module.exports = analytics;
