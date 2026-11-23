// Serves a site's site.json from a compressed copy kept in memory.
//
// site.json is fetched on every page load and only changes when someone
// saves, but the compression middleware compressed it again for every
// request (about 6 ms of CPU for a 1,000 page site, more as sites grow).
// Here the compressed bytes are kept per file and encoding, and reused until
// the file's size or modified time changes.
//
// trySend() answers the request itself only when it can do so exactly as
// res.sendFile would (same validators, same 304s); in every other case it
// returns false and the caller sends the file the usual way.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// below this the compression middleware does not compress either
const MIN_BYTES = 1024;
// a site.json bigger than this is sent the usual way (streamed)
const MAX_FILE_BYTES = 32 * 1024 * 1024;
// compressed bytes kept in memory across all files
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

// absolute path -> { size, mtimeMs, encodings: { br|gzip: Promise<Buffer> } }
const entries = new Map();
let cachedBytes = 0;

function isCacheableRequestPath(decodedPath = "") {
  return /(^|\/)site\.json$/.test(String(decodedPath || ""));
}

// the encoding to answer with, or "" when the client accepts neither
function pickEncoding(acceptEncoding = "") {
  const accepted = {};
  String(acceptEncoding || "")
    .toLowerCase()
    .split(",")
    .forEach((part) => {
      const pieces = part.trim().split(";");
      const name = pieces[0].trim();
      if (name === "") {
        return;
      }
      let q = 1;
      for (let i = 1; i < pieces.length; i++) {
        const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(pieces[i]);
        if (match) {
          q = parseFloat(match[1]);
        }
      }
      accepted[name] = q;
    });
  if (accepted.br > 0) {
    return "br";
  }
  if (accepted.gzip > 0) {
    return "gzip";
  }
  return "";
}

// the validator res.sendFile (send) sets for a file
function statEtag(stat) {
  return (
    'W/"' +
    stat.size.toString(16) +
    "-" +
    stat.mtime.getTime().toString(16) +
    '"'
  );
}

function isNotModified(req, etag, stat) {
  const noneMatch = req.headers["if-none-match"];
  if (typeof noneMatch === "string" && noneMatch !== "") {
    if (noneMatch.trim() === "*") {
      return true;
    }
    const wanted = etag.replace(/^W\//, "");
    return noneMatch.split(",").some((candidate) => {
      return candidate.trim().replace(/^W\//, "") === wanted;
    });
  }
  const modifiedSince = req.headers["if-modified-since"];
  if (typeof modifiedSince === "string" && modifiedSince !== "") {
    const since = Date.parse(modifiedSince);
    if (!isNaN(since)) {
      return Math.floor(stat.mtime.getTime() / 1000) * 1000 <= since;
    }
  }
  return false;
}

function dropEntry(filePath) {
  const entry = entries.get(filePath);
  if (!entry) {
    return;
  }
  cachedBytes -= entry.bytes;
  entries.delete(filePath);
}

function compress(encoding, source) {
  if (encoding === "br") {
    return brotliCompress(source, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    });
  }
  return gzip(source);
}

async function getCompressed(filePath, stat, encoding) {
  let entry = entries.get(filePath);
  if (entry && (entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs)) {
    dropEntry(filePath);
    entry = null;
  }
  if (!entry) {
    entry = { size: stat.size, mtimeMs: stat.mtimeMs, encodings: {}, bytes: 0 };
    entries.set(filePath, entry);
  }
  if (!entry.encodings[encoding]) {
    // one compression per file and encoding, shared by requests that arrive
    // while it runs
    entry.encodings[encoding] = (async () => {
      const source = await fs.promises.readFile(filePath);
      // the file changed while it was read: this copy must not be kept
      if (source.length !== stat.size) {
        throw new Error("file changed while reading");
      }
      const compressed = await compress(encoding, source);
      if (entries.get(filePath) === entry) {
        entry.bytes += compressed.length;
        cachedBytes += compressed.length;
        // oldest files go first when the memory cap is passed
        for (const oldest of entries.keys()) {
          if (cachedBytes <= MAX_CACHE_BYTES || oldest === filePath) {
            break;
          }
          dropEntry(oldest);
        }
      }
      return compressed;
    })();
    entry.encodings[encoding].catch(() => {
      if (entries.get(filePath) === entry) {
        delete entry.encodings[encoding];
      }
    });
  }
  return entry.encodings[encoding];
}

/**
 * Answer a GET for site.json from the compressed copy. Resolves true when the
 * response was sent, false when the caller should send the file itself.
 * rootPath and decodedPath are what the caller would pass to res.sendFile.
 */
async function trySend(req, res, rootPath, decodedPath) {
  try {
    if (
      !req ||
      req.method !== "GET" ||
      req.headers.range ||
      !isCacheableRequestPath(decodedPath) ||
      String(decodedPath).indexOf("\0") !== -1
    ) {
      return false;
    }
    const encoding = pickEncoding(req.headers["accept-encoding"]);
    if (encoding === "") {
      return false;
    }
    // same containment res.sendFile applies: no dot segments, inside root
    const segments = String(decodedPath).split(/[\\/]+/);
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === ".." || segments[i].charAt(0) === ".") {
        return false;
      }
    }
    const root = path.resolve(String(rootPath || ""));
    const filePath = path.resolve(
      root,
      "." + path.sep + segments.join(path.sep),
    );
    if (!filePath.startsWith(root + path.sep)) {
      return false;
    }
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size < MIN_BYTES || stat.size > MAX_FILE_BYTES) {
      return false;
    }
    const etag = statEtag(stat);
    const compressed = await getCompressed(filePath, stat, encoding);
    if (res.headersSent) {
      return true;
    }
    if (!res.getHeader("Cache-Control")) {
      res.setHeader("Cache-Control", "public, max-age=0");
    }
    res.setHeader("Last-Modified", stat.mtime.toUTCString());
    res.setHeader("ETag", etag);
    res.vary("Accept-Encoding");
    if (isNotModified(req, etag, stat)) {
      res.removeHeader("Content-Type");
      res.status(304).end();
      return true;
    }
    res.setHeader("Content-Encoding", encoding);
    res.setHeader("Content-Length", compressed.length);
    res.end(compressed);
    return true;
  } catch {
    // anything unexpected (missing file, read error): the usual path decides
    return false;
  }
}

function resetForTesting() {
  entries.clear();
  cachedBytes = 0;
}

module.exports = {
  trySend,
  pickEncoding,
  isCacheableRequestPath,
  resetForTesting,
  stats: () => ({ files: entries.size, bytes: cachedBytes }),
};
