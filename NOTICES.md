# NOTICES

Copyright 2024 The Pennsylvania State University

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at http://www.apache.org/licenses/LICENSE-2.0

This file records third-party attributions and dual-license elections for
`@haxtheweb/haxcms-nodejs`. It is maintained alongside `LICENSE.md` and should be
updated whenever a dependency with obligations beyond simple permissive
attribution is added, removed, or changes license.

## Project license

Apache-2.0 — see `LICENSE.md`.

## Dual-license elections

Several dependencies are offered under more than one license. This project
elects the permissive option for each, as recorded below. Each election applies
to use, reproduction, and distribution of the combined work by this project and
its downstream consumers. The non-elected alternative is listed for clarity and
must not be relied upon.

### dompurify@3.4.11 — `(MPL-2.0 OR Apache-2.0)` → **Apache-2.0 elected**

- **Elected:** Apache-2.0 (permissive).
- **Not elected:** MPL-2.0 (weak copyleft, file-level).
- **Obligation under the election:** Retain the Apache-2.0 license text and
  attribution (the package ships its own `LICENSE`). Apache-2.0 patent grant
  applies.
- **Condition:** Do not modify dompurify source and distribute the result. If
  the MPL-2.0 branch is ever taken (e.g. by modifying and distributing its
  files), file-level copyleft applies to the modified files and the MPL terms
  must be satisfied separately.
- **Role:** Direct production dependency (HTML sanitization, security-critical).
- **Upstream:** https://github.com/cure53/DOMPurify

### jszip@3.10.1 — `(MIT OR GPL-3.0-or-later)` → **MIT elected**

- **Elected:** MIT (permissive).
- **Not elected:** GPL-3.0-or-later (strong copyleft).
- **Obligation under the election:** Retain the copyright notice and permission
  notice (the package ships `LICENSE.markdown`, which states "dual licensed…
  MIT or GPLv3").
- **Condition:** The GPL-3.0-or-later branch is not elected and must not be
  relied upon. If it were ever elected, strong-copyleft source-disclosure
  obligations would attach to distribution of the combined work.
- **Role:** Transitive production dependency (reached via `epub-gen-memory`,
  `html-to-docx`, `mammoth`).
- **Upstream:** https://github.com/Stuk/jszip

## Weak-copyleft and bundled-native dependencies (note for distribution)

The following are not license problems for the project's SaaS/hosted deployment
(no conveyance), but they carry obligations that attach on **distribution** of a
build that bundles `node_modules` (e.g. a Docker image, an on-prem package, or a
desktop app bundle). Review before any such distribution.

### sharp@0.32.6 + vendored libvips 8.14.5

- **sharp (JS):** Apache-2.0.
- **Vendored native bundle:** sharp installs a prebuilt `libvips-cpp.so.42`
  that bundles libraries under **LGPL-3.0-or-later** (libvips, glib, pango,
  gdk-pixbuf, librsvg, libheif, libexif, fribidi, proxy-libintl) and
  **MPL-2.0** (cairo). The "any later version" clause of the upstream LGPL-2.x
  licenses yields an effective `LGPL-3.0-or-later`.
- **SaaS (no conveyance):** no LGPL/MPL obligation triggered.
- **Distribution:** LGPL-3.0-or-later requires a written source-offer for the
  bundled libs, a user-replaceable-library notice, a prominent LGPL notice, and
  allowance for reverse engineering for interoperation; MPL-2.0 requires
  file-level handling if cairo files are modified.
- **Upstream notices/source:** sharp ships
  `node_modules/sharp/vendor/<version>/<platform>/THIRD-PARTY-NOTICES.md`
  (the authoritative bundled-library notice and license table). libvips and the
  bundled libraries' source is published at
  https://github.com/lovell/sharp-libvips — use that as the source-offer
  pointer for unmodified builds.
- **Upstream:** https://github.com/lovell/sharp

### axe-core@4.12.1 — MPL-2.0 (devDependency only)

- **Classification:** Weak copyleft, file-level (MPL-2.0).
- **Role:** devDependency (e2e accessibility tests). Not shipped to end users.
- **Condition:** Unmodified use + SaaS/internal → no obligation. If axe-core
  files are modified and distributed, those files must be shared under MPL-2.0.
  Its bundled third-party code is MIT (`LICENSE-3RD-PARTY.txt`).
- **Upstream:** https://github.com/dequelabs/axe-core

## Other notable third-party attributions

### xlsx@0.18.5 — Apache-2.0 (SheetJS)

- **License:** Apache-2.0 (clean). Used by the `xlsx-to-csv` system action.
- **Maintenance note (not a license issue):** SheetJS 0.18.5 is the last
  version published to the public npm registry; newer builds live on the
  SheetJS CDN. Track as a security/maintenance migration item, not a license
  one.
- **Upstream:** https://github.com/SheetJS/sheetjs

### gitconfiglocal@1.0.0 — BSD-3-Clause (devDependency only)

- **License:** BSD-3-Clause (confirmed upstream).
- **Role:** devDependency (reached via `commit-and-tag-version`). Not shipped to
  end users.
- **Obligation (if ever distributed):** retain copyright notice, conditions, and
  disclaimer; no endorsement of derived products.
- **Upstream:** https://github.com/soldair/node-gitconfiglocal

## Full dependency license set

The complete dependency list and per-package license metadata are available via
`npm ls --long` and in `package-lock.json` (gitignored in this repo; regenerated
locally from `package.json`). The vast majority of the ~845 packages are
permissive: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0, and
public-domain dedications (CC0-1.0, Unlicense, 0BSD). No AGPL, no standalone
GPL, and no non-OSI source-available licenses (SSPL, BUSL, Elastic License,
Commons Clause, Confluent Community) are present in the tree.

## About this file

This is an engineering-prepared attribution and election record, maintained by
the project. It is not legal advice and creates no attorney-client relationship.
For any decision involving copyleft distribution (notably the sharp/libvips
LGPL-3.0-or-later bundle) or a contested license question, obtain independent
legal review before distributing the affected build.
