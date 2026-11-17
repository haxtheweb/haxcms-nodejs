/**
 * Image framing: one photo framed for each screen size
 * (haxtheweb/issues#2976).
 *
 * Elements that frame a photo (the tags in FRAMING_TAGS) are served from
 * files cut when the page is saved, under files/haxcms-managed/framing/:
 *
 * - width variants of the original, for the sizes left automatic:
 *   <stem>-full-<w>w.<ext> at 600, 1200, 1920 and 2880
 * - each custom framing cut out and sized at 1x and 2x of its screen size:
 *   <stem>-<size>-<fnv1a(key)>-<w>w.<ext>
 *
 * The names are a contract shared with the front end
 * (@haxtheweb/d-d-d/lib/ImageFraming.js) and haxcms-php
 * (system/backend/php/lib/ImageFraming.php); all three test the same golden
 * names. Files are only ever made, never upscaled: a file is named for the
 * width asked for even when the photo is smaller.
 *
 * Security (SEC-PATH): the photo is read and every cut written or removed
 * only through resolveContainedPath, so all of it stays inside the site's
 * directory, and only plain files/ paths with still-image extensions are cut.
 *
 * Stability: a save never does unbounded image work. Only allowlisted tags
 * are cut; the photo's first bytes must be the image type its extension
 * names; photos over FRAMING_MAX_BYTES or FRAMING_MAX_PIXELS are left to the
 * CSS fallback; one save cuts at most FRAMING_MAX_PHOTOS photos and stops
 * starting new files after FRAMING_MAX_SECONDS (the next save carries on,
 * since files already made are kept). When a framing changes, the cuts of
 * that photo no page uses any more are removed, so the folder doesn't grow
 * with every reframing.
 */
const fs = require("fs-extra");
const sharp = require("sharp");
const { parse } = require("node-html-parser");
const { resolveContainedPath } = require("./pathConfinement.js");

const FRAMING_SIZES = Object.freeze([
  Object.freeze({ id: "sm", cut: 600 }),
  Object.freeze({ id: "md", cut: 900 }),
  Object.freeze({ id: "lg", cut: 1440 }),
  Object.freeze({ id: "xl", cut: 1920 }),
]);
const FRAMING_FULL_WIDTHS = Object.freeze([600, 1200, 1920, 2880]);
const FRAMING_FORMATS = Object.freeze(["jpg", "jpeg", "png", "webp"]);
const FRAMING_DIR = "files/haxcms-managed/framing/";
// the only elements whose photos are cut
const FRAMING_TAGS = Object.freeze(["ddd-hero"]);
// limits on the work one save may do
const FRAMING_MAX_PHOTOS = 12;
const FRAMING_MAX_BYTES = 25 * 1024 * 1024;
const FRAMING_MAX_PIXELS = 40000000;
const FRAMING_MAX_SECONDS = 20;
// pages read when looking for cuts still in use; past this nothing is removed
const FRAMING_MAX_PAGES = 5000;

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

function roundFraming(n) {
  return Math.round(n * 1000) / 1000;
}

/** { sizeId: rect } for the well-formed rects in a framing attribute */
function parseFraming(value) {
  let data = value;
  if (typeof value === "string") {
    if (value.trim() === "") return {};
    try {
      data = JSON.parse(value);
    } catch {
      return {};
    }
  }
  const out = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  FRAMING_SIZES.forEach((size) => {
    const r = data[size.id];
    if (
      r &&
      isNum(r.x) &&
      isNum(r.y) &&
      isNum(r.w) &&
      isNum(r.h) &&
      r.w > 0 &&
      r.h > 0 &&
      r.x >= 0 &&
      r.y >= 0 &&
      r.x + r.w <= 1.0005 &&
      r.y + r.h <= 1.0005
    ) {
      out[size.id] = {
        x: roundFraming(r.x),
        y: roundFraming(r.y),
        w: roundFraming(r.w),
        h: roundFraming(r.h),
      };
    }
  });
  return out;
}

/** 32-bit FNV-1a of an ASCII string, as 8 hex digits */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** the rect as it is hashed: 3 decimals, comma separated */
function framingKey(rect) {
  return [rect.x, rect.y, rect.w, rect.h].map((n) => n.toFixed(3)).join(",");
}

/** { stem, ext } for a still image under files/ (not a managed file), else null */
function framingSource(source) {
  if (typeof source !== "string") return null;
  const clean = source.split(/[?#]/)[0];
  const parts = clean.split("/");
  if (parts.length < 2 || parts[0] !== "files") return null;
  if (parts[1] === "haxcms-managed") return null;
  const segment = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
  for (let i = 1; i < parts.length; i++) {
    if (!segment.test(parts[i]) || parts[i].indexOf("..") !== -1) return null;
  }
  const file = parts[parts.length - 1];
  const dot = file.lastIndexOf(".");
  if (dot < 1) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  if (!FRAMING_FORMATS.includes(ext)) return null;
  const stem = parts.slice(1, -1).concat(file.slice(0, dot)).join("--");
  return { stem, ext };
}

function framingFullUrl(source, width) {
  const s = framingSource(source);
  if (!s) return null;
  return `${FRAMING_DIR}${s.stem}-full-${width}w.${s.ext}`;
}

function framingCutUrl(source, sizeId, rect, width) {
  const s = framingSource(source);
  if (!s) return null;
  return `${FRAMING_DIR}${s.stem}-${sizeId}-${fnv1a(framingKey(rect))}-${width}w.${s.ext}`;
}

function framingCutWidths(sizeId) {
  const size = FRAMING_SIZES.find((s) => s.id === sizeId);
  return size ? [size.cut, size.cut * 2] : [];
}

/**
 * Every file the framed photos in this HTML are served from:
 * [{ source, location, width, sizeId?, rect? }], one entry per file.
 * Only the first FRAMING_MAX_PHOTOS photos are planned, unless `limited` is
 * false (used when listing what is in use, never for cutting).
 */
function framingPlan(html, limited) {
  const plan = [];
  const seen = {};
  const photos = {};
  if (typeof html !== "string" || html.indexOf("source") === -1) return plan;
  const root = parse(html);
  root.querySelectorAll("[source]").forEach((el) => {
    const tag = (el.rawTagName || "").toLowerCase();
    const framing = el.getAttribute("framing");
    if (!FRAMING_TAGS.includes(tag)) return;
    const mediaType = el.getAttribute("media-type");
    if (mediaType && mediaType !== "image") return;
    const source = el.getAttribute("source");
    if (!framingSource(source)) return;
    const photo = source.split(/[?#]/)[0];
    if (!photos[photo]) {
      if (
        limited !== false &&
        Object.keys(photos).length >= FRAMING_MAX_PHOTOS
      ) {
        return;
      }
      photos[photo] = true;
    }
    const add = (entry) => {
      if (!seen[entry.location]) {
        seen[entry.location] = true;
        plan.push(entry);
      }
    };
    FRAMING_FULL_WIDTHS.forEach((width) => {
      add({ source, location: framingFullUrl(source, width), width });
    });
    const custom = parseFraming(framing || "");
    FRAMING_SIZES.forEach((size) => {
      const rect = custom[size.id];
      if (!rect) return;
      framingCutWidths(size.id).forEach((width) => {
        add({
          source,
          location: framingCutUrl(source, size.id, rect, width),
          width,
          sizeId: size.id,
          rect,
        });
      });
    });
  });
  return plan;
}

/** the image type a file's first bytes say it is: "jpg", "png", "webp" or null */
function sniffImage(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(12);
    const read = fs.readSync(fd, head, 0, 12, 0);
    if (read >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return "jpg";
    }
    if (
      read >= 8 &&
      head
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return "png";
    }
    if (
      read >= 12 &&
      head.toString("latin1", 0, 4) === "RIFF" &&
      head.toString("latin1", 8, 12) === "WEBP"
    ) {
      return "webp";
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * { width, height } of a photo that may be cut, as it displays (EXIF
 * orientation applied), or null: not a regular file, too big, not the image
 * type its extension names, or unreadable
 */
async function framingPhoto(input, ext) {
  try {
    if (!fs.pathExistsSync(input)) return null;
    const stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.size > FRAMING_MAX_BYTES) return null;
    const type = sniffImage(input);
    if (type === null || type !== (ext === "jpeg" ? "jpg" : ext)) return null;
    // reads the header only
    const info = await sharp(input, {
      failOn: "none",
      limitInputPixels: FRAMING_MAX_PIXELS,
    }).metadata();
    // a turned photo swaps sides once its orientation is applied
    const turned = info.orientation && info.orientation >= 5;
    const width = turned ? info.height : info.width;
    const height = turned ? info.width : info.height;
    if (!width || !height || width * height > FRAMING_MAX_PIXELS) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/** every index.html under pages/ in the site, or null when there are too many */
function framingPageFiles(siteDirectory) {
  const out = [];
  const root = resolveContainedPath(siteDirectory, "pages");
  if (root === false || !fs.pathExistsSync(root)) return out;
  const walk = (dir, depth) => {
    if (depth > 8) return true;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.isSymbolicLink()) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!walk(full, depth + 1)) return false;
      } else if (entry.isFile() && entry.name === "index.html") {
        out.push(full);
        if (out.length > FRAMING_MAX_PAGES) return false;
      }
    }
    return true;
  };
  return walk(root, 0) ? out : null;
}

/**
 * Remove the custom cuts of the photos named by `stems` that no page in the
 * site uses any more. Only files in the framing folder whose names are cuts
 * of those photos are ever removed; width variants of the photo are kept,
 * and so is every location listed in `keep` (the save in hand).
 * Returns the locations removed.
 */
function cleanFramings(siteDirectory, stems, keep) {
  const removed = [];
  const dir = resolveContainedPath(siteDirectory, FRAMING_DIR);
  if (dir === false || !fs.pathExistsSync(dir) || !stems.length) return removed;
  let pages = null;
  try {
    pages = framingPageFiles(siteDirectory);
  } catch {
    pages = null;
  }
  // can't tell what is in use: remove nothing
  if (pages === null) return removed;
  const used = {};
  (keep || []).forEach((location) => {
    used[location] = true;
  });
  for (let i = 0; i < pages.length; i++) {
    let html = "";
    try {
      html = fs.readFileSync(pages[i], "utf8");
    } catch {
      return removed;
    }
    if (html.indexOf("framing") === -1) continue;
    framingPlan(html, false).forEach((entry) => {
      used[entry.location] = true;
    });
  }
  const cutName =
    /^(.+)-(sm|md|lg|xl)-[0-9a-f]{8}-[0-9]+w\.(jpg|jpeg|png|webp)$/;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (!entry.isFile()) return;
    const match = cutName.exec(entry.name);
    if (!match || !stems.includes(match[1])) return;
    const location = FRAMING_DIR + entry.name;
    if (used[location]) return;
    const target = resolveContainedPath(siteDirectory, location);
    if (target === false) return;
    try {
      fs.unlinkSync(target);
      removed.push(location);
    } catch {
      // still there: a later save removes it
    }
  });
  return removed;
}

/**
 * Make the files the framed photos in `html` need, inside `siteDirectory`,
 * within the limits at the top of this file. Files already there are kept; a
 * photo that is missing, too big or not an image is skipped (the element
 * falls back to framing the original in CSS). When a new custom cut is
 * written, that photo's cuts no page uses any more are removed.
 * `options.maxSeconds` overrides FRAMING_MAX_SECONDS. Returns the locations
 * written.
 */
async function cutFramings(siteDirectory, html, options) {
  const written = [];
  const plan = framingPlan(html);
  if (!plan.length) return written;
  const dir = resolveContainedPath(siteDirectory, FRAMING_DIR);
  if (dir === false) return written;
  const maxSeconds =
    options && typeof options.maxSeconds === "number"
      ? options.maxSeconds
      : FRAMING_MAX_SECONDS;
  const deadline = Date.now() + maxSeconds * 1000;
  const photos = {};
  const reframed = [];
  for (let i = 0; i < plan.length; i++) {
    if (Date.now() >= deadline) break;
    const entry = plan[i];
    const input = resolveContainedPath(
      siteDirectory,
      entry.source.split(/[?#]/)[0],
    );
    const target = resolveContainedPath(siteDirectory, entry.location);
    if (input === false || target === false) continue;
    if (fs.pathExistsSync(target)) continue;
    const source = framingSource(entry.source);
    if (photos[input] === undefined) {
      photos[input] = await framingPhoto(input, source.ext);
    }
    const photo = photos[input];
    if (!photo) continue;
    const W = photo.width;
    const H = photo.height;
    try {
      fs.ensureDirSync(dir);
      let pipeline = sharp(input, {
        failOn: "none",
        limitInputPixels: FRAMING_MAX_PIXELS,
      }).rotate();
      if (entry.rect) {
        const left = Math.min(W - 1, Math.round(entry.rect.x * W));
        const top = Math.min(H - 1, Math.round(entry.rect.y * H));
        const width = Math.max(
          1,
          Math.min(W - left, Math.round(entry.rect.w * W)),
        );
        const height = Math.max(
          1,
          Math.min(H - top, Math.round(entry.rect.h * H)),
        );
        pipeline = pipeline.extract({ left, top, width, height });
      }
      await pipeline
        .resize({ width: entry.width, withoutEnlargement: true })
        .toFile(target);
      written.push(entry.location);
      if (entry.rect && !reframed.includes(source.stem)) {
        reframed.push(source.stem);
      }
    } catch {
      // unreadable photo: leave it to the CSS fallback; never leave a
      // half-written file behind to be served
      try {
        fs.removeSync(target);
      } catch {
        // nothing to remove
      }
    }
  }
  if (reframed.length) {
    try {
      cleanFramings(
        siteDirectory,
        reframed,
        plan.map((entry) => entry.location),
      );
    } catch {
      // cleaning up is best effort
    }
  }
  return written;
}

module.exports = {
  FRAMING_SIZES,
  FRAMING_FULL_WIDTHS,
  FRAMING_FORMATS,
  FRAMING_DIR,
  FRAMING_TAGS,
  FRAMING_MAX_PHOTOS,
  FRAMING_MAX_BYTES,
  FRAMING_MAX_PIXELS,
  FRAMING_MAX_SECONDS,
  parseFraming,
  fnv1a,
  framingKey,
  framingSource,
  framingFullUrl,
  framingCutUrl,
  framingCutWidths,
  framingPlan,
  cleanFramings,
  cutFramings,
};
