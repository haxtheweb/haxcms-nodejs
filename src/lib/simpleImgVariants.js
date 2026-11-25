/**
 * simple-img variants: the sized copy of a site photo that simple-img shows.
 *
 * When a page is saved, each simple-img on it whose photo lives in the site
 * gets the copy it asks for (size, fit, quality, rotation, format,
 * watermark) under files/haxcms-managed/simple-img/. simple-img works out
 * the same name from its attributes and shows that file, falling back to
 * the original when it is not there. These copies replace the image service
 * simple-img used to call on open-apis.hax.cloud, so the work happens
 * on-premises and the result is a plain file on any host, static ones too.
 *
 * The names are a contract shared with the front end
 * (@haxtheweb/simple-img/lib/SimpleImgVariants.js) and haxcms-php
 * (system/backend/php/lib/SimpleImgVariants.php); all three test the same
 * golden names.
 *
 * Security (SEC-PATH): the photo and the watermark are read, and every
 * variant written or removed, only through resolveContainedPath, so all of
 * it stays inside the site's directory; only plain files/ paths with image
 * extensions are read, and their first bytes must be the type the
 * extension names. Nothing is fetched from another host.
 *
 * Stability: a save never does unbounded image work. Photos over the
 * framing size limits are skipped (simple-img shows the original), sides
 * over SIMPLE_IMG_MAX_SIDE are never made, one save makes at most
 * SIMPLE_IMG_MAX_VARIANTS variants and stops starting new ones after
 * SIMPLE_IMG_MAX_SECONDS (the next save carries on, since files already
 * made are kept). When a photo gets a new variant, its variants no page
 * uses any more are removed, so the folder doesn't grow with every change.
 */
const fs = require("fs-extra");
const sharp = require("sharp");
const { parse } = require("node-html-parser");
const { resolveContainedPath } = require("./pathConfinement.js");
const {
  fnv1a,
  framingPhoto,
  framingPageFiles,
  FRAMING_MAX_PIXELS,
} = require("./imageFraming.js");

const SIMPLE_IMG_DIR = "files/haxcms-managed/simple-img/";
const SIMPLE_IMG_SOURCE_FORMATS = Object.freeze([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
]);
const SIMPLE_IMG_WATERMARK_FORMATS = Object.freeze([
  "jpg",
  "jpeg",
  "png",
  "webp",
]);
const SIMPLE_IMG_FORMATS = Object.freeze(["jpg", "png", "webp", "gif"]);
const SIMPLE_IMG_FITS = Object.freeze([
  "cover",
  "contain",
  "fill",
  "inside",
  "outside",
]);
const SIMPLE_IMG_SPOTS = Object.freeze(["se", "sw", "ne", "nw"]);
const SIMPLE_IMG_DEFAULT_WIDTH = 300;
const SIMPLE_IMG_DEFAULT_HEIGHT = 200;
const SIMPLE_IMG_DEFAULT_QUALITY = 80;
const SIMPLE_IMG_MAX_SIDE = 4000;
// limits on the work one save may do
const SIMPLE_IMG_MAX_VARIANTS = 24;
const SIMPLE_IMG_MAX_SECONDS = 20;
// where a watermark sits on the variant
const SIMPLE_IMG_GRAVITY = Object.freeze({
  se: "southeast",
  sw: "southwest",
  ne: "northeast",
  nw: "northwest",
});

/** { path, stem, ext } for a plain files/ path with one of `formats`, else null */
function simpleImgSource(source, formats) {
  if (typeof source !== "string") return null;
  const allowed = formats || SIMPLE_IMG_SOURCE_FORMATS;
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
  if (!allowed.includes(ext)) return null;
  const stem = parts.slice(1, -1).concat(file.slice(0, dot)).join("--");
  return { path: clean, stem, ext };
}

function toInt(value) {
  if (value === null || typeof value === "undefined" || value === "") {
    return null;
  }
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

function toWord(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The variant a simple-img asks for, from its attribute values, or null when
 * none is made: a source outside the site, a side over SIMPLE_IMG_MAX_SIDE,
 * a rotation that is not a quarter turn, or a watermark that is not a site
 * photo.
 */
function simpleImgVariant(attrs) {
  const a = attrs || {};
  const source = simpleImgSource(a.src);
  if (!source) return null;
  let width = toInt(a.width);
  if (width === null || width < 1) width = SIMPLE_IMG_DEFAULT_WIDTH;
  let height = toInt(a.height);
  if (height === null || height < 1) height = SIMPLE_IMG_DEFAULT_HEIGHT;
  if (width > SIMPLE_IMG_MAX_SIDE || height > SIMPLE_IMG_MAX_SIDE) return null;
  let quality = toInt(a.quality);
  if (quality === null || quality < 1 || quality > 100) {
    quality = SIMPLE_IMG_DEFAULT_QUALITY;
  }
  let rotate = toInt(a.rotate);
  rotate = rotate === null ? 0 : ((rotate % 360) + 360) % 360;
  if (rotate % 90 !== 0) return null;
  let fit = toWord(a.fit);
  if (!SIMPLE_IMG_FITS.includes(fit)) fit = "cover";
  let format = toWord(a.format);
  if (format === "jpeg") format = "jpg";
  if (!SIMPLE_IMG_FORMATS.includes(format)) format = "jpg";
  let watermark = "";
  if (typeof a.watermark === "string" && a.watermark.trim() !== "") {
    const mark = simpleImgSource(
      a.watermark.trim(),
      SIMPLE_IMG_WATERMARK_FORMATS,
    );
    if (!mark) return null;
    watermark = mark.path;
  }
  let wmspot = toWord(a.wmspot);
  if (!SIMPLE_IMG_SPOTS.includes(wmspot)) wmspot = "se";
  const key = [
    source.path,
    width,
    height,
    quality,
    rotate,
    fit,
    format,
    watermark,
    wmspot,
  ].join("|");
  return {
    source: source.path,
    stem: source.stem,
    ext: source.ext,
    location: `${SIMPLE_IMG_DIR}${source.stem}-${fnv1a(key)}.${format}`,
    width,
    height,
    quality,
    rotate,
    fit,
    format,
    watermark,
    wmspot,
  };
}

/** the site path of the variant a simple-img asks for, or null */
function simpleImgVariantUrl(attrs) {
  const variant = simpleImgVariant(attrs);
  return variant ? variant.location : null;
}

/**
 * Every variant the simple-img tags in this HTML ask for, one per file.
 * Only the first SIMPLE_IMG_MAX_VARIANTS are planned, unless `limited` is
 * false (used when listing what is in use, never for making files).
 */
function simpleImgPlan(html, limited) {
  const plan = [];
  const seen = {};
  if (typeof html !== "string" || html.indexOf("simple-img") === -1) {
    return plan;
  }
  const root = parse(html);
  const tags = root.querySelectorAll("simple-img");
  for (let i = 0; i < tags.length; i++) {
    const el = tags[i];
    const variant = simpleImgVariant({
      src: el.getAttribute("src"),
      width: el.getAttribute("width"),
      height: el.getAttribute("height"),
      quality: el.getAttribute("quality"),
      rotate: el.getAttribute("rotate"),
      fit: el.getAttribute("fit"),
      format: el.getAttribute("format"),
      watermark: el.getAttribute("watermark"),
      wmspot: el.getAttribute("wmspot"),
    });
    if (!variant || seen[variant.location]) continue;
    if (limited !== false && plan.length >= SIMPLE_IMG_MAX_VARIANTS) break;
    seen[variant.location] = true;
    plan.push(variant);
  }
  return plan;
}

/**
 * Remove the variants of the photos named by `stems` that no page in the
 * site uses any more. Only files in the variant folder whose names are
 * variants of those photos are ever removed, and never a location listed in
 * `keep` (the save in hand). Returns the locations removed.
 */
function cleanSimpleImgVariants(siteDirectory, stems, keep) {
  const removed = [];
  const dir = resolveContainedPath(siteDirectory, SIMPLE_IMG_DIR);
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
    simpleImgPlan(html, false).forEach((entry) => {
      used[entry.location] = true;
    });
  }
  const variantName = /^(.+)-[0-9a-f]{8}\.(jpg|png|webp|gif)$/;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (!entry.isFile()) return;
    const match = variantName.exec(entry.name);
    if (!match || !stems.includes(match[1])) return;
    const location = SIMPLE_IMG_DIR + entry.name;
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

/** write one variant to `target`; throws when it can't be made */
async function makeVariant(input, mark, variant, target) {
  let pipeline = sharp(input, {
    failOn: "none",
    limitInputPixels: FRAMING_MAX_PIXELS,
  }).autoOrient();
  if (variant.rotate) {
    pipeline = pipeline.rotate(variant.rotate);
  }
  pipeline = pipeline.resize({
    width: variant.width,
    height: variant.height,
    fit: variant.fit,
    background: { r: 0, g: 0, b: 0, alpha: 1 },
  });
  if (mark) {
    const markBuffer = await sharp(mark, {
      failOn: "none",
      limitInputPixels: FRAMING_MAX_PIXELS,
    })
      .autoOrient()
      .png()
      .toBuffer();
    pipeline = pipeline.composite([
      { input: markBuffer, gravity: SIMPLE_IMG_GRAVITY[variant.wmspot] },
    ]);
  }
  switch (variant.format) {
    case "png":
      pipeline = pipeline.png();
      break;
    case "webp":
      pipeline = pipeline.webp({ lossless: true });
      break;
    case "gif":
      pipeline = pipeline.gif();
      break;
    default:
      pipeline = pipeline.jpeg({ quality: variant.quality, mozjpeg: true });
      break;
  }
  await pipeline.toFile(target);
}

/**
 * Make the variants the simple-img tags in `html` ask for, inside
 * `siteDirectory`, within the limits at the top of this file. Files already
 * there are kept; a photo that is missing, too big or not an image is
 * skipped (simple-img shows the original). When a photo gets a new
 * variant, its variants no page uses any more are removed.
 * `options.maxSeconds` overrides SIMPLE_IMG_MAX_SECONDS. Returns the
 * locations written.
 */
async function cutSimpleImgVariants(siteDirectory, html, options) {
  const written = [];
  const plan = simpleImgPlan(html);
  if (!plan.length) return written;
  const dir = resolveContainedPath(siteDirectory, SIMPLE_IMG_DIR);
  if (dir === false) return written;
  const maxSeconds =
    options && typeof options.maxSeconds === "number"
      ? options.maxSeconds
      : SIMPLE_IMG_MAX_SECONDS;
  const deadline = Date.now() + maxSeconds * 1000;
  const photos = {};
  const changed = [];
  const checkPhoto = async (location, ext) => {
    const file = resolveContainedPath(siteDirectory, location);
    if (file === false) return null;
    if (photos[file] === undefined) {
      photos[file] = (await framingPhoto(file, ext)) ? file : null;
    }
    return photos[file];
  };
  for (let i = 0; i < plan.length; i++) {
    if (Date.now() >= deadline) break;
    const variant = plan[i];
    const target = resolveContainedPath(siteDirectory, variant.location);
    if (target === false || fs.pathExistsSync(target)) continue;
    const input = await checkPhoto(variant.source, variant.ext);
    if (!input) continue;
    let mark = null;
    if (variant.watermark) {
      const markSource = simpleImgSource(
        variant.watermark,
        SIMPLE_IMG_WATERMARK_FORMATS,
      );
      mark = markSource
        ? await checkPhoto(markSource.path, markSource.ext)
        : null;
      if (!mark) continue;
    }
    try {
      fs.ensureDirSync(dir);
      await makeVariant(input, mark, variant, target);
      written.push(variant.location);
      if (!changed.includes(variant.stem)) changed.push(variant.stem);
    } catch {
      // unreadable photo or a watermark bigger than the variant: simple-img
      // shows the original; never leave a half-written file to be served
      try {
        fs.removeSync(target);
      } catch {
        // nothing to remove
      }
    }
  }
  if (changed.length) {
    try {
      cleanSimpleImgVariants(
        siteDirectory,
        changed,
        plan.map((entry) => entry.location),
      );
    } catch {
      // cleaning up is best effort
    }
  }
  return written;
}

module.exports = {
  SIMPLE_IMG_DIR,
  SIMPLE_IMG_SOURCE_FORMATS,
  SIMPLE_IMG_WATERMARK_FORMATS,
  SIMPLE_IMG_FORMATS,
  SIMPLE_IMG_FITS,
  SIMPLE_IMG_SPOTS,
  SIMPLE_IMG_DEFAULT_WIDTH,
  SIMPLE_IMG_DEFAULT_HEIGHT,
  SIMPLE_IMG_DEFAULT_QUALITY,
  SIMPLE_IMG_MAX_SIDE,
  SIMPLE_IMG_MAX_VARIANTS,
  SIMPLE_IMG_MAX_SECONDS,
  simpleImgSource,
  simpleImgVariant,
  simpleImgVariantUrl,
  simpleImgPlan,
  cleanSimpleImgVariants,
  cutSimpleImgVariants,
};
