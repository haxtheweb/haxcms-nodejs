const { HAXCMS } = require('../../../lib/HAXCMS.js');
const filter_var = require('../../../lib/filter_var.js');
const fs = require('fs-extra');
const { sanitizeURLValue } = require('../../../lib/sanitizeContent.js');
const {
  platformAllows,
  featureDisabledResponse,
} = require('../../../lib/platformFeatures.js');
const { getRequestHeaderValue } = require('../siteRouteUtils.js');
/**
   * @OA\Post(
   *    path="/saveManifest",
   *    tags={"cms","authenticated"},
   *    @OA\Parameter(
   *         name="jwt",
   *         description="JSON Web token, obtain by using  /login",
   *         in="query",
   *         required=true,
   *         @OA\Schema(type="string")
   *    ),
   *    @OA\Response(
   *        response="200",
   *        description="Save the manifest of the site"
   *   )
   * )
   */
  async function saveManifest(req, res) {
    const siteToken = getRequestHeaderValue(req, 'x-haxcms-site-token');
    if (
      siteToken &&
      req.body &&
      req.body.site &&
      req.body.site.name &&
      HAXCMS.validateRequestToken(siteToken, HAXCMS.getActiveUserName() + ':' + req.body.site.name)
    ) {
      // load the site from name
      let site = await HAXCMS.loadSite(req.body['site']['name']);
      if (!platformAllows(site, 'siteManifest')) {
        return featureDisabledResponse(
          res,
          'Manifest editing is disabled for this site'
        );
      }
      // standard form submit
      // @todo 
      // make the form point to a form submission endpoint with appropriate name
      // add a hidden field to the output that always has the haxcms_form_id as well
      // as a dynamically generated Request token relative to the name of the
      // form
      // pull the form schema for the form itself internally
      // ensure ONLY the things that appear in that schema get set
      // if something DID NOT COME ACROSS, don't unset it, only set what shows up
      // if something DID COME ACROSS WE DIDN'T SET, kill the transaction (xss)

      // - snag the form
      // @todo see if we can dynamically save the valus in the same format we loaded
      // the original form in. This would involve removing the vast majority of
      // what's below
      /*if (HAXCMS.validateRequestToken(null, 'form')) {
        let context = {
          'site' : [],
          'node' : [],
        };
        if ((req.body['site'])) {
          context['site'] = req.body['site'];
        }
        if ((req.body['node'])) {
          context['node'] = req.body['node'];
        }
        form = HAXCMS.loadForm(req.body['haxcms_form_id'], context);
      }*/
      const isScopedDetailsPayload = isScopedDetailsManifestPayload(req.body);
      if (isScopedDetailsPayload || HAXCMS.validateRequestToken(req.body['haxcms_form_token'], req.body['haxcms_form_id'])) {
        // preserve platform settings regardless of what the client sends
        // (platform settings are saved via savePlatformSettings)
        const existingPlatform = site.manifest && site.manifest.metadata
          ? site.manifest.metadata.platform
          : null;
        if (isScopedDetailsPayload) {
          await saveScopedDetailsPayload(site, req.body);
        }
        else {

        site.manifest.title = req.body['manifest']['site']['manifest-title'].replace(/<\/?[^>]+(>|$)/g, "");
        site.manifest.description = req.body['manifest']['site']['manifest-description'].replace(/<\/?[^>]+(>|$)/g, "");
        // store some version data here just so we can find it later
        site.manifest.metadata.site.version = await HAXCMS.getHAXCMSVersion();
        site.manifest.metadata.site.domain = filter_var(
            req.body['manifest']['site']['manifest-metadata-site-domain'],
            "FILTER_SANITIZE_STRING"
        );
        site.manifest.metadata.site.domain = sanitizeURLValue(
          site.manifest.metadata.site.domain,
          ''
        );
        site.manifest.metadata.site.logo = sanitizeURLValue(
            req.body['manifest']['site']['manifest-metadata-site-logo'],
            ''
        );
        site.manifest.metadata.site.tags = filter_var(
          req.body['manifest']['site']['manifest-metadata-site-tags'],
          "FILTER_SANITIZE_STRING"
        );
        if (!(site.manifest.metadata.site.static)) {
          site.manifest.metadata.site.static = {};
        }
        if (!(site.manifest.metadata.site.settings)) {
          site.manifest.metadata.site.settings = {};
        }
        if (typeof req.body['manifest']['site']['manifest-domain'] !== 'undefined') {
          let domain = filter_var(
              req.body['manifest']['site']['manifest-domain'],
              "FILTER_SANITIZE_STRING"
          );
          domain = sanitizeURLValue(domain, '');
          // support updating the domain CNAME value
          if (site.manifest.metadata.site.domain != domain) {
            site.manifest.metadata.site.domain = domain;
            fs.writeFileSync(site.siteDirectory + '/CNAME', domain);
          }
        }
        let hThemes = await HAXCMS.getThemes();
        // look for a match so we can set the correct data
        for (var key in hThemes) {
          let theme = hThemes[key];
          if (
              filter_var(req.body['manifest']['theme']['manifest-metadata-theme-element'], "FILTER_SANITIZE_STRING") ==
              key
          ) {
              site.manifest.metadata.theme = theme;
          }
        }
        if (!(site.manifest.metadata.theme.variables)) {
          site.manifest.metadata.theme.variables = {};
        }

        if (typeof req.body['manifest']['theme']['manifest-metadata-theme-variables-image'] !== 'undefined') {
          site.manifest.metadata.theme.variables.image = filter_var(
            req.body['manifest']['theme']['manifest-metadata-theme-variables-image'],"FILTER_SANITIZE_STRING"
          );
          site.manifest.metadata.theme.variables.image = sanitizeURLValue(
            site.manifest.metadata.theme.variables.image,
            ''
          );
        }
        if (typeof req.body['manifest']['theme']['manifest-metadata-theme-variables-imageAlt'] !== 'undefined') {
          site.manifest.metadata.theme.variables.imageAlt = filter_var(
            req.body['manifest']['theme']['manifest-metadata-theme-variables-imageAlt'], "FILTER_SANITIZE_STRING"
          );
        }
        if (typeof req.body['manifest']['theme']['manifest-metadata-theme-variables-imageLink'] !== 'undefined') {
          site.manifest.metadata.theme.variables.imageLink = filter_var(
            req.body['manifest']['theme']['manifest-metadata-theme-variables-imageLink'], "FILTER_SANITIZE_STRING"
          );
          site.manifest.metadata.theme.variables.imageLink = sanitizeURLValue(
            site.manifest.metadata.theme.variables.imageLink,
            ''
          );
        }
        // REGIONS SUPPORT
        if (!(site.manifest.metadata.theme.regions)) {
          site.manifest.metadata.theme.regions = {};
        }
        // look for a match so we can set the correct data
        let validRegions = [
          "header",
          "sidebarFirst",
          "sidebarSecond",
          "contentTop",
          "contentBottom",
          "footerPrimary",
          "footerSecondary"
        ];
        for (var i in validRegions) {
          let value = validRegions[i];
          if (req.body['manifest']['theme']['manifest-metadata-theme-regions-' + value]) {
            for (var j in req.body['manifest']['theme']['manifest-metadata-theme-regions-' + value]) {
              let id = req.body['manifest']['theme']['manifest-metadata-theme-regions-' + value][j];
              req.body['manifest']['theme']['manifest-metadata-theme-regions-' + value][j] = filter_var(id, "FILTER_SANITIZE_STRING");
            }
            site.manifest.metadata.theme.regions[value] = req.body['manifest']['theme']['manifest-metadata-theme-regions-' + value];
          }
        }
        // hexCode removed: v1 API uses cssVariable exclusively
        site.manifest.metadata.theme.variables.cssVariable = "--simple-colors-default-theme-" + filter_var(
          req.body['manifest']['theme']['manifest-metadata-theme-variables-cssVariable'], "FILTER_SANITIZE_STRING"
        ) + "-7";
        if (
          typeof req.body['manifest']['theme']['manifest-metadata-theme-variables-palette'] !== 'undefined'
        ) {
          let paletteValue = filter_var(
            req.body['manifest']['theme']['manifest-metadata-theme-variables-palette'],
            "FILTER_SANITIZE_STRING"
          );
          if (typeof paletteValue === 'string') {
            paletteValue = paletteValue.trim().toLowerCase();
            if (paletteValue === '') {
              delete site.manifest.metadata.theme.variables.palette;
            } else if (/^[a-z0-9-]+$/.test(paletteValue)) {
              site.manifest.metadata.theme.variables.palette = paletteValue;
            }
          }
        }
        site.manifest.metadata.theme.variables.icon = filter_var(
          req.body['manifest']['theme']['manifest-metadata-theme-variables-icon'],"FILTER_SANITIZE_STRING"
        );
        if (typeof req.body['manifest']['author']['manifest-license'] !== 'undefined') {
            site.manifest.license = filter_var(
                req.body['manifest']['author']['manifest-license'],
                "FILTER_SANITIZE_STRING"
            );
            if (!(site.manifest.metadata.author)) {
              site.manifest.metadata.author = {};
            }
            site.manifest.metadata.author.image = filter_var(
                req.body['manifest']['author']['manifest-metadata-author-image'],
                "FILTER_SANITIZE_STRING"
            );
            site.manifest.metadata.author.image = sanitizeURLValue(
              site.manifest.metadata.author.image,
              ''
            );
            site.manifest.metadata.author.name = filter_var(
                req.body['manifest']['author']['manifest-metadata-author-name'],
                "FILTER_SANITIZE_STRING"
            );
            site.manifest.metadata.author.email = filter_var(
                req.body['manifest']['author']['manifest-metadata-author-email'],
                "FILTER_SANITIZE_STRING"
            );
            site.manifest.metadata.author.socialLink = filter_var(
                req.body['manifest']['author']['manifest-metadata-author-socialLink'],
                "FILTER_SANITIZE_STRING"
            );
            site.manifest.metadata.author.socialLink = sanitizeURLValue(
              site.manifest.metadata.author.socialLink,
              ''
            );
        }
        if (typeof req.body['manifest']['seo']['manifest-metadata-site-settings-private'] !== 'undefined') {
            site.manifest.metadata.site.settings.private = filter_var(
            req.body['manifest']['seo']['manifest-metadata-site-settings-private'],
            "FILTER_VALIDATE_BOOLEAN"
            );
        }
        if (typeof req.body['manifest']['seo']['manifest-metadata-site-settings-canonical'] !== 'undefined') {
            site.manifest.metadata.site.settings.canonical = filter_var(
            req.body['manifest']['seo']['manifest-metadata-site-settings-canonical'],
            "FILTER_VALIDATE_BOOLEAN"
            );
        }
        if (typeof req.body['manifest']['seo']['manifest-metadata-site-settings-lang'] !== 'undefined') {
          site.manifest.metadata.site.settings.lang = filter_var(
          req.body['manifest']['seo']['manifest-metadata-site-settings-lang'],
          "FILTER_SANITIZE_STRING"
          );
        }
        if (typeof req.body['manifest']['seo']['manifest-metadata-site-settings-pathauto'] !== 'undefined') {
            site.manifest.metadata.site.settings.pathauto = filter_var(
            req.body['manifest']['seo']['manifest-metadata-site-settings-pathauto'],
            "FILTER_VALIDATE_BOOLEAN"
            );
        }
        if (typeof req.body['manifest']['seo']['manifest-metadata-site-settings-publishPagesOn'] !== 'undefined') {
          site.manifest.metadata.site.settings.publishPagesOn = filter_var(
          req.body['manifest']['seo']['manifest-metadata-site-settings-publishPagesOn'],
          "FILTER_VALIDATE_BOOLEAN"
          );
        }
        if (typeof req.body['manifest']['seo']['manifest-metadata-site-settings-sw'] !== 'undefined') {
          site.manifest.metadata.site.settings.sw = filter_var(
          req.body['manifest']['seo']['manifest-metadata-site-settings-sw'],
          "FILTER_VALIDATE_BOOLEAN"
          );
        }
        if (typeof req.body['manifest']['seo']['manifest-metadata-site-settings-forceUpgrade'] !== 'undefined') {
          site.manifest.metadata.site.settings.forceUpgrade = filter_var(
          req.body['manifest']['seo']['manifest-metadata-site-settings-forceUpgrade'],
          "FILTER_VALIDATE_BOOLEAN"
          );
        }
        if (typeof req.body['manifest']['seo']['manifest-metadata-site-settings-gaID'] !== 'undefined') {
          site.manifest.metadata.site.settings.gaID = filter_var(
          req.body['manifest']['seo']['manifest-metadata-site-settings-gaID'],
          "FILTER_SANITIZE_STRING"
          );
        }
        // Handle homepage setting - validate it exists in the site outline
        if (typeof req.body['manifest']['site']['manifest-metadata-site-homePageId'] !== 'undefined') {
          let homePageId = filter_var(
            req.body['manifest']['site']['manifest-metadata-site-homePageId'],
            "FILTER_SANITIZE_STRING"
          );
          // Validate that the page exists in the site manifest
          let validPage = false;
          if (homePageId && homePageId !== '' && site.manifest.items) {
            for (let item of site.manifest.items) {
              if (item.id === homePageId) {
                validPage = true;
                break;
              }
            }
          }
          // Only set if valid, otherwise leave as null/unset
          if (validPage) {
            site.manifest.metadata.site.homePageId = homePageId;
          } else {
            // Remove the setting if it was previously set but is now invalid
            delete site.manifest.metadata.site.homePageId;
          }
        }
        }
        // ensure platform exists; do not overwrite existing platform settings
        if (!site.manifest.metadata.platform) {
          site.manifest.metadata.platform = {};
        }
        if (existingPlatform) {
          site.manifest.metadata.platform = existingPlatform;
        }

        site.manifest.metadata.site.updated = Math.floor(Date.now() / 1000);
        // don't reorganize the structure
        await site.manifest.save(false);
        await site.gitCommit('Manifest updated');
        // rebuild the files that twig processes
        await site.rebuildManagedFiles();
        site.updateAlternateFormats();
        await site.gitCommit('Managed files updated');
        res.send(site.manifest);
      }
      else {
        res.sendStatus(403);
      }
    } else {
      res.sendStatus(403);
    }
  }
  function isScopedDetailsManifestPayload(body) {
    if (!body || typeof body !== 'object') {
      return false;
    }
    if (!body['manifest'] || typeof body['manifest'] !== 'object') {
      return false;
    }
    const manifestSite = body['manifest']['site'];
    const manifestSeo = body['manifest']['seo'];
    const hasSitePayload = manifestSite && typeof manifestSite === 'object';
    const hasSeoPayload = manifestSeo && typeof manifestSeo === 'object';
    const hasDetailsFields =
      typeof body['title'] !== 'undefined' ||
      typeof body['homePageId'] !== 'undefined' ||
      typeof body['sw'] !== 'undefined' ||
      typeof body['forceUpgrade'] !== 'undefined' ||
      (hasSitePayload && (
        typeof manifestSite['manifest-title'] !== 'undefined' ||
        typeof manifestSite['manifest-metadata-site-homePageId'] !== 'undefined'
      )) ||
      (hasSeoPayload && (
        typeof manifestSeo['manifest-metadata-site-settings-sw'] !== 'undefined' ||
        typeof manifestSeo['manifest-metadata-site-settings-forceUpgrade'] !== 'undefined'
      ));
    if (!hasDetailsFields) {
      return false;
    }
    return (
      typeof body['haxcms_form_id'] === 'undefined' &&
      typeof body['haxcms_form_token'] === 'undefined'
    );
  }
  function ensureSiteMetadataContainers(site) {
    if (!(site.manifest.metadata)) {
      site.manifest.metadata = {};
    }
    if (!(site.manifest.metadata.site)) {
      site.manifest.metadata.site = {};
    }
    if (!(site.manifest.metadata.site.settings)) {
      site.manifest.metadata.site.settings = {};
    }
  }
  async function saveScopedDetailsPayload(site, body) {
    ensureSiteMetadataContainers(site);
    const manifestSite = body['manifest'] && body['manifest']['site']
      ? body['manifest']['site']
      : {};
    const manifestSeo = body['manifest'] && body['manifest']['seo']
      ? body['manifest']['seo']
      : {};

    let titleValue;
    if (typeof manifestSite['manifest-title'] !== 'undefined') {
      titleValue = manifestSite['manifest-title'];
    }
    else if (typeof body['title'] !== 'undefined') {
      titleValue = body['title'];
    }
    if (typeof titleValue !== 'undefined') {
      let cleanTitle = filter_var(titleValue, 'FILTER_SANITIZE_STRING');
      if (typeof cleanTitle === 'string') {
        site.manifest.title = cleanTitle.replace(/<\/?[^>]+(>|$)/g, '');
      }
    }

    let homePageId;
    if (typeof manifestSite['manifest-metadata-site-homePageId'] !== 'undefined') {
      homePageId = manifestSite['manifest-metadata-site-homePageId'];
    }
    else if (typeof body['homePageId'] !== 'undefined') {
      homePageId = body['homePageId'];
    }
    if (typeof homePageId !== 'undefined') {
      homePageId = filter_var(homePageId, 'FILTER_SANITIZE_STRING');
      let validPage = false;
      if (homePageId && homePageId !== '' && site.manifest.items) {
        for (let i = 0; i < site.manifest.items.length; i++) {
          if (site.manifest.items[i].id === homePageId) {
            validPage = true;
            break;
          }
        }
      }
      if (validPage) {
        site.manifest.metadata.site.homePageId = homePageId;
      }
      else {
        delete site.manifest.metadata.site.homePageId;
      }
    }

    let swValue;
    if (typeof manifestSeo['manifest-metadata-site-settings-sw'] !== 'undefined') {
      swValue = manifestSeo['manifest-metadata-site-settings-sw'];
    }
    else if (typeof body['sw'] !== 'undefined') {
      swValue = body['sw'];
    }
    if (typeof swValue !== 'undefined') {
      site.manifest.metadata.site.settings.sw = filter_var(
        swValue,
        'FILTER_VALIDATE_BOOLEAN'
      );
    }

    let forceUpgradeValue;
    if (typeof manifestSeo['manifest-metadata-site-settings-forceUpgrade'] !== 'undefined') {
      forceUpgradeValue = manifestSeo['manifest-metadata-site-settings-forceUpgrade'];
    }
    else if (typeof body['forceUpgrade'] !== 'undefined') {
      forceUpgradeValue = body['forceUpgrade'];
    }
    if (typeof forceUpgradeValue !== 'undefined') {
      site.manifest.metadata.site.settings.forceUpgrade = filter_var(
        forceUpgradeValue,
        'FILTER_VALIDATE_BOOLEAN'
      );
    }

    site.manifest.metadata.site.version = await HAXCMS.getHAXCMSVersion();
  }
  module.exports = saveManifest;