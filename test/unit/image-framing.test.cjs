"use strict";

// Image framing cuts (haxtheweb/issues#2976). The names are a contract with
// @haxtheweb/d-d-d/lib/ImageFraming.js and haxcms-php lib/ImageFraming.php:
// all three test the same golden values.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const {
  fnv1a,
  framingKey,
  framingSource,
  framingFullUrl,
  framingCutUrl,
  framingCutWidths,
  parseFraming,
  framingPlan,
  cutFramings,
} = require("../../src/lib/imageFraming.js");

const RECT = { x: 0.12, y: 0, w: 0.763, h: 1 };

test("golden names match the front end and haxcms-php", () => {
  assert.equal(framingKey(RECT), "0.120,0.000,0.763,1.000");
  assert.equal(fnv1a(framingKey(RECT)), "924e65bf");
  assert.equal(
    framingCutUrl("files/field-day.jpg", "sm", RECT, 600),
    "files/haxcms-managed/framing/field-day-sm-924e65bf-600w.jpg",
  );
  assert.equal(
    framingFullUrl("files/field-day.jpg", 1200),
    "files/haxcms-managed/framing/field-day-full-1200w.jpg",
  );
  assert.equal(
    framingFullUrl("files/photos/Field.PNG", 600),
    "files/haxcms-managed/framing/photos--Field-full-600w.png",
  );
  assert.deepEqual(framingCutWidths("sm"), [600, 1200]);
  assert.deepEqual(framingCutWidths("xl"), [1920, 3840]);
});

test("only plain still images under files/ are cut", () => {
  [
    "https://example.com/files/a.jpg",
    "/files/a.jpg",
    "files/../site.json",
    "files/haxcms-managed/framing/a-full-600w.jpg",
    "files/movie.gif",
    "files/a b.jpg",
    "files/.hidden.jpg",
    "files/noext",
  ].forEach((source) => assert.equal(framingSource(source), null, source));
  assert.deepEqual(framingSource("files/a.webp?v=2"), {
    stem: "a",
    ext: "webp",
  });
});

test("bad framing values are dropped", () => {
  assert.deepEqual(parseFraming("not json"), {});
  assert.deepEqual(
    parseFraming(
      '{"sm":{"x":0.5,"y":0,"w":0.8,"h":1},"zz":{"x":0,"y":0,"w":1,"h":1}}',
    ),
    {},
  );
  assert.deepEqual(parseFraming({ md: RECT }), { md: RECT });
});

test("the plan lists full variants for every hero and cuts for custom sizes", () => {
  const html = `<ddd-hero source="files/field-day.jpg"></ddd-hero>
    <ddd-hero source="files/field-day.jpg" framing='${JSON.stringify({ sm: RECT })}'></ddd-hero>
    <ddd-hero source="files/clip.mp4" media-type="video"></ddd-hero>
    <img source="files/other.jpg">`;
  const locations = framingPlan(html).map((entry) => entry.location);
  assert.deepEqual(locations, [
    "files/haxcms-managed/framing/field-day-full-600w.jpg",
    "files/haxcms-managed/framing/field-day-full-1200w.jpg",
    "files/haxcms-managed/framing/field-day-full-1920w.jpg",
    "files/haxcms-managed/framing/field-day-full-2880w.jpg",
    "files/haxcms-managed/framing/field-day-sm-924e65bf-600w.jpg",
    "files/haxcms-managed/framing/field-day-sm-924e65bf-1200w.jpg",
  ]);
});

test("cuts are written inside the site, framed and never upscaled", async () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "framing-"));
  try {
    fs.ensureDirSync(path.join(site, "files"));
    await sharp({
      create: { width: 1600, height: 900, channels: 3, background: "#336699" },
    })
      .jpeg()
      .toFile(path.join(site, "files", "field-day.jpg"));
    const html = `<ddd-hero source="files/field-day.jpg" framing='${JSON.stringify({ sm: RECT })}'></ddd-hero>`;
    const written = await cutFramings(site, html);
    assert.equal(written.length, 6);
    const dir = path.join(site, "files", "haxcms-managed", "framing");
    const full600 = await sharp(
      path.join(dir, "field-day-full-600w.jpg"),
    ).metadata();
    assert.equal(full600.width, 600);
    // the photo is 1600 wide, so the 1920 variant keeps it at 1600
    const full1920 = await sharp(
      path.join(dir, "field-day-full-1920w.jpg"),
    ).metadata();
    assert.equal(full1920.width, 1600);
    // the cut is 0.763 of the width, full height: 1221 x 900, sized to 600
    const cut = await sharp(
      path.join(dir, "field-day-sm-924e65bf-600w.jpg"),
    ).metadata();
    assert.equal(cut.width, 600);
    assert.equal(cut.height, Math.round((900 * 600) / 1221));
    const cut2x = await sharp(
      path.join(dir, "field-day-sm-924e65bf-1200w.jpg"),
    ).metadata();
    assert.equal(cut2x.width, 1200);
    // a second save keeps the files there
    assert.deepEqual(await cutFramings(site, html), []);
  } finally {
    fs.removeSync(site);
  }
});

test("a missing photo or a path out of the site writes nothing", async () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "framing-"));
  try {
    assert.deepEqual(
      await cutFramings(site, `<ddd-hero source="files/gone.jpg"></ddd-hero>`),
      [],
    );
    assert.deepEqual(
      await cutFramings(
        site,
        `<ddd-hero source="files/../../etc/x.jpg"></ddd-hero>`,
      ),
      [],
    );
  } finally {
    fs.removeSync(site);
  }
});
