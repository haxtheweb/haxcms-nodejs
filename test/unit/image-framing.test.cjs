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
  cleanFramings,
  cutFramings,
  FRAMING_MAX_PHOTOS,
  FRAMING_MAX_PIXELS,
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

test("the plan lists full variants for every hero and cuts for custom sizes, for allowlisted tags only", () => {
  const html = `<ddd-hero source="files/field-day.jpg"></ddd-hero>
    <ddd-hero source="files/field-day.jpg" framing='${JSON.stringify({ sm: RECT })}'></ddd-hero>
    <ddd-hero source="files/clip.mp4" media-type="video"></ddd-hero>
    <img source="files/other.jpg">
    <video-player source="files/poster.jpg" framing='${JSON.stringify({ sm: RECT })}'></video-player>`;
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

// --- limits on what one save may do (same cases in haxcms-php) -------------

async function makeSite() {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "framing-"));
  fs.ensureDirSync(path.join(site, "files"));
  fs.ensureDirSync(path.join(site, "pages", "home"));
  return site;
}

async function makePhoto(site, name, width, height) {
  await sharp({
    create: { width, height, channels: 3, background: "#336699" },
  })
    .jpeg()
    .toFile(path.join(site, "files", name));
}

const hero = (source, framing) =>
  `<ddd-hero source="${source}"${framing ? ` framing='${JSON.stringify(framing)}'` : ""}></ddd-hero>`;

test("one save plans at most FRAMING_MAX_PHOTOS photos", () => {
  let html = "";
  for (let i = 0; i < FRAMING_MAX_PHOTOS + 3; i++) {
    html += hero(`files/photo-${i}.jpg`);
  }
  const sources = {};
  framingPlan(html).forEach((entry) => {
    sources[entry.source] = true;
  });
  assert.equal(Object.keys(sources).length, FRAMING_MAX_PHOTOS);
  assert.equal(sources["files/photo-0.jpg"], true);
  assert.equal(sources[`files/photo-${FRAMING_MAX_PHOTOS}.jpg`], undefined);
});

test("a file that is not the image its extension names is not cut", async () => {
  const site = await makeSite();
  try {
    fs.writeFileSync(
      path.join(site, "files", "fake.jpg"),
      "<html>not a photo</html>",
    );
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#336699" },
    })
      .png()
      .toFile(path.join(site, "files", "really-png.jpg"));
    assert.deepEqual(await cutFramings(site, hero("files/fake.jpg")), []);
    assert.deepEqual(await cutFramings(site, hero("files/really-png.jpg")), []);
    assert.equal(
      fs.pathExistsSync(
        path.join(
          site,
          "files",
          "haxcms-managed",
          "framing",
          "fake-full-600w.jpg",
        ),
      ),
      false,
    );
  } finally {
    fs.removeSync(site);
  }
});

test("a photo over the pixel limit is left to the CSS fallback", async () => {
  const site = await makeSite();
  try {
    // 8000 x 5001 is just over 40 megapixels
    assert.ok(8000 * 5001 > FRAMING_MAX_PIXELS);
    await makePhoto(site, "huge.jpg", 8000, 5001);
    assert.deepEqual(await cutFramings(site, hero("files/huge.jpg")), []);
  } finally {
    fs.removeSync(site);
  }
});

test("a save out of time starts no new files, and the next save carries on", async () => {
  const site = await makeSite();
  try {
    await makePhoto(site, "field-day.jpg", 1600, 900);
    const html = hero("files/field-day.jpg");
    assert.deepEqual(await cutFramings(site, html, { maxSeconds: 0 }), []);
    assert.equal((await cutFramings(site, html)).length, 4);
  } finally {
    fs.removeSync(site);
  }
});

test("reframing a photo removes its cuts no page uses any more", async () => {
  const site = await makeSite();
  try {
    await makePhoto(site, "field-day.jpg", 1600, 900);
    await makePhoto(site, "other.jpg", 1600, 900);
    const dir = path.join(site, "files", "haxcms-managed", "framing");
    const page = path.join(site, "pages", "home", "index.html");
    const other = path.join(site, "pages", "about");
    fs.ensureDirSync(other);
    const NEXT = { x: 0.2, y: 0, w: 0.6, h: 1 };
    const KEPT = { x: 0, y: 0, w: 0.5, h: 1 };
    // another page frames the same photo its own way, and another photo
    const aboutHtml =
      hero("files/field-day.jpg", { md: KEPT }) +
      hero("files/other.jpg", { sm: RECT });
    fs.writeFileSync(path.join(other, "index.html"), aboutHtml);
    await cutFramings(site, aboutHtml);
    // home: framed, then reframed
    let html = hero("files/field-day.jpg", { sm: RECT });
    fs.writeFileSync(page, html);
    await cutFramings(site, html);
    assert.equal(
      fs.pathExistsSync(path.join(dir, "field-day-sm-924e65bf-600w.jpg")),
      true,
    );
    html = hero("files/field-day.jpg", { sm: NEXT });
    fs.writeFileSync(page, html);
    const written = await cutFramings(site, html);
    assert.equal(written.length, 2);
    // the old framing's cuts are gone
    assert.equal(
      fs.pathExistsSync(path.join(dir, "field-day-sm-924e65bf-600w.jpg")),
      false,
    );
    assert.equal(
      fs.pathExistsSync(path.join(dir, "field-day-sm-924e65bf-1200w.jpg")),
      false,
    );
    // the new cuts, the other page's cuts, the other photo's cuts and the width variants stay
    written.forEach((location) =>
      assert.equal(fs.pathExistsSync(path.join(site, location)), true),
    );
    framingPlan(aboutHtml).forEach((entry) =>
      assert.equal(
        fs.pathExistsSync(path.join(site, entry.location)),
        true,
        entry.location,
      ),
    );
    assert.equal(
      fs.pathExistsSync(path.join(dir, "field-day-full-600w.jpg")),
      true,
    );
    // files that are not cuts of the photo are never touched
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
    assert.deepEqual(cleanFramings(site, ["field-day"]), []);
    assert.equal(fs.pathExistsSync(path.join(dir, "notes.txt")), true);
  } finally {
    fs.removeSync(site);
  }
});
