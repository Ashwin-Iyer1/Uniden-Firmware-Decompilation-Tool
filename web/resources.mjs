/** R7 v153.150.127 resource formats. Offsets are decoded-section offsets.
 * Metadata only: no manufacturer firmware, artwork, fonts or sound is bundled.
 */
import { decodeOldModel, encodeOldModel, inputBytes } from "./binary.mjs";

const view = (bytes) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (bytes) =>
  Array.from(bytes, (b) => String.fromCharCode(b)).join("");
const asciiBytes = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));
function integer(value, min, max, label) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new RangeError(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function span(bytes, offset, length) {
  integer(offset, 0, bytes.length, "Offset");
  integer(length, 0, bytes.length - offset, "Length");
}

export const BAND_TABLE = Object.freeze({
  offset: 0xdd34,
  count: 33,
  stride: 16,
});
const BAND_NAMES = {
  1: "X",
  2: "K",
  3: "Ka (low mix)",
  4: "Ka (high mix)",
  6: "Ka (narrow)",
  7: "K (alternate)",
  8: "Spot / instant",
};
export function readBands(value) {
  const bytes = inputBytes(value),
    v = view(bytes);
  span(bytes, BAND_TABLE.offset, BAND_TABLE.count * BAND_TABLE.stride);
  return Array.from({ length: BAND_TABLE.count }, (_, index) => {
    const offset = BAND_TABLE.offset + index * BAND_TABLE.stride,
      bandType = v.getUint32(offset, true);
    return {
      index,
      offset,
      bandType,
      bandName: BAND_NAMES[bandType] ?? `Type ${bandType}`,
      lowKhz: v.getUint32(offset + 4, true),
      highKhz: v.getUint32(offset + 8, true),
      ifConstant: v.getUint32(offset + 12, true),
    };
  });
}
function mhzToKhz(value) {
  // Decimal parsing avoids rounding a fourth fractional digit into a new band edge.
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(text))
    throw new RangeError(
      "Frequency must be nonnegative MHz with at most three decimal places.",
    );
  const [whole, fractional = ""] = text.split(".");
  const khz = Number(whole) * 1000 + Number(fractional.padEnd(3, "0"));
  return integer(khz, 0, 0xffffffff, "Frequency in kHz");
}
export function bandPatch(index, lowMHz, highMHz) {
  integer(index, 0, BAND_TABLE.count - 1, "Band index");
  const low = mhzToKhz(lowMHz),
    high = mhzToKhz(highMHz);
  if (low > high)
    throw new RangeError("Band start must be less than or equal to band end.");
  const bytes = new Uint8Array(8),
    v = view(bytes);
  v.setUint32(0, low, true);
  v.setUint32(4, high, true);
  return {
    section: "dsp_nu",
    offset: BAND_TABLE.offset + index * BAND_TABLE.stride + 4,
    bytes,
    decoded: true,
  };
}

/** Candidates require a NUL terminator; they are not a claim that code is text. */
export function scanStrings(
  value,
  { minLength = 3, start = 0, end, maxFieldSize = 512 } = {},
) {
  const bytes = inputBytes(value);
  end ??= bytes.length;
  integer(minLength, 1, 4096, "Minimum string length");
  integer(maxFieldSize, 1, 65536, "Maximum string field");
  span(bytes, start, end - start);
  const result = [];
  for (let i = start; i < end;) {
    if (bytes[i] < 32 || bytes[i] > 126) {
      i++;
      continue;
    }
    const offset = i;
    while (i < end && bytes[i] >= 32 && bytes[i] <= 126) i++;
    const length = i - offset;
    if (
      i === end ||
      bytes[i] !== 0 ||
      length < minLength ||
      length >= maxFieldSize
    )
      continue;
    let stop = i + 1;
    while (stop < end && bytes[stop] === 0 && stop - offset < maxFieldSize)
      stop++;
    result.push({
      offset,
      size: stop - offset,
      maxLength: stop - offset - 1,
      text: ascii(bytes.subarray(offset, i)),
    });
    i = stop;
  }
  return result;
}
function formatSignature(text) {
  const tokens = [],
    spec =
      /^%(?:\d+\$)?[-+#0 ']*(?:\d+|\*(?:\d+\$)?)?(?:\.(?:\d*|\*(?:\d+\$)?))?(?:hh|ll|[hljztL])?[diuoxXfFeEgGaAcspn]/;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "%") continue;
    if (text[i + 1] === "%") {
      i++;
      continue;
    }
    const match = text.slice(i).match(spec);
    if (match) {
      tokens.push(match[0]);
      i += match[0].length - 1;
    } else {
      // Vendor/unsupported specifiers may still consume arguments. Preserve
      // their entire non-whitespace spelling instead of treating them as %.
      const unknown = text.slice(i).match(/^%[^\s%]*/)[0];
      tokens.push(unknown);
      i += unknown.length - 1;
    }
  }
  return JSON.stringify(tokens);
}
export function patchString(value, offset, size, text) {
  const bytes = inputBytes(value);
  span(bytes, offset, size);
  if (!size)
    throw new RangeError("A string field must include a NUL terminator.");
  if (typeof text !== "string" || /[^\x20-\x7e]/.test(text))
    throw new RangeError("Text must use printable ASCII characters.");
  const field = bytes.subarray(offset, offset + size),
    zero = field.indexOf(0);
  if (zero < 0 || field.subarray(zero).some((b) => b !== 0))
    throw new RangeError(
      "String field must contain text followed only by NUL padding.",
    );
  if (text.length >= size)
    throw new RangeError(`Text is limited to ${size - 1} characters.`);
  if (formatSignature(ascii(field.subarray(0, zero))) !== formatSignature(text))
    throw new RangeError(
      "Keep printf format tokens unchanged and in their original order. Use %% for a new literal percent sign.",
    );
  const result = new Uint8Array(size);
  result.set(asciiBytes(text));
  return result;
}

export function bitmapLength(width, height, format) {
  integer(width, 1, 4096, "Bitmap width");
  integer(height, 1, 4096, "Bitmap height");
  if (!["1bpp", "2bpp", "rgb565"].includes(format))
    throw new RangeError("Bitmap format must be 1bpp, 2bpp or rgb565.");
  const length =
    (format === "rgb565"
      ? width * 2
      : Math.ceil(width / (format === "1bpp" ? 8 : 4))) * height;
  if (width * height > 1048576)
    throw new RangeError("Bitmap is limited to 1,048,576 pixels.");
  return length;
}
export function decodeBitmap(value, width, height, format) {
  const bytes = inputBytes(value),
    length = bitmapLength(width, height, format);
  span(bytes, 0, length);
  const rgba = new Uint8ClampedArray(width * height * 4),
    stride = length / height;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (format === "rgb565") {
        const off = y * stride + x * 2,
          v = bytes[off] | (bytes[off + 1] << 8);
        rgba[p] = ((v >>> 11) & 31) << 3;
        rgba[p + 1] = ((v >>> 5) & 63) << 2;
        rgba[p + 2] = (v & 31) << 3;
      } else {
        const bits = format === "1bpp" ? 1 : 2,
          perByte = 8 / bits;
        const v =
          (bytes[y * stride + Math.floor(x / perByte)] >>>
            ((perByte - 1 - (x % perByte)) * bits)) &
          ((1 << bits) - 1);
        rgba[p] =
          rgba[p + 1] =
          rgba[p + 2] =
            bits === 1 ? v * 255 : [0, 90, 180, 255][v];
      }
      rgba[p + 3] = 255;
    }
  return rgba;
}
export function encodeBitmap(rgba, width, height, format, originalBytes) {
  const length = bitmapLength(width, height, format);
  if (
    !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) ||
    rgba.length !== width * height * 4
  )
    throw new RangeError(
      "Image must contain exactly width × height RGBA pixels.",
    );
  const bytes = new Uint8Array(length),
    stride = length / height;
  const original =
    originalBytes === undefined ? null : inputBytes(originalBytes);
  if (original && original.length !== length)
    throw new RangeError(
      "Original bitmap bytes must match the bitmap allocation exactly.",
    );
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4,
        r = rgba[p],
        g = rgba[p + 1],
        b = rgba[p + 2];
      if (format === "rgb565") {
        const v = ((r >>> 3) << 11) | ((g >>> 2) << 5) | (b >>> 3),
          off = y * stride + x * 2;
        bytes[off] = v & 255;
        bytes[off + 1] = v >>> 8;
      } else {
        const bits = format === "1bpp" ? 1 : 2,
          perByte = 8 / bits,
          lum = Math.floor((r + g + b) / 3);
        const v =
          bits === 1
            ? lum >= 128
              ? 1
              : 0
            : Math.min(3, Math.floor((lum * 4) / 256));
        bytes[y * stride + Math.floor(x / perByte)] |=
          v << ((perByte - 1 - (x % perByte)) * bits);
      }
    }
  // A custom width may leave unused low bits in each row. They are not pixels;
  // retain them from the firmware so painting changes only visible pixel bits.
  if (original && format !== "rgb565") {
    const bits = format === "1bpp" ? 1 : 2,
      used = (width * bits) % 8;
    if (used) {
      const mask = (1 << (8 - used)) - 1;
      for (let y = 0; y < height; y++)
        bytes[(y + 1) * stride - 1] |= original[(y + 1) * stride - 1] & mask;
    }
  }
  return bytes;
}
export const FONT_PRESETS = Object.freeze(
  [
    {
      id: "main",
      name: "Main font",
      offset: 0x2c024,
      count: 101,
      stride: 49,
      firstChar: 0x20,
      width: 16,
      height: 24,
      widthByte: true,
    },
    {
      id: "digits16",
      name: "16×16 digits",
      offset: 0x2d379,
      count: 13,
      stride: 33,
      firstChar: 0x2d,
      width: 16,
      height: 16,
      widthByte: true,
    },
    {
      id: "digits14",
      name: "16×14 digits",
      offset: 0x2be8e,
      count: 14,
      stride: 29,
      firstChar: 0x2d,
      width: 16,
      height: 14,
      widthByte: true,
    },
    {
      id: "digits20",
      name: "16×20 digits",
      offset: 0x2ba8a,
      count: 14,
      stride: 40,
      firstChar: 0x2d,
      width: 16,
      height: 20,
      widthByte: false,
    },
    {
      id: "small13",
      name: "8×13 small font",
      offset: 0x2bd92,
      count: 18,
      stride: 14,
      firstChar: 0x28,
      width: 8,
      height: 13,
      widthByte: true,
    },
    {
      id: "small11",
      name: "8×11 small font",
      offset: 0x2bcba,
      count: 18,
      stride: 12,
      firstChar: 0x28,
      width: 8,
      height: 11,
      widthByte: true,
    },
  ].map(Object.freeze),
);
const presets = [];
function preset(id, name, offset, width, height, format, group, extra = {}) {
  presets.push(
    Object.freeze({
      id,
      name,
      offset,
      width,
      height,
      format,
      length: bitmapLength(width, height, format),
      group,
      ...extra,
    }),
  );
}
preset("boot", "Boot logo", 0x2d526, 176, 60, "2bpp", "Screens");
for (const [i, offset] of [0x2116d, 0x21bbd].entries())
  preset(
    `screen-${i}`,
    `Main background ${i + 1}`,
    offset,
    176,
    60,
    "2bpp",
    "Screens",
  );
for (const [i, name] of ["Ka", "K", "X", "POP", "MRCD", "RT3", "RT4"].entries())
  preset(
    `badge-${i}`,
    `${name} band badge`,
    0x1fcfa + i * 0x50,
    32,
    20,
    "1bpp",
    "Icons",
  );
for (const [i, offset] of [0x2260e, 0x22d16].entries())
  preset(
    `laser-${i}`,
    `Laser burst ${i ? "dim" : "bright"}`,
    offset,
    45,
    20,
    "rgb565",
    "Icons",
  );
for (const [i, name] of [
  "Red-light camera",
  "Speed camera",
  "GPS pin",
].entries())
  preset(
    `camera-${i}`,
    name,
    [0x2372a, 0x2408a, 0x249ea][i],
    40,
    30,
    "rgb565",
    "Icons",
  );
preset(
  "direction-arrow",
  "Directional arrow",
  0x2341e,
  30,
  13,
  "rgb565",
  "Icons",
);
for (let i = 0; i < 9; i++)
  preset(
    `signal-${i}`,
    `Signal strength ${i + 1}`,
    0x2534a + i * 0x804,
    114,
    9,
    "rgb565",
    "Signal strength",
  );
for (let i = 0; i < 30; i++)
  preset(
    `scan-${i}`,
    `Scan tile ${i + 1}`,
    0x29b6e + i * 176,
    11,
    8,
    "rgb565",
    "Scan tiles",
  );
preset(
  "scan-sheet",
  "All 30 scan tiles",
  0x29b6e,
  11,
  240,
  "rgb565",
  "Scan tiles",
);
for (const font of FONT_PRESETS)
  for (let i = 0; i < font.count; i++) {
    const code = font.firstChar + i,
      char =
        code >= 32 && code <= 126
          ? `“${String.fromCharCode(code)}”`
          : `0x${code.toString(16)}`;
    preset(
      `font-${font.id}-${code}`,
      `${font.name}: ${char}`,
      font.offset + i * font.stride + Number(font.widthByte),
      font.width,
      font.height,
      "1bpp",
      "Font glyphs",
      {
        charCode: code,
        fontId: font.id,
        widthOffset: font.widthByte ? font.offset + i * font.stride : null,
      },
    );
  }
export const GRAPHICS_PRESETS = Object.freeze(presets);

export const SCAN_DATA = Object.freeze({
  offset: 0x2f7ac,
  capacity: 0x254,
  outputLength: 0x514,
  frameOffset: 0x298,
  frameCount: 20,
  cellCount: 8,
});
export function decompressLzss(
  value,
  offset = 0,
  outLength = SCAN_DATA.outputLength,
) {
  const source = inputBytes(value);
  span(source, offset, 0);
  integer(outLength, 0, 1048576, "LZSS output length");
  const bytes = new Uint8Array(outLength);
  let i = offset,
    pos = 0,
    groups = 0;
  const next = () => {
    if (i >= source.length) throw new RangeError("Truncated LZSS stream.");
    return source[i++];
  };
  while (pos < outLength) {
    if (++groups > source.length)
      throw new RangeError("LZSS stream does not advance.");
    const ctrl = next();
    let literals = ctrl & 7,
      length = ctrl >>> 4;
    if (!literals) literals = next();
    if (!length) length = next();
    if (!literals) throw new RangeError("Invalid LZSS literal count.");
    if (pos + literals - 1 > outLength)
      throw new RangeError("LZSS literals exceed the expected output.");
    for (let j = 1; j < literals; j++) bytes[pos++] = next();
    if (ctrl & 8) {
      const distance = next();
      if (!distance || distance > pos)
        throw new RangeError("Invalid LZSS back-reference distance.");
      if (pos + length + 2 > outLength)
        throw new RangeError("LZSS match exceeds the expected output.");
      for (let j = 0; j < length + 2; j++) {
        bytes[pos] = bytes[pos - distance];
        pos++;
      }
    } else {
      if (pos + length > outLength)
        throw new RangeError("LZSS zero fill exceeds the expected output.");
      pos += length;
    }
  }
  return { bytes, consumed: i - offset };
}
export function compressLzss(value) {
  const bytes = inputBytes(value),
    out = [];
  let pos = 0,
    litStart = 0;
  const emit = (start, end, distance, count) => {
    const l = end - start + 1,
      m = distance ? count - 2 : count;
    const low = l <= 7 ? l : 0,
      high = m >= 1 && m <= 15 ? m : 0;
    out.push((high << 4) | (distance ? 8 : 0) | low);
    if (!low) out.push(l);
    if (!high) out.push(m);
    for (let i = start; i < end; i++) out.push(bytes[i]);
    if (distance) out.push(distance);
  };
  while (pos < bytes.length) {
    let bestLength = 0,
      bestDistance = 0,
      zeros = 0;
    for (let distance = 1; distance <= Math.min(255, pos); distance++) {
      if (bytes[pos - distance] !== bytes[pos]) continue;
      let n = 1;
      while (
        n < 257 &&
        pos + n < bytes.length &&
        bytes[pos + n] === bytes[pos - distance + n]
      )
        n++;
      if (n > bestLength) {
        bestLength = n;
        bestDistance = distance;
        if (n === 257) break;
      }
    }
    while (
      zeros < 255 &&
      pos + zeros < bytes.length &&
      bytes[pos + zeros] === 0
    )
      zeros++;
    const back = bestLength >= 3 && bestLength >= zeros;
    if (back || zeros) {
      while (pos - litStart > 254) {
        emit(litStart, litStart + 254, 0, 0);
        litStart += 254;
      }
      emit(litStart, pos, back ? bestDistance : 0, back ? bestLength : zeros);
      pos += back ? bestLength : zeros;
      litStart = pos;
    } else {
      pos++;
      while (pos - litStart > 254) {
        emit(litStart, litStart + 254, 0, 0);
        litStart += 254;
      }
    }
  }
  while (bytes.length - litStart > 254) {
    emit(litStart, litStart + 254, 0, 0);
    litStart += 254;
  }
  if (litStart < bytes.length) emit(litStart, bytes.length, 0, 0);
  return Uint8Array.from(out);
}
function scanData(value) {
  const bytes = inputBytes(value);
  span(bytes, SCAN_DATA.offset, SCAN_DATA.capacity);
  return decompressLzss(
    bytes.subarray(SCAN_DATA.offset, SCAN_DATA.offset + SCAN_DATA.capacity),
    0,
    SCAN_DATA.outputLength,
  );
}
export function readScanFrames(ui) {
  const { bytes } = scanData(ui);
  return Array.from({ length: 20 }, (_, f) =>
    Array.from(
      bytes.subarray(
        SCAN_DATA.frameOffset + f * 8,
        SCAN_DATA.frameOffset + (f + 1) * 8,
      ),
    ),
  );
}
export function makeScanFramesPatch(value, frames) {
  const ui = inputBytes(value),
    { bytes: data } = scanData(ui);
  if (
    !Array.isArray(frames) ||
    frames.length !== 20 ||
    frames.some((f) => !Array.isArray(f) || f.length !== 8)
  )
    throw new RangeError(
      "Scan motion must contain 20 frames with 8 brightness values each.",
    );
  const flat = frames.flat();
  flat.forEach((v) => integer(v, 0, 4, "Scan brightness"));
  let bytes = ui.slice(SCAN_DATA.offset, SCAN_DATA.offset + SCAN_DATA.capacity);
  if (flat.some((v, i) => v !== data[SCAN_DATA.frameOffset + i])) {
    data.set(flat, SCAN_DATA.frameOffset);
    const encoded = compressLzss(data);
    if (encoded.length > SCAN_DATA.capacity)
      throw new RangeError(
        `Scan motion needs ${encoded.length} compressed bytes; only ${SCAN_DATA.capacity} are available.`,
      );
    bytes = new Uint8Array(SCAN_DATA.capacity).fill(255);
    bytes.set(encoded);
  }
  return { section: "ui_nu", offset: SCAN_DATA.offset, bytes, decoded: true };
}

// The GPS matching code reads a 16-bit point count (FIRMWARE_MAP §3).
const MAX_POINTS = 65535;
function gpsDate(value) {
  const date =
    typeof value === "string" && /^\d{8}$/.test(value) ? Number(value) : value;
  integer(date, 10000101, 99991231, "GPS date YYYYMMDD");
  const year = Math.floor(date / 10000),
    month = Math.floor(date / 100) % 100,
    day = date % 100;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  )
    throw new RangeError(
      "GPS date must be a real calendar date in YYYYMMDD form.",
    );
  return date;
}
function gpsRecord(record) {
  if (!record || typeof record !== "object")
    throw new TypeError("GPS point must be a record.");
  const { lat, lon } = record;
  if (
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    typeof lon !== "number" ||
    !Number.isFinite(lon) ||
    lon < -180 ||
    lon > 180
  )
    throw new RangeError(
      "GPS coordinates must be finite latitude −90…90 and longitude −180…180.",
    );
  let type = record.type ?? 2;
  if (typeof type === "string")
    type = { speed: 1, redlight: 2 }[type.toLowerCase()] ?? type;
  return {
    lat: Math.fround(lat),
    lon: Math.fround(lon),
    type: integer(type, 0, 255, "GPS type"),
    speed: integer(record.speed ?? 0, 0, 255, "Speed"),
    mode: integer(record.mode ?? record.f2 ?? 2, 0, 255, "GPS mode"),
    category: integer(record.category ?? 1, 0, 255, "GPS category"),
    heading: integer(record.heading ?? 360, 1, 360, "Heading"),
    tail: integer(record.tail ?? 65535, 0, 65535, "Record tail"),
  };
}
export function decodeGpsDatabase(encodedBody, footerValue) {
  const encoded = inputBytes(encodedBody),
    footer = inputBytes(footerValue);
  if (footer.length !== 12 || ascii(footer.subarray(8)) !== "LRDB")
    throw new RangeError("Expected a 12-byte LRDB database footer.");
  if (encoded.length % 512)
    throw new RangeError(
      "LRDB database body must be padded to a 512-byte boundary.",
    );
  const count = view(decodeOldModel(210, footer.subarray(0, 4))).getUint32(
      0,
      true,
    ),
    date = gpsDate(view(footer).getUint32(4, true));
  integer(count, 0, MAX_POINTS, "GPS record count");
  if (count * 16 > encoded.length)
    throw new RangeError("GPS record count exceeds the database body.");
  const body = decodeOldModel(210, encoded),
    v = view(body),
    records = [];
  for (let i = 0; i < count; i++) {
    const o = i * 16;
    records.push(
      gpsRecord({
        lat: v.getFloat32(o, true),
        lon: v.getFloat32(o + 4, true),
        type: body[o + 8],
        speed: body[o + 9],
        mode: body[o + 10],
        category: body[o + 11],
        heading: v.getUint16(o + 12, true),
        tail: v.getUint16(o + 14, true),
      }),
    );
  }
  if (body.subarray(count * 16).some((b) => b !== 255))
    throw new RangeError(
      "GPS footer count does not match non-padding records.",
    );
  return { records, date, count };
}
export function encodeGpsDatabase(records, date) {
  if (!Array.isArray(records))
    throw new TypeError("GPS records must be an array.");
  integer(records.length, 0, MAX_POINTS, "GPS record count");
  date = gpsDate(date);
  const points = records.map(gpsRecord).sort((a, b) => b.lat - a.lat),
    rawLength = points.length * 16;
  const raw = new Uint8Array(Math.ceil(rawLength / 512) * 512).fill(255),
    v = view(raw);
  points.forEach((r, i) => {
    const o = i * 16;
    v.setFloat32(o, r.lat, true);
    v.setFloat32(o + 4, r.lon, true);
    raw.set([r.type, r.speed, r.mode, r.category], o + 8);
    v.setUint16(o + 12, r.heading, true);
    v.setUint16(o + 14, r.tail, true);
  });
  const footer = new Uint8Array(12),
    count = new Uint8Array(4);
  view(count).setUint32(0, points.length, true);
  footer.set(encodeOldModel(210, count));
  view(footer).setUint32(4, date, true);
  footer.set(asciiBytes("LRDB"), 8);
  return { body: encodeOldModel(210, raw), footer };
}
export function buildGpsRecord(records, date) {
  const { body, footer } = encodeGpsDatabase(records, date),
    result = new Uint8Array(12 + body.length + 12 + 7);
  result.set(asciiBytes("GPSD"));
  view(result).setUint32(4, 12, true);
  view(result).setUint32(8, body.length + 12, true);
  result.set(body, 12);
  result.set(footer, 12 + body.length);
  result.set(asciiBytes("DRSWGDB"), 24 + body.length);
  return result;
}
function csvRows(text) {
  if (typeof text !== "string" || text.length > 32 * 1024 * 1024)
    throw new RangeError("CSV text must be at most 32 MiB.");
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false;
  const fieldDone = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const rowDone = () => {
    fieldDone();
    if (row.some((v) => v.trim())) rows.push(row);
    row = [];
    if (rows.length > MAX_POINTS + 1)
      throw new RangeError(`CSV is limited to ${MAX_POINTS} points.`);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === ",") fieldDone();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      rowDone();
    } else if (c === '"' && !field && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new RangeError("Malformed CSV quoting.");
      field += c;
    }
  }
  if (quoted) throw new RangeError("CSV has an unterminated quoted field.");
  if (field || row.length || closed) rowDone();
  return rows;
}
export function parseGpsCsv(text) {
  const rows = csvRows(text);
  if (!rows.length) throw new RangeError("CSV is empty.");
  const headers = rows.shift().map((s) => s.trim().toLowerCase()),
    accepted = new Set([
      "lat",
      "lon",
      "type",
      "speed",
      "heading",
      "f2",
      "mode",
      "category",
      "tail",
    ]);
  if (
    new Set(headers).size !== headers.length ||
    headers.some((h) => !accepted.has(h)) ||
    !headers.includes("lat") ||
    !headers.includes("lon") ||
    (headers.includes("f2") && headers.includes("mode"))
  )
    throw new RangeError(
      "CSV needs unique lat/lon columns and optional type,speed,heading,f2,category,tail columns.",
    );
  return rows.map((values, index) => {
    if (values.length !== headers.length)
      throw new RangeError(
        `CSV row ${index + 2} has the wrong number of fields.`,
      );
    const r = {};
    headers.forEach((key, i) => {
      const val = values[i].trim();
      if (!val && key !== "lat" && key !== "lon") return;
      if (!val) throw new RangeError(`CSV row ${index + 2} is missing ${key}.`);
      if (key === "type" && /^(speed|redlight)$/i.test(val))
        r[key] = val.toLowerCase();
      else {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(val))
          throw new RangeError(`CSV row ${index + 2} has an invalid ${key}.`);
        r[key] = Number(val);
      }
    });
    try {
      return gpsRecord(r);
    } catch (error) {
      throw new RangeError(`CSV row ${index + 2}: ${error.message}`);
    }
  });
}
export function gpsToCsv(records) {
  if (!Array.isArray(records) || records.length > MAX_POINTS)
    throw new RangeError(
      `GPS records must be an array of at most ${MAX_POINTS} points.`,
    );
  const lines = ["lat,lon,type,speed,heading,f2,category,tail"];
  const coordinate = (value) => (Object.is(value, -0) ? "-0" : String(value));
  for (const record of records) {
    const r = gpsRecord(record);
    lines.push(
      [
        coordinate(r.lat),
        coordinate(r.lon),
        r.type === 1 ? "speed" : r.type === 2 ? "redlight" : r.type,
        r.speed,
        r.heading,
        r.mode,
        r.category,
        r.tail,
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
export function readSoundDirectory(value) {
  const bytes = inputBytes(value);
  if (bytes.length < 0x1d || (bytes[0] & 0xf0) !== 0xc0)
    throw new RangeError(
      "Expected an ISD3800 image with a 0xCx memory header.",
    );
  const u24 = (o) => bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16),
    clips = [];
  let start = u24(0x17),
    cursor = 0x1a;
  for (let index = 0; index < 10000; index++) {
    if (cursor + 3 > bytes.length)
      throw new RangeError("Truncated sound directory.");
    const end = u24(cursor);
    if (start < cursor + 3 || end < start || end >= bytes.length)
      throw new RangeError("Sound directory contains an invalid clip span.");
    clips.push({ index, offset: start, start, end, length: end - start + 1 });
    if (cursor + 6 > bytes.length || u24(cursor + 3) !== end + 1) return clips;
    start = end + 1;
    cursor += 6;
  }
  throw new RangeError("Sound directory exceeds 10,000 clips.");
}
