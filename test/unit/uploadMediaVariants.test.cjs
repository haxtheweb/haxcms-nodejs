"use strict";

// Unit tests for audio / video uploads whose bytes vary by the tool that
// wrote them. A .mp4 from a phone, screen recorder or editor can carry a
// QuickTime or M4A brand, can have a free box ahead of ftyp, and an .mp3
// can start with zero padding before its first frame. Each of these plays in
// a browser, so each is accepted; anything that is not media is still
// refused. Mirrors haxcms-php tests/Unit/UploadMediaVariantsTest.php.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs-extra");
const os = require("os");

const HAXCMSFile = require("../../src/lib/HAXCMSFile.js");

function box(type, payload) {
  const body = Buffer.from(payload || "");
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, body]);
}
function ftyp(brand) {
  return box("ftyp", brand + "\0\0\0\0isom" + brand);
}
// an MPEG-1 layer III frame header (sync, 128 kbps, 44.1 kHz) and a body
const MP3_FRAME = Buffer.concat([
  Buffer.from([0xff, 0xfb, 0x90, 0x64]),
  Buffer.alloc(413, 0x55),
]);

const SAMPLES = {
  "isom.mp4": Buffer.concat([ftyp("isom"), box("mdat", "x")]),
  "quicktime-brand.mp4": Buffer.concat([ftyp("qt  "), box("mdat", "x")]),
  "m4a-brand.mp4": Buffer.concat([ftyp("M4A "), box("mdat", "x")]),
  "free-first.mp4": Buffer.concat([box("free"), ftyp("mp42"), box("mdat")]),
  "no-ftyp.mov": Buffer.concat([box("moov", "x"), box("mdat", "x")]),
  "mp4-brand.mov": Buffer.concat([ftyp("isom"), box("mdat", "x")]),
  "frame.mp3": MP3_FRAME,
  "padded.mp3": Buffer.concat([Buffer.alloc(64), MP3_FRAME]),
  "id3.mp3": Buffer.concat([Buffer.from("ID3\u0004\0\0\0\0\0\0"), MP3_FRAME]),
};
const REFUSED = {
  "page.mp4": Buffer.from("<html><body><script>alert(1)</script></body>"),
  "text.mp3": Buffer.from("just some words that are not audio at all\n"),
  "zeros.mp3": Buffer.alloc(512),
  "zip.mp4": Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
};

let dir = "";
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "haxcms-media-variants-"));
});
after(() => {
  fs.removeSync(dir);
});

function accepted(name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  const mime = HAXCMSFile.detectMimeTypeFromContent(file);
  const ext = path.extname(name).slice(1);
  return {
    mime: mime,
    ok: HAXCMSFile.mimeMatchesAllowed(
      mime,
      HAXCMSFile.ALLOWED_MIME_BY_EXTENSION[ext],
    ),
  };
}

describe("media uploads written by different tools are accepted", () => {
  Object.keys(SAMPLES).forEach((name) => {
    test(name, () => {
      const result = accepted(name, SAMPLES[name]);
      assert.equal(result.ok, true, name + " sniffed as " + result.mime);
    });
  });
});

describe("files that are not media are still refused", () => {
  Object.keys(REFUSED).forEach((name) => {
    test(name, () => {
      const result = accepted(name, REFUSED[name]);
      assert.equal(result.ok, false, name + " sniffed as " + result.mime);
    });
  });
});

test("the media family is shared by .mp4 and .mov, nothing wider", () => {
  const mp4 = HAXCMSFile.ALLOWED_MIME_BY_EXTENSION.mp4;
  const mov = HAXCMSFile.ALLOWED_MIME_BY_EXTENSION.mov;
  assert.ok(mp4.includes("video/quicktime"));
  assert.ok(mov.includes("video/mp4"));
  ["text/html", "text/plain", "application/octet-stream"].forEach((m) => {
    assert.ok(!mp4.includes(m), m);
    assert.ok(!mov.includes(m), m);
  });
});
