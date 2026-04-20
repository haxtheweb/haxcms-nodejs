const { HAXCMS } = require('../lib/HAXCMS.js');
const filter_var = require('../lib/filter_var.js');
const { sanitizeURLValue } = require('../lib/sanitizeContent.js');

/**
 * @OA\Post(
 *    path="/saveSeoSettings",
 *    tags={"cms","authenticated"},
 *    @OA\Parameter(
 *         name="site_token",
 *         description="Site-specific validation token",
 *         in="query",
 *         required=true,
 *         @OA\Schema(type="string")
 *    ),
 *    @OA\Response(
 *        response="200",
 *        description="Save SEO and author settings into site.json"
 *   )
 * )
 */
async function saveSeoSettings(req, res) {
  if (
    req.query['site_token'] &&
    req.body &&
    req.body.site &&
    req.body.site.name &&
    HAXCMS.validateRequestToken(
      req.query['site_token'],
      HAXCMS.getActiveUserName() + ':' + req.body.site.name,
    )
  ) {
    const site = await HAXCMS.loadSite(req.body.site.name);
    if (!site || !site.manifest) {
      res.sendStatus(400);
      return;
    }

    if (!site.manifest.metadata) {
      site.manifest.metadata = {};
    }
    if (!site.manifest.metadata.site) {
      site.manifest.metadata.site = {};
    }
    if (!site.manifest.metadata.site.settings) {
      site.manifest.metadata.site.settings = {};
    }
    if (!site.manifest.metadata.author) {
      site.manifest.metadata.author = {};
    }

    const bodyAuthor =
      req.body.author && typeof req.body.author === 'object' ? req.body.author : {};
    const bodySeo =
      req.body.seo && typeof req.body.seo === 'object' ? req.body.seo : {};
    const manifestAuthor =
      req.body.manifest &&
      req.body.manifest.author &&
      typeof req.body.manifest.author === 'object'
        ? req.body.manifest.author
        : {};
    const manifestSeo =
      req.body.manifest &&
      req.body.manifest.seo &&
      typeof req.body.manifest.seo === 'object'
        ? req.body.manifest.seo
        : {};

    const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const normalizeString = (value) =>
      value === null || typeof value === 'undefined' ? '' : String(value);
    const parseBoolean = (value) => {
      if (value === null || typeof value === 'undefined' || value === '') {
        return null;
      }
      return filter_var(
        value,
        'FILTER_VALIDATE_BOOLEAN',
        'FILTER_NULL_ON_FAILURE',
      );
    };

    let licenseValue;
    if (hasOwn(bodyAuthor, 'license')) {
      licenseValue = normalizeString(bodyAuthor.license);
    } else if (hasOwn(manifestAuthor, 'manifest.license')) {
      licenseValue = normalizeString(manifestAuthor['manifest.license']);
    }
    if (typeof licenseValue !== 'undefined') {
      site.manifest.license = filter_var(licenseValue, 'FILTER_SANITIZE_STRING');
    }

    let authorImageValue;
    if (hasOwn(bodyAuthor, 'image')) {
      authorImageValue = normalizeString(bodyAuthor.image);
    } else if (hasOwn(manifestAuthor, 'manifest.metadata.author.image')) {
      authorImageValue = normalizeString(
        manifestAuthor['manifest.metadata.author.image'],
      );
    }
    if (typeof authorImageValue !== 'undefined') {
      site.manifest.metadata.author.image = filter_var(
        authorImageValue,
        'FILTER_SANITIZE_STRING',
      );
      site.manifest.metadata.author.image = sanitizeURLValue(
        site.manifest.metadata.author.image,
        '',
      );
    }

    let authorNameValue;
    if (hasOwn(bodyAuthor, 'name')) {
      authorNameValue = normalizeString(bodyAuthor.name);
    } else if (hasOwn(manifestAuthor, 'manifest.metadata.author.name')) {
      authorNameValue = normalizeString(
        manifestAuthor['manifest.metadata.author.name'],
      );
    }
    if (typeof authorNameValue !== 'undefined') {
      site.manifest.metadata.author.name = filter_var(
        authorNameValue,
        'FILTER_SANITIZE_STRING',
      );
    }

    let authorSocialLinkValue;
    if (hasOwn(bodyAuthor, 'socialLink')) {
      authorSocialLinkValue = normalizeString(bodyAuthor.socialLink);
    } else if (hasOwn(manifestAuthor, 'manifest.metadata.author.socialLink')) {
      authorSocialLinkValue = normalizeString(
        manifestAuthor['manifest.metadata.author.socialLink'],
      );
    }
    if (typeof authorSocialLinkValue !== 'undefined') {
      site.manifest.metadata.author.socialLink = filter_var(
        authorSocialLinkValue,
        'FILTER_SANITIZE_STRING',
      );
      site.manifest.metadata.author.socialLink = sanitizeURLValue(
        site.manifest.metadata.author.socialLink,
        '',
      );
    }

    let pathautoInput;
    if (hasOwn(bodySeo, 'pathauto')) {
      pathautoInput = bodySeo.pathauto;
    } else if (hasOwn(manifestSeo, 'manifest.metadata.site.settings.pathauto')) {
      pathautoInput = manifestSeo['manifest.metadata.site.settings.pathauto'];
    }
    const pathautoValue = parseBoolean(pathautoInput);
    if (pathautoValue !== null) {
      site.manifest.metadata.site.settings.pathauto = pathautoValue;
    }

    let publishPagesOnInput;
    if (hasOwn(bodySeo, 'publishPagesOn')) {
      publishPagesOnInput = bodySeo.publishPagesOn;
    } else if (
      hasOwn(manifestSeo, 'manifest.metadata.site.settings.publishPagesOn')
    ) {
      publishPagesOnInput =
        manifestSeo['manifest.metadata.site.settings.publishPagesOn'];
    }
    const publishPagesOnValue = parseBoolean(publishPagesOnInput);
    if (publishPagesOnValue !== null) {
      site.manifest.metadata.site.settings.publishPagesOn = publishPagesOnValue;
    }

    site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);
    await site.manifest.save(false);
    await site.gitCommit('SEO settings updated');

    res.send(site.manifest);
  } else {
    res.sendStatus(403);
  }
}

module.exports = saveSeoSettings;
