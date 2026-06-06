const { courseStatsFromOutline, siteHTMLContent } = require('../../lib/JOSHelpers.js');
const {
  getApiBasePath,
  getCsvQuery,
  getQueryValue,
  resolveSiteForRequest,
  sendFormattedResponse,
} = require('./siteRouteUtils.js');

let rs = null;
try {
  rs = require('text-readability');
  if (rs && rs.default) {
    rs = rs.default;
  }
}
catch (e) {
  rs = {
    daleChallReadabilityScore: () => 0,
    difficultWords: () => 0,
    syllableCount: () => 0,
    lexiconCount: () => 0,
    sentenceCount: () => 0,
  };
}

const REPORT_DEFINITIONS = {
  overview: {
    id: 'overview',
    title: 'Overview report',
    description: 'Aggregate site statistics for dashboard overview cards.',
    includes: null,
  },
  insights: {
    id: 'insights',
    title: 'Insights report',
    description: 'Content insight metrics including readability and structure counts.',
    includes: null,
  },
  content: {
    id: 'content',
    title: 'Content report',
    description: 'Detailed page-by-page content metrics for admin review.',
    includes: ['contentData'],
  },
  links: {
    id: 'links',
    title: 'Links report',
    description: 'External link usage and grouping details.',
    includes: ['linkData'],
  },
  media: {
    id: 'media',
    title: 'Media report',
    description: 'Media usage and accessibility signal summary.',
    includes: ['mediaData'],
  },
};

function safeReadabilityMetric(method, text) {
  try {
    return method(text);
  }
  catch (e) {
    return 0;
  }
}

function getGradeLevel(text) {
  const score = safeReadabilityMetric(rs.daleChallReadabilityScore, text);
  if (score <= 4.9) {
    return '4th grade or lower';
  }
  if (score > 4.9 && score <= 5.9) {
    return '5th / 6th grade';
  }
  if (score > 5.9 && score <= 6.9) {
    return '7th / 8th grade';
  }
  if (score > 6.9 && score <= 7.9) {
    return '9th / 10th grade';
  }
  if (score > 7.9 && score <= 8.9) {
    return '11th / 12th grade';
  }
  return 'college level reading';
}

async function listReports(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/reports',
    });
  }
  const apiBasePath = getApiBasePath(req);
  const reportIds = Object.keys(REPORT_DEFINITIONS);
  const reports = reportIds.map((id) => ({
    id,
    title: REPORT_DEFINITIONS[id].title,
    description: REPORT_DEFINITIONS[id].description,
    links: {
      self: `${apiBasePath}/v1/reports/${id}`,
    },
  }));
  return sendFormattedResponse(
    req,
    res,
    {
      count: reports.length,
      reports,
      links: {
        self: `${apiBasePath}/v1/reports`,
      },
    },
    {
      allowedFormats: ['json'],
      defaultFormat: 'json',
    },
  );
}

async function reportDetail(req, res) {
  const site = await resolveSiteForRequest(req);
  if (!site || !site.manifest) {
    return res.status(404).json({
      status: 404,
      message: 'Unable to resolve site context for /x/api/v1/reports/:report',
    });
  }
  const reportName =
    req && req.params && req.params.report ? String(req.params.report) : '';
  if (!Object.prototype.hasOwnProperty.call(REPORT_DEFINITIONS, reportName)) {
    return res.status(404).json({
      status: 404,
      message: `Unknown report "${reportName}"`,
    });
  }
  const definition = REPORT_DEFINITIONS[reportName];
  const ancestor =
    getQueryValue(req, 'filter.ancestor', '') ||
    getQueryValue(req, 'filter.parent', '') ||
    null;
  const includes =
    Array.isArray(definition.includes) && definition.includes.length > 0
      ? definition.includes
      : null;
  const data = await courseStatsFromOutline('', site, ancestor, includes);
  if (reportName === 'overview' || reportName === 'insights') {
    const text = await siteHTMLContent(site, null, ancestor, true, true);
    const readabilityText = typeof text === 'string' ? text : '';
    data.readability = {
      gradeLevel: getGradeLevel(readabilityText),
      difficultWords: safeReadabilityMetric(rs.difficultWords, readabilityText),
      syllableCount: safeReadabilityMetric(rs.syllableCount, readabilityText),
      lexiconCount: safeReadabilityMetric(rs.lexiconCount, readabilityText),
      sentenceCount: safeReadabilityMetric(rs.sentenceCount, readabilityText),
    };
  }
  const apiBasePath = getApiBasePath(req);
  const fields = getCsvQuery(req, 'fields');
  let payload = {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    generatedAt: new Date().toISOString(),
    data,
    links: {
      self: `${apiBasePath}/v1/reports/${definition.id}`,
      collection: `${apiBasePath}/v1/reports`,
    },
  };
  if (fields.length > 0) {
    const projected = {};
    for (let i = 0; i < fields.length; i++) {
      const field = String(fields[i] || '').trim();
      if (field !== '' && Object.prototype.hasOwnProperty.call(payload, field)) {
        projected[field] = payload[field];
      }
    }
    if (Object.keys(projected).length > 0) {
      payload = projected;
    }
  }
  return sendFormattedResponse(req, res, payload, {
    allowedFormats: ['json', 'md', 'yaml', 'xml'],
    defaultFormat: 'json',
  });
}

module.exports = {
  listReports,
  reportDetail,
};
