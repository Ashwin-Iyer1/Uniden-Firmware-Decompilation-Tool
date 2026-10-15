import test from "node:test";
import assert from "node:assert/strict";
import { encodeOldModel, decodeOldModel } from "../web/binary.mjs";
import {
  BAND_TABLE,
  readBands,
  bandPatch,
  scanStrings,
  patchString,
  bitmapLength,
  decodeBitmap,
  encodeBitmap,
  GRAPHICS_PRESETS,
  FONT_PRESETS,
  SCAN_DATA,
  compressLzss,
  decompressLzss,
  readScanFrames,
  makeScanFramesPatch,
  decodeGpsDatabase,
  encodeGpsDatabase,
  buildGpsRecord,
  parseGpsCsv,
  gpsToCsv,
  readSoundDirectory,
} from "../web/resources.mjs";

test("band edits preserve type and IF constants and encode exact kHz", () => {
  const dsp = new Uint8Array(
      BAND_TABLE.offset + BAND_TABLE.count * BAND_TABLE.stride,
    ),
    v = new DataView(dsp.buffer);
  v.setUint32(BAND_TABLE.offset, 6, true);
  v.setUint32(BAND_TABLE.offset + 12, 1234567, true);
  const patch = bandPatch(0, "33300.125", "33400.999");
  assert.equal(patch.offset, BAND_TABLE.offset + 4);
  assert.equal(patch.bytes.length, 8);
  dsp.set(patch.bytes, patch.offset);
  assert.deepEqual(readBands(dsp)[0], {
    index: 0,
    offset: BAND_TABLE.offset,
    bandType: 6,
    bandName: "Ka (narrow)",
    lowKhz: 33300125,
    highKhz: 33400999,
    ifConstant: 1234567,
  });
  for (const low of ["1.0001", NaN, Infinity, -1, "", "1e2", "4294967.296"])
    assert.throws(() => bandPatch(0, low, "4294967.295"));
  assert.throws(() => bandPatch(0, "2", "1"));
  assert.throws(() => bandPatch(33, "1", "2"));
  assert.doesNotThrow(() => bandPatch(32, "4294967.295", "4294967.295"));
});

test("string candidates require a terminator and honor range/capacity", () => {
  const bytes = Uint8Array.from([
    255,
    ...Buffer.from("Hello\0\0World\0unterminated"),
  ]);
  assert.deepEqual(scanStrings(bytes), [
    { offset: 1, size: 7, maxLength: 6, text: "Hello" },
    { offset: 8, size: 6, maxLength: 5, text: "World" },
  ]);
  assert.equal(scanStrings(bytes, { start: 1, end: 6 }).length, 0);
  assert.equal(scanStrings(bytes, { maxFieldSize: 6 })[0].size, 6);
  assert.equal(
    Buffer.from(patchString(bytes, 1, 7, "Hi")).toString(),
    "Hi\0\0\0\0\0",
  );
  assert.throws(() => patchString(bytes, 1, 7, "1234567"));
  assert.throws(() => patchString(bytes, 1, 8, "Hi"));
  assert.throws(() => patchString(bytes, 1, 7, "é"));
});

test("text edits preserve printf types, widths, order and star arguments", () => {
  const source = "Speed %3d / %.*f %%";
  const bytes = new Uint8Array(80);
  bytes.set(Buffer.from(source));
  assert.doesNotThrow(() => patchString(bytes, 0, 80, "New %3d / %.*f 100%%"));
  for (const text of [
    "Speed %d / %.*f",
    "Speed %3d / %f",
    "Speed %.*f / %3d",
    "Speed %3d / %.*f %n",
    "Speed %3d / %.*f %",
  ])
    assert.throws(() => patchString(bytes, 0, 80, text));
  const vendor = new Uint8Array(50);
  vendor.set(Buffer.from("V %I64d"));
  assert.doesNotThrow(() => patchString(vendor, 0, 50, "Value %I64d"));
  assert.throws(() => patchString(vendor, 0, 50, "V %I64s"));
});

test("bitmap formats match MSB row stride and RGB565 little endian", () => {
  const b1 = Uint8Array.of(0b10100000, 0b01000000);
  assert.deepEqual(
    encodeBitmap(decodeBitmap(b1, 3, 2, "1bpp"), 3, 2, "1bpp"),
    b1,
  );
  const b2 = Uint8Array.of(0b00011011, 0b10000000, 0b11100100, 0b01000000);
  assert.deepEqual(
    encodeBitmap(decodeBitmap(b2, 5, 2, "2bpp"), 5, 2, "2bpp"),
    b2,
  );
  const b565 = Uint8Array.of(0, 0xf8, 0xe0, 7, 31, 0, 0xff, 0xff);
  assert.deepEqual(
    encodeBitmap(decodeBitmap(b565, 2, 2, "rgb565"), 2, 2, "rgb565"),
    b565,
  );
  assert.deepEqual(
    Array.from(decodeBitmap(b565, 2, 2, "rgb565").slice(0, 4)),
    [248, 0, 0, 255],
  );
  assert.throws(() => decodeBitmap(b1, 4, 4, "1bpp"));
  assert.throws(() => bitmapLength(1.1, 2, "1bpp"));
  assert.throws(() => bitmapLength(4096, 4096, "rgb565"));
  assert.throws(() => encodeBitmap(new Uint8Array(3), 1, 1, "1bpp"));
  for (const [format, width, original] of [
    ["1bpp", 3, Uint8Array.of(0xbf, 0x5d)],
    ["2bpp", 5, Uint8Array.of(0x1b, 0xbf, 0xe4, 0x5d)],
  ]) {
    assert.deepEqual(
      encodeBitmap(
        decodeBitmap(original, width, 2, format),
        width,
        2,
        format,
        original,
      ),
      original,
    );
  }
});

test("all documented glyphs and scan tiles have bounded, exact bitmap metadata", () => {
  assert.equal(
    FONT_PRESETS.reduce((n, f) => n + f.count, 0),
    178,
  );
  assert.equal(
    GRAPHICS_PRESETS.filter((p) => p.group === "Font glyphs").length,
    178,
  );
  assert.equal(
    GRAPHICS_PRESETS.filter((p) => p.id.startsWith("scan-")).length,
    31,
  );
  assert.equal(
    new Set(GRAPHICS_PRESETS.map((p) => p.id)).size,
    GRAPHICS_PRESETS.length,
  );
  for (const p of GRAPHICS_PRESETS) {
    assert.equal(p.length, bitmapLength(p.width, p.height, p.format));
    assert.ok(p.offset >= 0x1fbca && p.offset + p.length <= 0x2df76);
  }
  const glyph = GRAPHICS_PRESETS.find((p) => p.id === "font-main-32");
  assert.equal(glyph.offset, 0x2c025);
  assert.equal(glyph.widthOffset, 0x2c024);
});

test("LZSS encoder supports overlapping matches, zeros and long literals", () => {
  const patterns = [
    new Uint8Array(),
    new Uint8Array(1310),
    Uint8Array.from({ length: 1024 }, (_, i) => i % 251),
    Uint8Array.from({ length: 1000 }, (_, i) => i % 7),
    Uint8Array.of(7, 8, 9),
    Uint8Array.from({ length: 1300 }, (_, i) => (i * 17 + (i >>> 4)) & 255),
  ];
  for (const bytes of patterns) {
    const encoded = compressLzss(bytes),
      result = decompressLzss(encoded, 0, bytes.length);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.consumed, encoded.length);
  }
  assert.throws(() => decompressLzss(Uint8Array.of(0x19, 0), 0, 3), /distance/);
  assert.throws(
    () => decompressLzss(Uint8Array.of(0x17, 1), 0, 7),
    /Truncated/,
  );
  assert.throws(() => decompressLzss(Uint8Array.of(0xf1), 0, 3), /exceeds/);
});

test("scan motion no-op is byte-exact and editing changes only decompressed frames", () => {
  const data = new Uint8Array(SCAN_DATA.outputLength);
  data.set([1, 2, 3, 4], 20);
  const ui = new Uint8Array(SCAN_DATA.offset + SCAN_DATA.capacity).fill(255),
    encoded = compressLzss(data);
  ui.set(encoded, SCAN_DATA.offset);
  const frames = readScanFrames(ui),
    original = ui.slice(SCAN_DATA.offset);
  assert.deepEqual(makeScanFramesPatch(ui, frames).bytes, original);
  frames[1][3] = 4;
  const patch = makeScanFramesPatch(ui, frames);
  const actual = decompressLzss(patch.bytes, 0, SCAN_DATA.outputLength).bytes;
  data[SCAN_DATA.frameOffset + 11] = 4;
  assert.deepEqual(actual, data);
  assert.equal(patch.bytes.length, SCAN_DATA.capacity);
  assert.equal(patch.offset, SCAN_DATA.offset);
  frames[1][3] = 5;
  assert.throws(() => makeScanFramesPatch(ui, frames));
});

const records = [
  {
    lat: 12.345678901,
    lon: -123.45678901,
    type: 1,
    speed: 55,
    mode: 1,
    category: 2,
    heading: 360,
    tail: 65535,
  },
  {
    lat: -20,
    lon: 3.14159265,
    type: 2,
    speed: 0,
    mode: 2,
    category: 1,
    heading: 1,
    tail: 123,
  },
  {
    lat: 12.345678901,
    lon: 33,
    type: 17,
    speed: 255,
    mode: 255,
    category: 0,
    heading: 90,
    tail: 0,
  },
];
test("LRDB round-trip preserves float32, fields, stable order and footer count", () => {
  const { body, footer } = encodeGpsDatabase(records, 20261015);
  const db = decodeGpsDatabase(body, footer);
  assert.equal(body.length, 512);
  assert.equal(db.count, 3);
  assert.equal(db.date, 20261015);
  assert.equal(db.records[0].lat, Math.fround(records[0].lat));
  assert.equal(db.records[1].type, 17);
  assert.equal(db.records[2].tail, 123);
  const rebuilt = encodeGpsDatabase(db.records, db.date);
  assert.deepEqual(rebuilt.body, body);
  assert.deepEqual(rebuilt.footer, footer);
  const raw = decodeOldModel(210, body);
  assert.equal(raw[8], 1);
  assert.equal(raw[9], 55);
  assert.equal(raw[10], 1);
  assert.equal(raw[11], 2);
  assert.ok(raw.subarray(48).every((b) => b === 255));
  const containerRecord = buildGpsRecord(records, 20261015);
  assert.equal(Buffer.from(containerRecord.subarray(0, 4)).toString(), "GPSD");
  assert.equal(new DataView(containerRecord.buffer).getUint32(4, true), 12);
  assert.equal(new DataView(containerRecord.buffer).getUint32(8, true), 524);
  assert.equal(Buffer.from(containerRecord.slice(-7)).toString(), "DRSWGDB");
});

test("GPS boundaries reject NaN, calendar errors, invalid headings and count mismatch", () => {
  for (const bad of [
    { lat: NaN },
    { lon: Infinity },
    { lat: 91 },
    { lon: -181 },
    { type: 256 },
    { speed: 1.1 },
    { heading: 0 },
    { heading: 361 },
    { tail: 65536 },
  ])
    assert.throws(() =>
      encodeGpsDatabase([{ ...records[0], ...bad }], 20261015),
    );
  assert.throws(() => encodeGpsDatabase(records, 20260229));
  assert.throws(() =>
    encodeGpsDatabase(Array(65536).fill(records[0]), 20261015),
  );
  assert.doesNotThrow(() => encodeGpsDatabase(records, 20240229));
  const { body, footer } = encodeGpsDatabase(records, 20261015),
    count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, 2, true);
  footer.set(encodeOldModel(210, count));
  assert.throws(() => decodeGpsDatabase(body, footer), /count/);
  assert.deepEqual(
    decodeGpsDatabase(...Object.values(encodeGpsDatabase([], 20261015)))
      .records,
    [],
  );
});

test("GPS CSV preserves binary fields and rejects ambiguous or malformed inputs", () => {
  const first = encodeGpsDatabase(records, 20261015),
    parsed = parseGpsCsv(gpsToCsv(records)),
    second = encodeGpsDatabase(parsed, 20261015);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(second.footer, first.footer);
  const signedZero = [{ ...records[0], lat: -0, lon: -0 }];
  assert.deepEqual(
    encodeGpsDatabase(parseGpsCsv(gpsToCsv(signedZero)), 20261015).body,
    encodeGpsDatabase(signedZero, 20261015).body,
  );
  assert.equal(
    parseGpsCsv('\uFEFF"lat","lon","type"\r\n"1.5","-2.25","speed"\r\n')[0]
      .type,
    1,
  );
  for (const text of [
    "lat,lon\n,1",
    "lat,lon\nNaN,1",
    "lat,lon\nInfinity,1",
    "lat,lon\n0x10,1",
    'lat,lon\n"1,2',
    'lat,lon\n"1"x,2',
    "lat,lat,lon\n1,1,2",
    "lat,lon,unknown\n1,2,3",
    "lat,lon\n1,2,3",
  ])
    assert.throws(() => parseGpsCsv(text));
});

test("sound directory exposes bounded inclusive clip spans without guessing audio codec", () => {
  const bytes = new Uint8Array(256).fill(255);
  bytes[0] = 0xc0;
  const u24 = (o, n) => {
    bytes[o] = n & 255;
    bytes[o + 1] = (n >>> 8) & 255;
    bytes[o + 2] = (n >>> 16) & 255;
  };
  u24(0x17, 100);
  u24(0x1a, 149);
  u24(0x1d, 150);
  u24(0x20, 200);
  assert.deepEqual(readSoundDirectory(bytes), [
    { index: 0, offset: 100, start: 100, end: 149, length: 50 },
    { index: 1, offset: 150, start: 150, end: 200, length: 51 },
  ]);
  u24(0x20, 300);
  assert.throws(() => readSoundDirectory(bytes));
});
