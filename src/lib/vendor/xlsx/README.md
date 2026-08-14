# Vendored SheetJS (xlsx) — Security Patch

**Version:** 0.20.3
**Source:** https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
**Vendored:** 2026-08-14

## Why this is vendored

The `xlsx` package on npm is stuck at `0.18.5`, which has known
prototype-pollution and ReDoS vulnerabilities with **no npm fix available**
(SheetJS moved distribution to their own CDN after 0.18.5).

This vendored copy is the patched `0.20.3` release from the official SheetJS CDN,
which resolves those vulnerabilities. It replaces the former `xlsx` npm
dependency entirely.

## Security finding addressed

- **DF1** — `xlsx@0.18.5` HIGH (prototype pollution + ReDoS) used on
  authenticated file uploads at:
  - `src/systemRoutes/v1/routes/importXlsx.js` (`XLSX.read`)
  - `src/systemRoutes/v1/routes/convertXlsxToCsv.js` (`XLSX.read`)

## Files

- `xlsx.js` — CJS entry point (the `main`/`require` export from the package)
- `dist/cpexcel.js` — codepage table (runtime `require('./dist/cpexcel.js')`
  dependency of `xlsx.js`)
- `LICENSE` — Apache-2.0 (SheetJS)

## Build handling

`babel.config.js` ignores `./src/lib/vendor/xlsx/**/*` so babel does NOT
transpile these pre-built bundles. The `--copy-files` flag in the `build`
script copies them to `dist/lib/vendor/xlsx/` as-is (same precedent as the
existing `pptx-in-html-out` vendor directory).

## Updating

To update to a newer SheetJS release:

```bash
# Download the new tarball from https://cdn.sheetjs.com/
curl -sL -o /tmp/xlsx.tgz https://cdn.sheetjs.com/xlsx-<version>/xlsx-<version>.tgz
tar -xzf /tmp/xlsx.tgz -C /tmp/sheetjs-upgrade
cp /tmp/sheetjs-upgrade/package/xlsx.js src/lib/vendor/xlsx/xlsx.js
cp /tmp/sheetjs-upgrade/package/dist/cpexcel.js src/lib/vendor/xlsx/dist/cpexcel.js
cp /tmp/sheetjs-upgrade/package/LICENSE src/lib/vendor/xlsx/LICENSE
# Update the version number in this README.
# Smoke-test: node -e "const X=require('./src/lib/vendor/xlsx/xlsx.js'); console.log(X.version)"
```
