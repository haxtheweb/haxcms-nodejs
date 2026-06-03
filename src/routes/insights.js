const { HAXCMS } = require('../lib/HAXCMS.js');
const { courseStatsFromOutline, siteHTMLContent } = require('../lib/JOSHelpers.js');

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

function getGradeLevel(text) {
  const score = safeReadabilityMetric(rs.daleChallReadabilityScore, text);
  if (score <= 4.9) {
    return '4th grade or lower';
  }
  else if (score > 4.9 && score <= 5.9) {
    return '5th / 6th grade';
  }
  else if (score > 5.9 && score <= 6.9) {
    return '7th / 8th grade';
  }
  else if (score > 6.9 && score <= 7.9) {
    return '9th / 10th grade';
  }
  else if (score > 7.9 && score <= 8.9) {
    return '11th / 12th grade';
  }
  return 'college level reading';
}


function normalizeActiveId(body = {}) {
  let itemId = null;
  if (typeof body.activeId !== 'undefined' && body.activeId !== null) {
    itemId = body.activeId;
  }
  if (itemId === 'null') {
    itemId = null;
  }
  return itemId;
}

function toISOFromUnixTime(value) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return new Date(0).toISOString();
  }
  return new Date(parsed * 1000).toISOString();
}

function normalizeManifestItems(manifest) {
  if (!manifest || !manifest.items) {
    return [];
  }
  if (Array.isArray(manifest.items)) {
    return [...manifest.items];
  }
  const items = [];
  for (const key in manifest.items) {
    if (manifest.items[key]) {
      items.push(manifest.items[key]);
    }
  }
  return items;
}

function safeReadabilityMetric(method, text) {
  try {
    return method(text);
  }
  catch (e) {
    return 0;
  }
}

/**
 * @OA\Post(
 *    path="/insights",
 *    tags={"cms","authenticated","reports"},
 *    @OA\Response(
 *        response="200",
 *        description="Load site insights report data"
 *   )
 * )
 */
async function insights(req, res) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  const siteName =
    body && body.site && body.site.name ? String(body.site.name).trim() : '';
  if (
    req.query['site_token'] &&
    siteName &&
    HAXCMS.validateRequestToken(
      req.query['site_token'],
      HAXCMS.getActiveUserName() + ':' + siteName
    )
  ) {
    const site = await HAXCMS.loadSite(siteName);
    if (!site || !site.manifest) {
      return res.send({
        status: 200,
        data: {},
      });
    }
    const itemId = normalizeActiveId(body);
    const data = await courseStatsFromOutline('', site, itemId);
    const text = await siteHTMLContent(site, null, itemId, true, true);
    const readabilityText = typeof text === 'string' ? text : '';
    data.readability = {
      gradeLevel: getGradeLevel(readabilityText),
      difficultWords: safeReadabilityMetric(rs.difficultWords, readabilityText),
      syllableCount: safeReadabilityMetric(rs.syllableCount, readabilityText),
      lexiconCount: safeReadabilityMetric(rs.lexiconCount, readabilityText),
      sentenceCount: safeReadabilityMetric(rs.sentenceCount, readabilityText),
    };
    const fullManifest = site.manifest;
    let items = normalizeManifestItems(fullManifest);
    if (itemId === null || itemId === 'null') {
      data.updated = toISOFromUnixTime(
        fullManifest.metadata &&
          fullManifest.metadata.site &&
          fullManifest.metadata.site.updated
          ? fullManifest.metadata.site.updated
          : 0
      );
      data.created = toISOFromUnixTime(
        fullManifest.metadata &&
          fullManifest.metadata.site &&
          fullManifest.metadata.site.created
          ? fullManifest.metadata.site.created
          : 0
      );
      data.title = fullManifest.title;
    }
    else {
      const activeItem = fullManifest.getItemById(itemId);
      if (activeItem && activeItem.metadata) {
        data.updated = toISOFromUnixTime(activeItem.metadata.updated);
        data.created = toISOFromUnixTime(activeItem.metadata.created);
        data.title = activeItem.title;
      }
      if (typeof fullManifest.findBranch === 'function') {
        items = fullManifest.findBranch(itemId);
      }
    }
    if (items && items.length > 0) {
      items.sort(function (a, b) {
        const bUpdated = parseInt(
          b && b.metadata && b.metadata.updated ? b.metadata.updated : 0,
          10
        );
        const aUpdated = parseInt(
          a && a.metadata && a.metadata.updated ? a.metadata.updated : 0,
          10
        );
        return bUpdated - aUpdated;
      });
      items.map((item) => {
        if (item && item.metadata && item.metadata.updated) {
          item.metadata.updated = toISOFromUnixTime(item.metadata.updated);
        }
        return item;
      });
      data.updatedItems = items.slice(0, 6);
    }
    return res.send({
      status: 200,
      data: data,
    });
  }
  return res.sendStatus(403);
}

module.exports = insights;
