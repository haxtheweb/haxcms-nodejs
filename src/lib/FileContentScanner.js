'use strict';

const FilesDataStore = require('./FilesDataStore.js');

// Extract file references from saved page HTML (Phase 2, issue #3043).
//
// extractFileReferences(html) returns the deduped set of 'files/...' paths
// found in src, href, source, and poster attributes, ignoring external URLs
// and non-files paths. Used on page save to rebuild page.metadata.files as a
// uuid-string array via FilesDataStore.resolveUuidByPath.
//
// HAX media elements use different attributes for the file reference:
//   img / a11y-gif-player  -> src
//   a (link)               -> href
//   media-image            -> source
//   video-player           -> source (and poster for the poster frame)
// The scanner matches all of these so media-image/video-player file refs are
// tracked, not just img/a links.
class FileContentScanner {
  // Extract deduped files/... paths from HTML src, href, source, and poster
  // attributes.
  //
  // Only relative paths starting with 'files/' (after stripping a leading
  // basePath or './') are returned. External URLs (http://, https://, //,
  // data:, etc.) and non-files paths are ignored. Query strings and
  // fragments are stripped so the same file referenced with different
  // cache-busters dedupes to one path.
  static extractFileReferences(html) {
    const htmlStr = String(html || '');
    if (htmlStr === '') {
      return [];
    }
    // Collect every src="...", href="...", source="...", and poster="..."
    // value. Match single and double-quoted attribute values
    // (case-insensitive tag/attr names). source= covers media-image and
    // video-player; poster= covers video-player poster frames.
    const regex = /\b(?:src|href|source|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    const paths = [];
    let match;
    while ((match = regex.exec(htmlStr)) !== null) {
      const value = match[1] !== undefined && match[1] !== '' ? match[1] : (match[2] || '');
      const normalized = FileContentScanner.normalizeFileReference(value);
      if (normalized !== '') {
        paths.push(normalized);
      }
    }
    // Dedupe preserving first-seen order.
    const deduped = [];
    for (let i = 0; i < paths.length; i++) {
      if (deduped.indexOf(paths[i]) === -1) {
        deduped.push(paths[i]);
      }
    }
    return deduped;
  }

  // Normalize a single src/href/source/poster value into a canonical
  // 'files/...' path.
  //
  // Strips query strings, fragments, leading './', and leading basePath
  // segments so that absolute-ish site URLs still resolve to the files/
  // relative path. Returns '' for external URLs and non-files paths.
  static normalizeFileReference(value) {
    let v = String(value || '');
    if (v === '') {
      return '';
    }
    // Strip query string and fragment.
    const qIndex = v.indexOf('?');
    if (qIndex !== -1) {
      v = v.substring(0, qIndex);
    }
    const hashIndex = v.indexOf('#');
    if (hashIndex !== -1) {
      v = v.substring(0, hashIndex);
    }
    if (v === '') {
      return '';
    }
    // Reject external URLs: anything with a scheme, or protocol-relative
    // (//), or data: URIs.
    if (/^[a-z][a-z0-9+.\-]*:/i.test(v) || v.indexOf('//') === 0) {
      return '';
    }
    // Normalize backslashes and trim.
    v = v.split('\\').join('/');
    v = v.replace(/^\/+/, '');
    // Strip leading './' segments.
    while (v.indexOf('./') === 0) {
      v = v.substring(2);
    }
    // If the path contains a sitesDirectory/<siteName>/files/ prefix
    // (e.g. _sites/mysite/files/banner.jpg), reduce to files/banner.jpg.
    const filesPos = v.indexOf('files/');
    if (filesPos > 0) {
      const before = v.substring(0, filesPos);
      // Only strip if the preceding segment chain looks like a site
      // path (no other 'files/' in before).
      if (before.indexOf('files/') === -1) {
        v = v.substring(filesPos);
      }
    }
    // Must start with 'files/'.
    if (v.indexOf('files/') !== 0) {
      return '';
    }
    // Reject traversal attempts.
    if (v.indexOf('..') !== -1 || v.indexOf('\0') !== -1) {
      return '';
    }
    return v;
  }

  // Rebuild page.metadata.files as a deduped uuid-string array from a
  // content path-scan. For each files/... path found in the HTML, resolve
  // it to a uuid via FilesDataStore.resolveUuidByPath (upserting unknown
  // paths first with the deterministic uuid at first ingest). A file
  // removed from the content drops out of the set automatically.
  // Async because resolveUuidByPath uses sharp for image dimensions.
  static async rebuildPageFilesUuids(site, page, html) {
    const paths = FileContentScanner.extractFileReferences(html);
    const uuids = [];
    if (paths.length > 0) {
      const dataStore = new FilesDataStore(site);
      for (let i = 0; i < paths.length; i++) {
        const uuid = await dataStore.resolveUuidByPath(paths[i]);
        if (uuid !== '' && uuids.indexOf(uuid) === -1) {
          uuids.push(uuid);
        }
      }
    }
    if (!page || typeof page !== 'object') {
      return uuids;
    }
    if (!page.metadata || typeof page.metadata !== 'object') {
      page.metadata = {};
    }
    page.metadata.files = uuids;
    return uuids;
  }
}

module.exports = FileContentScanner;
