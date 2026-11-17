/**
 * Image framing: one photo framed for each screen size
 * (haxtheweb/issues#2976).
 *
 * Elements that frame a photo (ddd-hero, or anything carrying a `framing`
 * attribute next to its `source`) are served from files cut when the page is
 * saved, under files/haxcms-managed/framing/:
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
 * Security (SEC-PATH): the photo is read and every cut written only through
 * resolveContainedPath, so both stay inside the site's directory, and only
 * plain files/ paths with still-image extensions are cut at all.
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
// elements that are served from cuts even with every size automatic
const FRAMING_TAGS = Object.freeze(["ddd-hero"]);

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
 * [{ source, location, width, sizeId?, rect? }], one entry per file
 */
function framingPlan(html) {
  const plan = [];
  const seen = {};
  if (typeof html !== "string" || html.indexOf("source") === -1) return plan;
  const root = parse(html);
  root.querySelectorAll("[source]").forEach((el) => {
    const tag = (el.rawTagName || "").toLowerCase();
    const framing = el.getAttribute("framing");
    if (!FRAMING_TAGS.includes(tag) && typeof framing !== "string") return;
    const mediaType = el.getAttribute("media-type");
    if (mediaType && mediaType !== "image") return;
    const source = el.getAttribute("source");
    if (!framingSource(source)) return;
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

/**
 * Make the files the framed photos in `html` need, inside `siteDirectory`.
 * Files already there are kept; a photo that is missing or can't be read is
 * skipped (the element falls back to framing the original in CSS).
 * Returns the locations written.
 */
async function cutFramings(siteDirectory, html) {
  const written = [];
  const plan = framingPlan(html);
  if (!plan.length) return written;
  const dir = resolveContainedPath(siteDirectory, FRAMING_DIR);
  if (dir === false) return written;
  const meta = {};
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i];
    const input = resolveContainedPath(
      siteDirectory,
      entry.source.split(/[?#]/)[0],
    );
    const target = resolveContainedPath(siteDirectory, entry.location);
    if (input === false || target === false) continue;
    if (fs.pathExistsSync(target)) continue;
    if (!fs.pathExistsSync(input) || !fs.lstatSync(input).isFile()) continue;
    try {
      if (!meta[input]) {
        meta[input] = await sharp(input, { failOn: "none" })
          .rotate()
          .metadata();
      }
      const info = meta[input];
      // rotate() applies EXIF orientation, so a turned photo swaps sides
      const turned = info.orientation && info.orientation >= 5;
      const W = turned ? info.height : info.width;
      const H = turned ? info.width : info.height;
      if (!W || !H) continue;
      fs.ensureDirSync(dir);
      let pipeline = sharp(input, { failOn: "none" }).rotate();
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
    } catch {
      // unreadable photo: leave it to the CSS fallback
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
  parseFraming,
  fnv1a,
  framingKey,
  framingSource,
  framingFullUrl,
  framingCutUrl,
  framingCutWidths,
  framingPlan,
  cutFramings,
};
