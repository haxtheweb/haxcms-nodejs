# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [26.11.0](https://github.com/haxtheweb/haxcms-nodejs/compare/v26.8.1...v26.11.0) (2026-11-24)

### Features

- **api:** publish the MCP policy in system discovery ([4fe360c](https://github.com/haxtheweb/haxcms-nodejs/commit/4fe360c57758c4fcb3c8ddf80b107e2b3ff66ecb)), closes [haxtheweb/issues#3140](https://github.com/haxtheweb/issues/issues/3140)
- **auth:** HAXCMS_MAGIC_LINK_DISABLED as a hard system-level off switch ([#2854](https://github.com/haxtheweb/haxcms-nodejs/issues/2854)) ([321f902](https://github.com/haxtheweb/haxcms-nodejs/commit/321f9022cbda5b1e9a43f4da36ff3c9e215cbc40))
- **auth:** magic links honour the HAXiam IAM marker ([#2854](https://github.com/haxtheweb/haxcms-nodejs/issues/2854)) ([59fcbd5](https://github.com/haxtheweb/haxcms-nodejs/commit/59fcbd553aa5175692ceba9e9b5fea3f781a700f))
- **auth:** one-time sign-in links for account recovery ([#2854](https://github.com/haxtheweb/haxcms-nodejs/issues/2854)) ([05645f0](https://github.com/haxtheweb/haxcms-nodejs/commit/05645f0d7c7954e2f670c56ffd39243e95bcfa78))
- **auth:** one-time sign-in links off by default on HAXiam ([#2854](https://github.com/haxtheweb/haxcms-nodejs/issues/2854)) ([306d6fb](https://github.com/haxtheweb/haxcms-nodejs/commit/306d6fbf93aa6f5f89fa5cc448ef8e510a721d61))
- group licenses and add CC0, public domain and software licenses ([0031745](https://github.com/haxtheweb/haxcms-nodejs/commit/0031745bcba37d386cba101c6c3fa2cd7d463212))
- **import:** add an OpenStax textbook importer ([9a5e453](https://github.com/haxtheweb/haxcms-nodejs/commit/9a5e453f2eef871b6f2150cd1c79a91dc686d4c4)), closes [haxtheweb/issues#2912](https://github.com/haxtheweb/issues/issues/2912) [haxtheweb/issues#3060](https://github.com/haxtheweb/issues/issues/3060)
- **import:** ingest OpenStax images as file entities ([65cbb03](https://github.com/haxtheweb/haxcms-nodejs/commit/65cbb03972885c9ec6ba70b48dde0eb8077066a2)), closes [haxtheweb/issues#2912](https://github.com/haxtheweb/issues/issues/2912) [#40](https://github.com/haxtheweb/haxcms-nodejs/issues/40) [haxtheweb/issues#3043](https://github.com/haxtheweb/issues/issues/3043)
- **import:** make sites and pages from .md, .txt and .odt files ([b45f54f](https://github.com/haxtheweb/haxcms-nodejs/commit/b45f54f234d712cddefbd5260c0bc963a688ba15))
- Quarto importer (@system/quartoToSite) for [#2189](https://github.com/haxtheweb/haxcms-nodejs/issues/2189) ([af1b3ec](https://github.com/haxtheweb/haxcms-nodejs/commit/af1b3ec809aa1d742b6963b371eba234cf8b7c03))
- Quarto importer reads the source license and reports notices ([0262597](https://github.com/haxtheweb/haxcms-nodejs/commit/0262597d9a70abc03bea22c3bad5cdc6ef4d4807))
- **scripts:** ui:inventory page fixture, measure and viewport-height options ([6557139](https://github.com/haxtheweb/haxcms-nodejs/commit/65571391d08764849d1bc7433c4473bf2c333b0a)), closes [haxtheweb/issues#3234](https://github.com/haxtheweb/issues/issues/3234)
- **scripts:** ui:inventory, a generated ground truth of the editor and admin UI ([9cab6eb](https://github.com/haxtheweb/haxcms-nodejs/commit/9cab6eb4e430841318724e36783a4f839a5bc3ff)), closes [haxtheweb/issues#3234](https://github.com/haxtheweb/issues/issues/3234)
- **ssr:** server-side rendering kit (inert DOM, skip list, haxHooks fallback, primitives) ([ce21c97](https://github.com/haxtheweb/haxcms-nodejs/commit/ce21c979ef7cee7add125d38ca16af748381004c))

### Bug Fixes

- **auth:** a switched-off magic-link endpoint looks like a route that doesn't exist ([#2854](https://github.com/haxtheweb/haxcms-nodejs/issues/2854)) ([d79cd2d](https://github.com/haxtheweb/haxcms-nodejs/commit/d79cd2d733feae04560164856a3d0e33b92c7b26))
- **auth:** align magic-link route with current main ([#2854](https://github.com/haxtheweb/haxcms-nodejs/issues/2854)) ([6526068](https://github.com/haxtheweb/haxcms-nodejs/commit/6526068395ebf331775baa95b1c94e31c896f79f))
- **auth:** magic links work in real browsers; review hardening ([#2854](https://github.com/haxtheweb/haxcms-nodejs/issues/2854)) ([efefd12](https://github.com/haxtheweb/haxcms-nodejs/commit/efefd12d8b16955697b18ce377545aee1cf3714c))
- **config:** default MCP to disabled on every deployment profile ([116ebff](https://github.com/haxtheweb/haxcms-nodejs/commit/116ebffc9837cdb6af79b5d43572851d838600a3)), closes [haxtheweb/issues#3140](https://github.com/haxtheweb/issues/issues/3140)
- **createNode:** answer 400 when items create nothing; drop dead itemSelectorList ([bc7ffea](https://github.com/haxtheweb/haxcms-nodejs/commit/bc7ffeafca909956c7281b10975160f398a5f77e)), closes [haxtheweb/issues#3285](https://github.com/haxtheweb/issues/issues/3285)
- **createSite:** accept remote URLs in build.files again ([98e1cac](https://github.com/haxtheweb/haxcms-nodejs/commit/98e1cacc47a219b623c202f7412df7adaec7d825)), closes [haxtheweb/issues#3060](https://github.com/haxtheweb/issues/issues/3060) [#2970](https://github.com/haxtheweb/haxcms-nodejs/issues/2970)
- **docker:** modernize standalone site Dockerfiles and publish platform image ([#2814](https://github.com/haxtheweb/haxcms-nodejs/issues/2814)) ([90df28a](https://github.com/haxtheweb/haxcms-nodejs/commit/90df28a09ddc896573c3c003e0cbd7ac118aca65))
- **downloadSite:** leave symlinks out of the site zip ([a9167b0](https://github.com/haxtheweb/haxcms-nodejs/commit/a9167b06eadfea1891943ac93b7e05df8402616b))
- failed downloads never leave a partial file; resync agent-skills digest ([511bda9](https://github.com/haxtheweb/haxcms-nodejs/commit/511bda9419ffb6059c15ff5d122a1bf7e302563e))
- **filter_var:** fail FILTER_VALIDATE_REGEXP when no regexp option is given ([0e70156](https://github.com/haxtheweb/haxcms-nodejs/commit/0e70156b5c8877e274b28a2fcd944025141a707d))
- **import:** odt emptiness check reads text between tags without a strip regex ([040b6d5](https://github.com/haxtheweb/haxcms-nodejs/commit/040b6d58246e19de73d7a96264243030159eea74))
- **import:** render imported images as media-image and track their uuids ([9f88df0](https://github.com/haxtheweb/haxcms-nodejs/commit/9f88df0dc58737da736663dd5266cec23ac0788d)), closes [#39](https://github.com/haxtheweb/haxcms-nodejs/issues/39)
- **import:** sanitize untrusted HTML with the shared allowlist sanitizer; escape DOCX placeholder output ([beca9cb](https://github.com/haxtheweb/haxcms-nodejs/commit/beca9cb488fc17e19c68e7499624166bf815fac4)), closes [#252](https://github.com/haxtheweb/haxcms-nodejs/issues/252) [#270](https://github.com/haxtheweb/haxcms-nodejs/issues/270) [-#273](https://github.com/haxtheweb/-/issues/273)
- **import:** save inline docx images as site files ([7a238dd](https://github.com/haxtheweb/haxcms-nodejs/commit/7a238ddd5ab81f20715e84f0dc094db74f673d02)), closes [haxtheweb/issues#2945](https://github.com/haxtheweb/issues/issues/2945)
- **import:** take imported file identity from FileEntity ([5517a52](https://github.com/haxtheweb/haxcms-nodejs/commit/5517a52ac9d1a9180c647e75c32324b2798fe531)), closes [#39](https://github.com/haxtheweb/haxcms-nodejs/issues/39)
- **sanitize:** don't throw when jsdom teardown hits an iframe in SVG content ([211ba01](https://github.com/haxtheweb/haxcms-nodejs/commit/211ba010cbd612b80de141f405eedbb8b463cdf7))
- **scripts:** ui:inventory pins HAX's saved dark mode to each capture's scheme ([68bece3](https://github.com/haxtheweb/haxcms-nodejs/commit/68bece31ab3fe34d64ee69a378d0678d96c5c46d))
- **search:** replace every newline in cleanSearchData ([96d949d](https://github.com/haxtheweb/haxcms-nodejs/commit/96d949d4f1633ff7816b36748deaf0ff1d05fbdc)), closes [#398](https://github.com/haxtheweb/haxcms-nodejs/issues/398)
- **security:** block .git exposure via .well-known and harden local mode ([4d7e002](https://github.com/haxtheweb/haxcms-nodejs/commit/4d7e002649bc8bc49a1ecd268020208b541eab6b))
- **security:** sanitise request metadata in itemFromParams (PHP parity) ([805f300](https://github.com/haxtheweb/haxcms-nodejs/commit/805f30079288f9c6160bee83b1c6bc497e18247e)), closes [haxtheweb/haxcms-php#704](https://github.com/haxtheweb/haxcms-php/issues/704)
- slugs never start with "/"; writeLocation creates missing page files, refuses directories ([48b3869](https://github.com/haxtheweb/haxcms-nodejs/commit/48b3869b324ec25622edb77b7f7fce6c2e841b99))

## [26.8.1](https://github.com/haxtheweb/haxcms-nodejs/compare/v26.0.1...v26.8.1) (2026-08-14)

### Bug Fixes

- **api-conformance:** align spec, tests, and media settings reads ([6642abf](https://github.com/haxtheweb/haxcms-nodejs/commit/6642abf0fcc17c779ba019b4ee4a18a7ea87fd4c))
- **pptx:** exclude pptx-in-html-out vendor package from babel transpilation ([6227e66](https://github.com/haxtheweb/haxcms-nodejs/commit/6227e66e59ec31b682ef06accedb063be79d1c0d))

## [26.0.0](https://github.com/haxtheweb/haxcms-nodejs/compare/v26.0.1...v26.0.0) (2026-08-14)

### Bug Fixes

- **api-conformance:** align spec, tests, and media settings reads ([6642abf](https://github.com/haxtheweb/haxcms-nodejs/commit/6642abf0fcc17c779ba019b4ee4a18a7ea87fd4c))
- **pptx:** exclude pptx-in-html-out vendor package from babel transpilation ([6227e66](https://github.com/haxtheweb/haxcms-nodejs/commit/6227e66e59ec31b682ef06accedb063be79d1c0d))

## [26.0.1](https://github.com/haxtheweb/haxcms-nodejs/compare/v26.0.0...v26.0.1) (2026-05-21)

## [26.0.0](https://github.com/haxtheweb/haxcms-nodejs/compare/v25.0.0...v26.0.0) (2026-05-12)

## [25.0.0](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.15...v25.0.0) (2026-01-09)

## [11.0.15](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.14...v11.0.15) (2025-07-24)

## [11.0.14](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.13...v11.0.14) (2025-07-23)

## [11.0.13](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.12...v11.0.13) (2025-07-21)

## [11.0.12](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.11...v11.0.12) (2025-07-21)

## [11.0.11](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.10...v11.0.11) (2025-07-21)

## [11.0.10](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.9...v11.0.10) (2025-07-21)

## [11.0.9](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.8...v11.0.9) (2025-07-21)

## [11.0.8](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.7...v11.0.8) (2025-07-21)

## [11.0.7](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.6...v11.0.7) (2025-07-21)

## [11.0.6](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.5...v11.0.6) (2025-07-11)

## [11.0.5](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.4...v11.0.5) (2025-06-18)

## [11.0.4](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.3...v11.0.4) (2025-06-10)

## [11.0.3](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.2...v11.0.3) (2025-06-09)

## [11.0.2](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.1...v11.0.2) (2025-06-06)

## [11.0.1](https://github.com/haxtheweb/haxcms-nodejs/compare/v11.0.0...v11.0.1) (2025-06-06)

## [11.0.0](https://github.com/haxtheweb/haxcms-nodejs/compare/v10.0.6...v11.0.0) (2025-06-06)

## [10.0.6](https://github.com/haxtheweb/haxcms-nodejs/compare/v10.0.5...v10.0.6) (2025-04-07)

## [10.0.5](https://github.com/haxtheweb/haxcms-nodejs/compare/v10.0.4...v10.0.5) (2025-04-03)

## [10.0.4](https://github.com/haxtheweb/haxcms-nodejs/compare/v10.0.3...v10.0.4) (2025-03-07)

## [10.0.3](https://github.com/haxtheweb/haxcms-nodejs/compare/v10.0.2...v10.0.3) (2025-02-24)

## [10.0.2](https://github.com/haxtheweb/haxcms-nodejs/compare/v10.0.1...v10.0.2) (2025-01-31)

## [10.0.1](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.21...v10.0.1) (2024-12-20)

## [9.0.21](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.20...v9.0.21) (2024-12-17)

## [9.0.20](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.19...v9.0.20) (2024-11-26)

## [9.0.19](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.18...v9.0.19) (2024-11-26)

## [9.0.18](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.17...v9.0.18) (2024-11-18)

## [9.0.17](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.16...v9.0.17) (2024-11-15)

## [9.0.16](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.15...v9.0.16) (2024-11-15)

## [9.0.15](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.14...v9.0.15) (2024-10-29)

## [9.0.14](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.13...v9.0.14) (2024-10-24)

## [9.0.13](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.12...v9.0.13) (2024-10-23)

## [9.0.12](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.11...v9.0.12) (2024-10-21)

## [9.0.11](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.10...v9.0.11) (2024-10-07)

## [9.0.10](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.9...v9.0.10) (2024-10-07)

## [9.0.9](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.8...v9.0.9) (2024-10-07)

## [9.0.8](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.7...v9.0.8) (2024-10-04)

## [9.0.7](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.6...v9.0.7) (2024-09-25)

## [9.0.6](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.5...v9.0.6) (2024-08-22)

## [9.0.5](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.4...v9.0.5) (2024-08-03)

## [9.0.4](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.3...v9.0.4) (2024-08-03)

## [9.0.3](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.2...v9.0.3) (2024-07-30)

## [9.0.2](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.1...v9.0.2) (2024-07-24)

## [9.0.1](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.0...v9.0.1) (2024-07-22)

## [9.0.0](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.0-alpha.1...v9.0.0) (2024-07-12)

## [9.0.0-alpha.1](https://github.com/haxtheweb/haxcms-nodejs/compare/v9.0.0-alpha.0...v9.0.0-alpha.1) (2024-06-28)

## [9.0.0-alpha.0](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.19...v9.0.0-alpha.0) (2024-06-28)

## [0.0.19](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.18...v0.0.19) (2024-06-28)

## [0.0.18](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.17...v0.0.18) (2024-06-28)

## [0.0.17](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.16...v0.0.17) (2024-06-28)

## [0.0.16](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.15...v0.0.16) (2024-06-28)

## [0.0.15](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.14...v0.0.15) (2024-06-24)

## [0.0.14](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.13...v0.0.14) (2024-06-21)

## [0.0.13](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.12...v0.0.13) (2024-06-21)

## [0.0.12](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.11...v0.0.12) (2024-06-20)

## [0.0.11](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.10...v0.0.11) (2024-06-20)

## [0.0.10](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.9...v0.0.10) (2024-06-20)

## [0.0.9](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.8...v0.0.9) (2024-06-18)

## [0.0.8](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.7...v0.0.8) (2024-06-18)

## [0.0.7](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.6...v0.0.7) (2024-06-18)

## [0.0.6](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.5...v0.0.6) (2024-06-18)

## [0.0.5](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.4...v0.0.5) (2024-06-18)

## [0.0.4](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.3...v0.0.4) (2024-06-18)

## [0.0.3](https://github.com/haxtheweb/haxcms-nodejs/compare/v0.0.2...v0.0.3) (2024-06-17)

## 0.0.2 (2024-06-17)
