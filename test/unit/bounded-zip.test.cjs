"use strict";

// Unit tests for src/lib/boundedZip.js and the importers that read uploaded
// zips through it (docx, xlsx/ods, odt/odp, pptx). Invariant (SEC-DOS,
// SEC-UPLOAD): an uploaded zip is inflated under real byte limits; the sizes
// its directory declares only ever lower a limit, so neither a lying header
// nor an honest huge entry can make the server inflate past the budget.
//
// Fixtures are built at runtime with JSZip; "lying" fixtures have their
// local and central directory uncompressed sizes patched after generation.
//
// Constraints honored: CommonJS (.cjs), require(), NO optional chaining,
// node:test + node:assert/strict.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");

const {
  boundZipBuffer,
  hasZipSignature,
  MAX_ZIP_ENTRIES,
} = require("../../src/lib/boundedZip.js");
const { convertOdtBufferToHtml } = require("../../src/lib/odtToHtml.js");
const { convertPptxBufferToHtml } = require("../../src/lib/pptxToHtml.js");
const {
  importDocx,
} = require("../../src/systemRoutes/v1/routes/importDocx.js");
const {
  importXlsx,
} = require("../../src/systemRoutes/v1/routes/importXlsx.js");
const {
  convertXlsxToCsv,
} = require("../../src/systemRoutes/v1/routes/convertXlsxToCsv.js");

const BOMB_BYTES = 64 * 1024 * 1024;

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

async function uploadReq(name, contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hax-bounded-zip-"));
  const filePath = path.join(dir, "upload");
  await fs.writeFile(filePath, contents);
  return { files: [{ originalname: name, path: filePath }], body: {} };
}

// Overwrite the uncompressed size recorded for `name` in both the local
// header and the central directory.
function patchDeclaredSize(buffer, name, size) {
  const nameBytes = Buffer.from(name, "utf8");
  for (let i = 0; i < buffer.length - 4; i++) {
    const sig = buffer.readUInt32LE(i);
    if (
      sig === 0x04034b50 &&
      buffer.subarray(i + 30, i + 30 + nameBytes.length).equals(nameBytes)
    ) {
      buffer.writeUInt32LE(size, i + 22);
    } else if (
      sig === 0x02014b50 &&
      buffer.subarray(i + 46, i + 46 + nameBytes.length).equals(nameBytes)
    ) {
      buffer.writeUInt32LE(size, i + 24);
    }
  }
  return buffer;
}

// A zip whose `bombPath` holds BOMB_BYTES of spaces (deflates ~1000:1).
async function buildBomb(entries, bombPath, options) {
  const opts = options || {};
  const zip = new JSZip();
  const names = Object.keys(entries);
  for (let i = 0; i < names.length; i++) {
    zip.file(names[i], entries[names[i]], { compression: "STORE" });
  }
  zip.file(bombPath, Buffer.alloc(opts.bytes || BOMB_BYTES, 0x20), {
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  if (opts.declare !== undefined) {
    patchDeclaredSize(buffer, bombPath, opts.declare);
  }
  return buffer;
}

async function assertBudgetRejection(promise) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, "ZIP_BUDGET");
    assert.equal(err.status, 400);
    assert.match(err.message, /more content than can be imported/);
    return true;
  });
}

test("boundedZip: a normal zip comes back stored with the same entries", async () => {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text", {
    compression: "STORE",
  });
  zip.file("content.xml", "<a>" + "hello ".repeat(5000) + "</a>", {
    compression: "DEFLATE",
  });
  zip.file("Pictures/a.bin", Buffer.from([0, 1, 2, 3, 254, 255]));
  const input = await zip.generateAsync({ type: "nodebuffer" });
  assert.equal(hasZipSignature(input), true);
  const output = await boundZipBuffer(input, "odt");
  const reread = await JSZip.loadAsync(output);
  assert.deepEqual(
    Object.keys(reread.files).filter((name) => !reread.files[name].dir),
    ["mimetype", "content.xml", "Pictures/a.bin"],
  );
  assert.equal(
    await reread.file("content.xml").async("string"),
    "<a>" + "hello ".repeat(5000) + "</a>",
  );
  assert.deepEqual(
    [...(await reread.file("Pictures/a.bin").async("nodebuffer"))],
    [0, 1, 2, 3, 254, 255],
  );
  // stored: every entry's compressed size is its real size
  reread.forEach((name, entry) => {
    if (!entry.dir) {
      assert.equal(entry._data.compressedSize, entry._data.uncompressedSize);
    }
  });
});

test("boundedZip: empty files (STORE and DEFLATE) come back as empty files", async () => {
  // haxtheweb/issues#3426: JSZip keeps no compressed content for a
  // zero-length entry, which used to make the whole zip "not a zip"
  for (const compression of ["STORE", "DEFLATE"]) {
    const zip = new JSZip();
    zip.file("site.json", "{}");
    zip.file("empty.txt", "");
    zip.file(".nojekyll", "");
    zip.folder("files");
    const out = await boundZipBuffer(
      await zip.generateAsync({ type: "nodebuffer", compression }),
      "zip",
    );
    const back = await JSZip.loadAsync(out);
    assert.equal(await back.file("site.json").async("string"), "{}");
    assert.equal((await back.file("empty.txt").async("uint8array")).length, 0);
    assert.equal((await back.file(".nojekyll").async("uint8array")).length, 0);
  }
});

test("boundedZip: an entry that declares 0 bytes but carries data reads back empty, never inflated", async () => {
  const zip = new JSZip();
  zip.file("site.json", "{}");
  zip.file("hidden.txt", " ".repeat(4096));
  const buffer = patchDeclaredSize(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    "hidden.txt",
    0,
  );
  const back = await JSZip.loadAsync(await boundZipBuffer(buffer, "zip"));
  assert.equal((await back.file("hidden.txt").async("uint8array")).length, 0);
});

test("boundedZip: a lying header stops at its claim, not at the stream", async () => {
  const bomb = await buildBomb({}, "content.xml", { declare: 100 });
  const before = process.memoryUsage().rss;
  await assertBudgetRejection(boundZipBuffer(bomb, "odt"));
  // nothing near the 64 MiB the stream holds was materialised
  assert.ok(process.memoryUsage().rss - before < 32 * 1024 * 1024);
});

test("boundedZip: an honest entry over the budget is refused before inflating", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", "<w:document/>", { compression: "DEFLATE" });
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  patchDeclaredSize(buffer, "word/document.xml", 300 * 1024 * 1024);
  await assertBudgetRejection(boundZipBuffer(buffer, "docx"));
});

test("boundedZip: compression ratio past the limit is refused", async () => {
  // 64 MiB from ~64 KiB: over the 32 MiB floor and over 100x the upload
  const bomb = await buildBomb({}, "xl/worksheets/sheet1.xml");
  assert.ok(bomb.length < 1024 * 1024);
  await assertBudgetRejection(boundZipBuffer(bomb, "xlsx"));
});

test("boundedZip: too many entries are refused", async () => {
  const zip = new JSZip();
  for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) {
    zip.file(`f${i}`, "", { compression: "STORE" });
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await assertBudgetRejection(boundZipBuffer(buffer, "docx"));
});

test("boundedZip: garbage and truncated zips are invalid, not budget errors", async () => {
  await assert.rejects(boundZipBuffer(Buffer.from("not a zip"), "docx"), {
    message: "Uploaded file is not a valid .docx file.",
  });
  const zip = new JSZip();
  zip.file("a.xml", "<a/>".repeat(100), { compression: "DEFLATE" });
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await assert.rejects(boundZipBuffer(buffer.subarray(0, 20), "docx"), {
    message: "Uploaded file is not a valid .docx file.",
  });
});

test("odtToHtml and pptxToHtml: zip bombs are refused with the budget error", async () => {
  await assertBudgetRejection(
    convertOdtBufferToHtml(
      await buildBomb(
        { mimetype: "application/vnd.oasis.opendocument.text" },
        "content.xml",
        { declare: 100 },
      ),
    ),
  );
  await assertBudgetRejection(
    convertPptxBufferToHtml(
      await buildBomb({}, "ppt/slides/slide1.xml", { declare: 100 }),
    ),
  );
});

test("importDocx, importXlsx and convertXlsxToCsv: zip bombs answer 400", async () => {
  let res = stubRes();
  await importDocx(
    await uploadReq("bomb.docx", await buildBomb({}, "word/document.xml")),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(JSON.stringify(res.body), /more content than can be imported/);

  res = stubRes();
  await importXlsx(
    await uploadReq(
      "bomb.ods",
      await buildBomb(
        { mimetype: "application/vnd.oasis.opendocument.spreadsheet" },
        "content.xml",
        { declare: 100 },
      ),
    ),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(JSON.stringify(res.body), /more content than can be imported/);

  res = stubRes();
  await convertXlsxToCsv(
    await uploadReq("bomb.xlsx", await buildBomb({}, "xl/workbook.xml")),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(JSON.stringify(res.body), /more content than can be imported/);
});
