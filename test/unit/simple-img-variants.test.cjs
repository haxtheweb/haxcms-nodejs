"use strict";

// simple-img variants. The names are a contract with
// @haxtheweb/simple-img/lib/SimpleImgVariants.js and haxcms-php
// lib/SimpleImgVariants.php: all three test the same golden values.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const {
  simpleImgSource,
  simpleImgVariantUrl,
  simpleImgPlan,
  cleanSimpleImgVariants,
  cutSimpleImgVariants,
  SIMPLE_IMG_DIR,
  SIMPLE_IMG_MAX_VARIANTS,
} = require("../../src/lib/simpleImgVariants.js");

function makeSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-img-"));
  fs.ensureDirSync(path.join(dir, "files"));
  fs.ensureDirSync(path.join(dir, "pages", "a"));
  return dir;
}

async function writePhoto(site, name, width, height, format) {
  const file = path.join(site, "files", name);
  fs.ensureDirSync(path.dirname(file));
  let img = sharp({
    create: { width, height, channels: 3, background: "#3366cc" },
  });
  img = format === "png" ? img.png() : img.jpeg();
  await img.toFile(file);
  return file;
}

test("golden names match the front end and haxcms-php", () => {
  assert.equal(
    simpleImgVariantUrl({ src: "files/field-day.jpg" }),
    "files/haxcms-managed/simple-img/field-day-a9eb28d6.jpg",
  );
  // simple-img's defaults spelled out name the same file
  assert.equal(
    simpleImgVariantUrl({
      src: "files/field-day.jpg",
      width: "300",
      height: "200",
      quality: "80",
      rotate: "0",
      fit: "cover",
      format: "jpg",
      wmspot: "se",
    }),
    "files/haxcms-managed/simple-img/field-day-a9eb28d6.jpg",
  );
  assert.equal(
    simpleImgVariantUrl({
      src: "files/photos/Field.PNG?v=2",
      width: 640,
      height: 480,
      quality: 60,
      rotate: "-90",
      fit: "Inside",
      format: "webp",
      watermark: "files/logo.png",
      wmspot: "nw",
    }),
    "files/haxcms-managed/simple-img/photos--Field-00167df4.webp",
  );
  assert.equal(
    simpleImgVariantUrl({ src: "files/clip.gif", quality: 50, format: "jpeg" }),
    "files/haxcms-managed/simple-img/clip-4aff2e69.jpg",
  );
});

test("only site photos, quarter turns, sane sizes and site watermarks get a variant", () => {
  [
    { src: "https://example.com/files/a.jpg" },
    { src: "/files/a.jpg" },
    { src: "files/../site.json" },
    { src: "files/haxcms-managed/simple-img/a-00000000.jpg" },
    { src: "files/a.svg" },
    { src: "files/a b.jpg" },
    { src: "files/a.jpg", rotate: 45 },
    { src: "files/a.jpg", width: 5000 },
    { src: "files/a.jpg", watermark: "https://example.com/logo.png" },
    { src: "files/a.jpg", watermark: "files/logo.gif" },
  ].forEach((attrs) =>
    assert.equal(simpleImgVariantUrl(attrs), null, JSON.stringify(attrs)),
  );
  assert.deepEqual(simpleImgSource("files/a.gif?x=1"), {
    path: "files/a.gif",
    stem: "a",
    ext: "gif",
  });
});

test("the plan lists one variant per file, for simple-img only, capped per save", () => {
  const html = `<simple-img src="files/a.jpg"></simple-img>
    <simple-img src="files/a.jpg" width="300" height="200"></simple-img>
    <simple-img src="files/a.jpg" width="100" height="100"></simple-img>
    <img src="files/b.jpg">
    <simple-img src="https://example.com/c.jpg"></simple-img>`;
  const plan = simpleImgPlan(html);
  assert.equal(plan.length, 2);
  let many = "";
  for (let i = 0; i < SIMPLE_IMG_MAX_VARIANTS + 5; i++) {
    many += `<simple-img src="files/a.jpg" width="${i + 1}"></simple-img>`;
  }
  assert.equal(simpleImgPlan(many).length, SIMPLE_IMG_MAX_VARIANTS);
  assert.equal(simpleImgPlan(many, false).length, SIMPLE_IMG_MAX_VARIANTS + 5);
});

test("variants are written inside the site at the asked size, fit and format", async () => {
  const site = makeSite();
  await writePhoto(site, "a.jpg", 800, 400);
  await writePhoto(site, "logo.png", 20, 10, "png");
  const html = `<simple-img src="files/a.jpg"></simple-img>
    <simple-img src="files/a.jpg" width="100" height="100" fit="inside" format="png"></simple-img>
    <simple-img src="files/a.jpg" width="50" height="80" rotate="90" format="webp"></simple-img>
    <simple-img src="files/a.jpg" width="120" height="60" watermark="files/logo.png" wmspot="nw"></simple-img>`;
  const written = await cutSimpleImgVariants(site, html);
  assert.equal(written.length, 4);
  const check = async (attrs, w, h, format) => {
    const file = path.join(site, simpleImgVariantUrl(attrs));
    const meta = await sharp(file).metadata();
    assert.equal(meta.width, w);
    assert.equal(meta.height, h);
    assert.equal(meta.format, format);
  };
  await check({ src: "files/a.jpg" }, 300, 200, "jpeg");
  await check(
    {
      src: "files/a.jpg",
      width: 100,
      height: 100,
      fit: "inside",
      format: "png",
    },
    100,
    50,
    "png",
  );
  await check(
    { src: "files/a.jpg", width: 50, height: 80, rotate: 90, format: "webp" },
    50,
    80,
    "webp",
  );
  await check(
    {
      src: "files/a.jpg",
      width: 120,
      height: 60,
      watermark: "files/logo.png",
      wmspot: "nw",
    },
    120,
    60,
    "jpeg",
  );
  // a second save finds the files made and makes nothing
  assert.deepEqual(await cutSimpleImgVariants(site, html), []);
  fs.removeSync(site);
});

test("a gif gives its first frame", async () => {
  const site = makeSite();
  await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#cc0000" },
  })
    .gif()
    .toFile(path.join(site, "files", "clip.gif"));
  const attrs = { src: "files/clip.gif", quality: 50 };
  const written = await cutSimpleImgVariants(
    site,
    `<simple-img src="files/clip.gif" quality="50"></simple-img>`,
  );
  assert.deepEqual(written, [simpleImgVariantUrl(attrs)]);
  const meta = await sharp(path.join(site, written[0])).metadata();
  assert.equal(meta.format, "jpeg");
  fs.removeSync(site);
});

test("a missing photo, a fake image or a watermark bigger than the variant writes nothing", async () => {
  const site = makeSite();
  fs.writeFileSync(path.join(site, "files", "fake.jpg"), "<svg></svg>");
  await writePhoto(site, "a.jpg", 200, 200);
  await writePhoto(site, "big.png", 400, 400, "png");
  const written = await cutSimpleImgVariants(
    site,
    `<simple-img src="files/missing.jpg"></simple-img>
     <simple-img src="files/fake.jpg"></simple-img>
     <simple-img src="files/a.jpg" width="100" height="100" watermark="files/big.png"></simple-img>`,
  );
  assert.deepEqual(written, []);
  const dir = path.join(site, SIMPLE_IMG_DIR);
  assert.equal(
    fs.pathExistsSync(dir) ? fs.readdirSync(dir).length : 0,
    0,
    "no half-written file is left behind",
  );
  fs.removeSync(site);
});

test("a save out of time starts no new variants", async () => {
  const site = makeSite();
  await writePhoto(site, "a.jpg", 100, 100);
  const written = await cutSimpleImgVariants(
    site,
    `<simple-img src="files/a.jpg"></simple-img>`,
    { maxSeconds: 0 },
  );
  assert.deepEqual(written, []);
  fs.removeSync(site);
});

test("a photo's variants no page uses any more are removed when it gets a new one", async () => {
  const site = makeSite();
  await writePhoto(site, "a.jpg", 400, 400);
  await writePhoto(site, "b.jpg", 400, 400);
  const page = path.join(site, "pages", "a", "index.html");
  const first = `<simple-img src="files/a.jpg" width="100" height="100"></simple-img>
    <simple-img src="files/b.jpg" width="100" height="100"></simple-img>`;
  fs.writeFileSync(page, first);
  const old = await cutSimpleImgVariants(site, first);
  assert.equal(old.length, 2);
  // the page now asks for another size of a.jpg only
  const second = `<simple-img src="files/a.jpg" width="120" height="120"></simple-img>
    <simple-img src="files/b.jpg" width="100" height="100"></simple-img>`;
  fs.writeFileSync(page, second);
  const made = await cutSimpleImgVariants(site, second);
  assert.equal(made.length, 1);
  const left = fs.readdirSync(path.join(site, SIMPLE_IMG_DIR)).sort();
  assert.deepEqual(
    left,
    [made[0], old[1]].map((location) => path.basename(location)).sort(),
  );
  // nothing named outside the folder's pattern is touched
  fs.writeFileSync(path.join(site, SIMPLE_IMG_DIR, "notes.txt"), "keep");
  assert.deepEqual(cleanSimpleImgVariants(site, ["a"], []), []);
  fs.removeSync(site);
});
