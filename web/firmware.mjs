/**
 * Browser-local container inspection and bounded R7 UI edits.
 *
 * The old-model transform is ported from tools/r7_unpack.py (AGPL-3.0;
 * original container research: AngeloD2022/uniden-firmware-tool).
 * No firmware bytes are bundled. All offsets are decoded ui_nu offsets.
 */
export const MAX_FILE_SIZE = 32 * 1024 * 1024;
export const LOGO_WIDTH = 176;
export const LOGO_HEIGHT = 60;
const LOGO_OFFSET = 0x2d526;
const LOGO_SIZE = LOGO_WIDTH * LOGO_HEIGHT / 4;
const RAMP = [0, 90, 180, 255];
export const TEXT_FIELDS = Object.freeze([
  Object.freeze({ id: 'selfTest', label: 'Self-test text', maxLength: 11, offset: 0x2268, size: 12 }),
  Object.freeze({ id: 'owner1', label: 'Alert Display #1 label', maxLength: 19, offset: 0xa458, size: 20 }),
  Object.freeze({ id: 'owner2', label: 'Alert Display #2 label', maxLength: 19, offset: 0xa478, size: 20 }),
]);

const PROFILE = Object.freeze({
  ui_nu: { key: 182, version: 153, logicalSize: 0x2f8d8, size: 195072,
    sha256: '1779f7dd5eb5e6cf0c6831aa230e0b4a911009f6456b6daf9dbd26bd36293a6f' },
  dsp_nu: { key: 184, version: 150, logicalSize: 0x1bfe0, size: 114688,
    sha256: 'feb85e6dfff8eb23c095beafc6d028c15e3da446c6954d0266e11c1ddcba2a9d' },
  gps_nu: { key: 183, version: 127, logicalSize: 0x9eac, size: 40960,
    sha256: 'a33c5ec9f01f1c91d4c4f9983b847c1f327134c8f8b4dd923610e03a5cffd607' },
});
const CODE_TERMS = { ui_nu: 'DRSWMAI', dsp_nu: 'DRSWDSP', gps_nu: 'DRSWSUB' };
const TAG_TERMS = { STUI: 'DRSWSTU', STDS: 'DRSWSTD', STGP: 'DRSWSTG' };
const IMAGE_TAGS = new Set(['BLES', 'KEYS', 'LSRS', 'STUI', 'STDS', 'STGP', 'N2UI', 'N2DS', 'N3DS', 'N2GP', 'N3GP']);
const SUPPORTED_LAYOUT = 'ui_nu,dsp_nu,gps_nu,sound_dbnu,GPSD:LRDB,STUI,STDS,STGP,STSD,NMGF';
const snapshots = new WeakMap();

function inputBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('Expected a firmware ArrayBuffer or Uint8Array.');
}

function checkCodecInput(key, value) {
  if (!Number.isInteger(key) || key < 0 || key > 255) throw new RangeError('Codec key must be a byte.');
  const bytes = inputBytes(value);
  if (bytes.length % 4) throw new RangeError('Encoded sections must contain complete four-byte groups.');
  return bytes;
}

export function decodeOldModel(key, value) {
  const source = checkCodecInput(key, value);
  const result = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 4) {
    for (let p = 0; p < 4; p++) {
      let v = 0;
      for (let j = 0; j < 4; j++) v |= ((source[i + j] >>> (2 * p)) & 3) << (2 * j);
      result[i + p] = (v - key) & 255;
    }
  }
  return result;
}

export function encodeOldModel(key, value) {
  const source = checkCodecInput(key, value);
  const result = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 4) {
    for (let j = 0; j < 4; j++) {
      let v = 0;
      for (let p = 0; p < 4; p++) v |= (((source[i + p] + key) & 255) >>> (2 * j) & 3) << (2 * p);
      result[i + j] = v;
    }
  }
  return result;
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 requires HTTPS or a localhost browser session.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Parse every record to its end. Unknown or truncated framing is never guessed. */
function parseContainer(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sections = [];
  const seen = new Set();
  function requireRange(offset, size, label) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > bytes.length - size) {
      throw new Error(`Truncated or invalid ${label} at file offset 0x${offset.toString(16)}.`);
    }
  }
  function u32(offset, label = 'length field') { requireRange(offset, 4, label); return view.getUint32(offset, true); }
  function ascii(offset, length) { requireRange(offset, length, 'record'); return String.fromCharCode(...bytes.subarray(offset, offset + length)); }
  function expect(offset, text, label) {
    if (ascii(offset, text.length) !== text) throw new Error(`Invalid ${label} at file offset 0x${offset.toString(16)}.`);
  }
  function add(section) {
    if (seen.has(section.name)) throw new Error(`Duplicate ${section.name} record.`);
    seen.add(section.name);
    sections.push(Object.freeze(section));
  }
  function rounded(size, unit = 512) { return size === 0 ? 0 : (Math.floor(size / unit) + 1) * unit; }
  function image(name, offset, size, logicalSize, expectedTerm) {
    requireRange(offset, size + 9, `${name} payload and trailer`);
    const trailer = offset + size;
    const word = view.getUint16(trailer, true);
    const term = ascii(trailer + 2, 7);
    if ((expectedTerm && term !== expectedTerm) || !/^DRSW[A-Z0-9]{3}$/.test(term)) {
      throw new Error(`Invalid ${name} section terminator.`);
    }
    add({ name, offset, size, logicalSize, version: word & 0x3ff, model: word >>> 10 });
    return trailer + 9;
  }

  requireRange(0, 12, 'container header');
  const first = u32(0);
  if ((first >>> 24) > 1) throw new Error('Unrecognized container header flags.');
  const lengths = [first & 0xffffff, u32(4), u32(8)];
  let pos = 12;
  let soundSize = 0;
  if (first >>> 24 & 1) {
    expect(pos, 'SNDD', 'sound header');
    if (u32(pos + 4) !== 12) throw new Error('Invalid sound header length.');
    soundSize = u32(pos + 8);
    if (soundSize < 12) throw new Error('Invalid sound section length.');
    pos += 12;
  }
  for (const [index, name] of ['ui_nu', 'dsp_nu', 'gps_nu'].entries()) {
    if (lengths[index]) pos = image(name, pos, rounded(lengths[index]), lengths[index], CODE_TERMS[name]);
  }
  if (soundSize) {
    requireRange(pos, soundSize + 7, 'sound payload and footer');
    expect(pos + soundSize, 'DRSWSDB', 'sound terminator');
    add({ name: 'sound_dbnu', offset: pos, size: soundSize - 12, version: null });
    pos += soundSize + 7;
  }
  while (pos < bytes.length) {
    requireRange(pos, 12, 'tagged record header');
    const tag = ascii(pos, 4);
    const headerSize = u32(pos + 4);
    const size = u32(pos + 8);
    if (tag === 'NMGF') {
      if (headerSize !== 0 || size !== 100) throw new Error('Unrecognized merge-container footer.');
      if (pos + 12 !== bytes.length) throw new Error('Unexpected data after the merge-container footer.');
      add({ name: 'NMGF', offset: pos, size: 12, version: size });
      return sections;
    }
    if (headerSize !== 12) throw new Error(`Invalid record header at file offset 0x${pos.toString(16)}.`);
    const body = pos + 12;
    if (tag === 'GPSD' || tag === 'GASD') {
      if (size < 12) throw new Error('Invalid GPS database length.');
      const extra = tag === 'GASD' ? 2 : 0;
      requireRange(body, size + extra + 7, `${tag} payload and footer`);
      const ident = ascii(body + size - 4, 4);
      if (!['LRDB', 'DFDB', 'IRDB'].includes(ident)) throw new Error('Unrecognized GPS database encoding.');
      expect(body + size + extra, 'DRSWGDB', 'GPS database terminator');
      add({ name: `${tag}:${ident}`, offset: body, size: size - 12, version: null });
      pos = body + size + extra + 7;
    } else if (IMAGE_TAGS.has(tag)) {
      if (!size) throw new Error(`Invalid ${tag} section length.`);
      pos = image(tag, body, rounded(size, tag === 'BLES' ? 1024 : 512), size, TAG_TERMS[tag]);
    } else if (tag === 'STSD') {
      if (size < 12) throw new Error(`Invalid ${tag} sound length.`);
      requireRange(body, size + 7, `${tag} payload and footer`);
      // Like SNDD, clen includes the opaque 12-byte sound footer. The older
      // Python inventory parser skips this footer incorrectly for STSD.
      const term = ascii(body + size, 7);
      if (term !== 'DRSWSTS') {
        throw new Error(`Invalid ${tag} sound terminator.`);
      }
      add({ name: tag, offset: body, size: size - 12, version: null });
      pos = body + size + 7;
    } else {
      throw new Error(`Unrecognized section tag at file offset 0x${pos.toString(16)}.`);
    }
  }
  throw new Error('The merge-container footer is missing.');
}

function readText(ui, field) {
  const bytes = ui.subarray(field.offset, field.offset + field.size);
  const end = bytes.indexOf(0);
  if (end < 0 || end > field.maxLength || bytes.subarray(0, end).some((b) => b < 32 || b > 126) || bytes.subarray(end).some((b) => b !== 0)) {
    throw new Error(`The ${field.label} slot is not a supported null-padded ASCII string.`);
  }
  return String.fromCharCode(...bytes.subarray(0, end));
}

function readLogo(ui) {
  const pixels = new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT);
  for (let i = 0; i < pixels.length; i++) pixels[i] = RAMP[ui[LOGO_OFFSET + (i >>> 2)] >>> ((3 - i % 4) * 2) & 3];
  return pixels;
}

/** Public arrays are copies; a private snapshot is the authority for export. */
export async function inspectFirmware(value) {
  const input = inputBytes(value);
  if (input.length > MAX_FILE_SIZE) throw new Error('Firmware files must be 32 MiB or smaller.');
  if (input.length < 24) throw new Error('This file is too short to be a merged Uniden firmware container.');
  const bytes = input.slice();
  const sections = parseContainer(bytes);
  const fileHash = await sha256(bytes);
  let supported = true;
  let reason = 'Verified R7 v153.150.127 code profile. Text and boot-logo editing are available.';
  let ui = null;
  let texts = null;
  let logoPixels = null;
  if (sections.map((section) => section.name).join(',') !== SUPPORTED_LAYOUT) {
    supported = false;
    reason = 'Inspection only: this container layout differs from the verified R7 merged firmware.';
  }
  for (const [name, profile] of Object.entries(PROFILE)) {
    if (!supported) break;
    const section = sections.find((item) => item.name === name);
    if (!section || section.model !== 7 || section.version !== profile.version || section.size !== profile.size || section.logicalSize !== profile.logicalSize) {
      supported = false;
      reason = 'Inspection only: editing requires the verified R7 v153.150.127 code profile.';
      break;
    }
    const decoded = decodeOldModel(profile.key, bytes.subarray(section.offset, section.offset + section.size));
    const fingerprint = decoded.slice();
    if (name === 'ui_nu') {
      ui = decoded;
      for (const field of TEXT_FIELDS) fingerprint.fill(0, field.offset, field.offset + field.size);
      fingerprint.fill(0, LOGO_OFFSET, LOGO_OFFSET + LOGO_SIZE);
    }
    if (await sha256(fingerprint) !== profile.sha256) {
      supported = false;
      reason = `Inspection only: ${name} differs from the verified R7 code outside the editable ranges.`;
      break;
    }
  }
  if (supported) {
    try {
      texts = Object.freeze(Object.fromEntries(TEXT_FIELDS.map((field) => [field.id, readText(ui, field)])));
      logoPixels = readLogo(ui);
    } catch (error) {
      supported = false;
      reason = `Inspection only: ${error.message}`;
      texts = null;
    }
  }
  const model = Object.freeze({ bytes: bytes.slice(), sha256: fileHash, supported, reason,
    sections: Object.freeze(sections), texts, logoPixels, fileSize: bytes.length });
  snapshots.set(model, { bytes, sha256: fileHash, supported, sections, ui, texts });
  return model;
}

function sameBytes(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

/** Export only the allowlisted decoded UI ranges; all other file bytes survive. */
export async function exportFirmware(model, options = {}) {
  const snapshot = snapshots.get(model);
  if (!snapshot?.supported) throw new Error('Load a verified, supported firmware before exporting edits.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Edits must be an object.');
  for (const key of Object.keys(options)) if (!['texts', 'logoPixels'].includes(key)) throw new Error(`Unknown edit option: ${key}.`);
  const textEdits = options.texts ?? {};
  if (typeof textEdits !== 'object' || Array.isArray(textEdits)) throw new TypeError('Text edits must be an object.');
  for (const key of Object.keys(textEdits)) if (!TEXT_FIELDS.some((field) => field.id === key)) throw new Error(`Unknown text field: ${key}.`);
  const edited = snapshot.ui.slice();
  const changes = [];
  const ranges = [];
  for (const field of TEXT_FIELDS) {
    if (!Object.hasOwn(textEdits, field.id)) continue;
    const text = textEdits[field.id];
    if (typeof text !== 'string' || !/^[\x20-\x7e]*$/.test(text)) throw new Error(`${field.label} must contain printable ASCII characters only.`);
    if (text.length > field.maxLength) throw new Error(`${field.label} must be ${field.maxLength} characters or fewer.`);
    if (text === snapshot.texts[field.id]) continue;
    edited.fill(0, field.offset, field.offset + field.size);
    for (let i = 0; i < text.length; i++) edited[field.offset + i] = text.charCodeAt(i);
    changes.push({ label: field.label, before: snapshot.texts[field.id], after: text });
    ranges.push({ section: 'ui_nu', offset: field.offset, size: field.size, type: 'text', field: field.id });
  }
  if (options.logoPixels != null) {
    const pixels = options.logoPixels;
    if (!(pixels instanceof Uint8Array) || pixels.length !== LOGO_WIDTH * LOGO_HEIGHT || pixels.some((value) => !RAMP.includes(value))) {
      throw new Error('The boot logo must contain 176 × 60 pixels using shades 0, 90, 180, and 255.');
    }
    const packed = new Uint8Array(LOGO_SIZE);
    for (let i = 0; i < pixels.length; i++) packed[i >>> 2] |= RAMP.indexOf(pixels[i]) << ((3 - i % 4) * 2);
    if (!sameBytes(packed, snapshot.ui.subarray(LOGO_OFFSET, LOGO_OFFSET + LOGO_SIZE))) {
      edited.set(packed, LOGO_OFFSET);
      changes.push({ label: 'Boot logo', before: 'Original 176 × 60 image', after: 'Edited 176 × 60 image' });
      ranges.push({ section: 'ui_nu', offset: LOGO_OFFSET, size: LOGO_SIZE, type: '2bpp-image' });
    }
  }
  const bytes = snapshot.bytes.slice();
  const uiSection = snapshot.sections.find((section) => section.name === 'ui_nu');
  if (changes.length) bytes.set(encodeOldModel(PROFILE.ui_nu.key, edited), uiSection.offset);
  let changedBytes = 0;
  for (let i = uiSection.offset; i < uiSection.offset + uiSection.size; i++) if (bytes[i] !== snapshot.bytes[i]) changedBytes++;
  const outputHash = changes.length ? await sha256(bytes) : snapshot.sha256;
  return { bytes, changes, manifest: {
    schemaVersion: 1,
    tool: 'Uniden Firmware Workbench',
    profile: 'R7 v153.150.127',
    inputSha256: snapshot.sha256,
    outputSha256: outputHash,
    inputSize: snapshot.bytes.length,
    outputSize: bytes.length,
    changedBytes,
    editedRanges: ranges,
    changes,
    validation: 'Code fingerprints verified; edits restricted to listed decoded UI ranges. Hardware behavior has not been tested by this web tool.',
  } };
}
