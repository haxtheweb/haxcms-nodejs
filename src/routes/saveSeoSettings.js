const { HAXCMS } = require('../lib/HAXCMS.js');
const filter_var = require('../lib/filter_var.js');
const { sanitizeURLValue } = require('../lib/sanitizeContent.js');
const {
  platformAllows,
  featureDisabledResponse,
} = require('../lib/platformFeatures.js');

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
    if (!platformAllows(site, 'seoManifest')) {
      return featureDisabledResponse(
        res,
        'SEO settings are disabled for this site'
      );
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

    let authorEmailValue;
    if (hasOwn(bodyAuthor, 'email')) {
      authorEmailValue = normalizeString(bodyAuthor.email);
    } else if (hasOwn(manifestAuthor, 'manifest.metadata.author.email')) {
      authorEmailValue = normalizeString(
        manifestAuthor['manifest.metadata.author.email'],
      );
    }
    if (typeof authorEmailValue !== 'undefined') {
      site.manifest.metadata.author.email = filter_var(
        authorEmailValue,
        'FILTER_SANITIZE_EMAIL',
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

    let descriptionValue;
    if (hasOwn(bodySeo, 'description')) {
      descriptionValue = normalizeString(bodySeo.description);
    } else if (hasOwn(manifestSeo, 'manifest.description')) {
      descriptionValue = normalizeString(manifestSeo['manifest.description']);
    }
    if (typeof descriptionValue !== 'undefined') {
      site.manifest.description = filter_var(
        descriptionValue,
        'FILTER_SANITIZE_STRING',
      );
    }

    let logoValue;
    if (hasOwn(bodySeo, 'logo')) {
      logoValue = normalizeString(bodySeo.logo);
    } else if (hasOwn(manifestSeo, 'manifest.metadata.site.logo')) {
      logoValue = normalizeString(manifestSeo['manifest.metadata.site.logo']);
    }
    if (typeof logoValue !== 'undefined') {
      site.manifest.metadata.site.logo = filter_var(
        logoValue,
        'FILTER_SANITIZE_STRING',
      );
      site.manifest.metadata.site.logo = sanitizeURLValue(
        site.manifest.metadata.site.logo,
        '',
      );
    }

    let domainValue;
    if (hasOwn(bodySeo, 'domain')) {
      domainValue = normalizeString(bodySeo.domain);
    } else if (hasOwn(manifestSeo, 'manifest.metadata.site.domain')) {
      domainValue = normalizeString(
        manifestSeo['manifest.metadata.site.domain'],
      );
    }
    if (typeof domainValue !== 'undefined') {
      site.manifest.metadata.site.domain = filter_var(
        domainValue,
        'FILTER_SANITIZE_STRING',
      );
      site.manifest.metadata.site.domain = sanitizeURLValue(
        site.manifest.metadata.site.domain,
        '',
      );
    }

    let langValue;
    if (hasOwn(bodySeo, 'lang')) {
      langValue = normalizeString(bodySeo.lang);
    } else if (hasOwn(manifestSeo, 'manifest.metadata.site.settings.lang')) {
      langValue = normalizeString(
        manifestSeo['manifest.metadata.site.settings.lang'],
      );
    }
    if (typeof langValue !== 'undefined') {
      site.manifest.metadata.site.settings.lang = filter_var(
        langValue,
        'FILTER_SANITIZE_STRING',
      );
    }

    let gaIDValue;
    if (hasOwn(bodySeo, 'gaID')) {
      gaIDValue = normalizeString(bodySeo.gaID);
    } else if (hasOwn(manifestSeo, 'manifest.metadata.site.settings.gaID')) {
      gaIDValue = normalizeString(
        manifestSeo['manifest.metadata.site.settings.gaID'],
      );
    }
    if (typeof gaIDValue !== 'undefined') {
      site.manifest.metadata.site.settings.gaID = filter_var(
        gaIDValue,
        'FILTER_SANITIZE_STRING',
      );
    }

    let privateInput;
    if (hasOwn(bodySeo, 'private')) {
      privateInput = bodySeo.private;
    } else if (hasOwn(manifestSeo, 'manifest.metadata.site.settings.private')) {
      privateInput = manifestSeo['manifest.metadata.site.settings.private'];
    }
    const privateValue = parseBoolean(privateInput);
    if (privateValue !== null) {
      site.manifest.metadata.site.settings.private = privateValue;
    }

    let canonicalInput;
    if (hasOwn(bodySeo, 'canonical')) {
      canonicalInput = bodySeo.canonical;
    } else if (
      hasOwn(manifestSeo, 'manifest.metadata.site.settings.canonical')
    ) {
      canonicalInput = manifestSeo['manifest.metadata.site.settings.canonical'];
    }
    const canonicalValue = parseBoolean(canonicalInput);
    if (canonicalValue !== null) {
      site.manifest.metadata.site.settings.canonical = canonicalValue;
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
