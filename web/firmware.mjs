/**
 * Browser-local container inspection and bounded R7 UI edits.
 *
 * The old-model transform is ported from tools/r7_unpack.py (AGPL-3.0;
 * original container research: AngeloD2022/uniden-firmware-tool).
 * No firmware bytes are bundled. All offsets are decoded ui_nu offsets.
 */
import {
  MAX_FILE_SIZE,
  inputBytes,
  decodeOldModel,
  encodeOldModel,
} from "./binary.mjs";
import {
  R7_PROFILE,
  UI_DATA_RANGES,
  SCAN_DATA_HASH,
  normalizedUiData,
} from "./profile.mjs";
import { differenceSummary, differencePage } from "./comparison.mjs";
export { MAX_FILE_SIZE, decodeOldModel, encodeOldModel } from "./binary.mjs";
export const LOGO_WIDTH = 176;
export const LOGO_HEIGHT = 60;
const LOGO_OFFSET = 0x2d526;
const LOGO_SIZE = (LOGO_WIDTH * LOGO_HEIGHT) / 4;
const RAMP = [0, 90, 180, 255];
export const TEXT_FIELDS = Object.freeze([
  Object.freeze({
    id: "selfTest",
    label: "Self-test text",
    maxLength: 11,
    offset: 0x2268,
    size: 12,
  }),
  Object.freeze({
    id: "owner1",
    label: "Alert Display #1 label",
    maxLength: 19,
    offset: 0xa458,
    size: 20,
  }),
  Object.freeze({
    id: "owner2",
    label: "Alert Display #2 label",
    maxLength: 19,
    offset: 0xa478,
    size: 20,
  }),
]);

const PROFILE = Object.freeze({
  ui_nu: {
    key: 182,
    version: 153,
    logicalSize: 0x2f8d8,
    size: 195072,
    sha256: "1779f7dd5eb5e6cf0c6831aa230e0b4a911009f6456b6daf9dbd26bd36293a6f",
  },
  dsp_nu: {
    key: 184,
    version: 150,
    logicalSize: 0x1bfe0,
    size: 114688,
    sha256: "feb85e6dfff8eb23c095beafc6d028c15e3da446c6954d0266e11c1ddcba2a9d",
  },
  gps_nu: {
    key: 183,
    version: 127,
    logicalSize: 0x9eac,
    size: 40960,
    sha256: "a33c5ec9f01f1c91d4c4f9983b847c1f327134c8f8b4dd923610e03a5cffd607",
  },
});
const CODE_TERMS = { ui_nu: "DRSWMAI", dsp_nu: "DRSWDSP", gps_nu: "DRSWSUB" };
const TAG_TERMS = { STUI: "DRSWSTU", STDS: "DRSWSTD", STGP: "DRSWSTG" };
const IMAGE_TAGS = new Set([
  "BLES",
  "KEYS",
  "LSRS",
  "STUI",
  "STDS",
  "STGP",
  "N2UI",
  "N2DS",
  "N3DS",
  "N2GP",
  "N3GP",
]);
const SUPPORTED_LAYOUT =
  "ui_nu,dsp_nu,gps_nu,sound_dbnu,GPSD:LRDB,STUI,STDS,STGP,STSD,NMGF";
const snapshots = new WeakMap();

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle)
    throw new Error("SHA-256 requires HTTPS or a localhost browser session.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Parse every record to its end. Unknown or truncated framing is never guessed. */
function parseContainer(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sections = [];
  const seen = new Set();
  function requireRange(offset, size, label) {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset > bytes.length - size
    ) {
      throw new Error(
        `Truncated or invalid ${label} at file offset 0x${offset.toString(16)}.`,
      );
    }
  }
  function u32(offset, label = "length field") {
    requireRange(offset, 4, label);
    return view.getUint32(offset, true);
  }
  function ascii(offset, length) {
    requireRange(offset, length, "record");
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
  }
  function expect(offset, text, label) {
    if (ascii(offset, text.length) !== text)
      throw new Error(
        `Invalid ${label} at file offset 0x${offset.toString(16)}.`,
      );
  }
  function add(section) {
    if (seen.has(section.name))
      throw new Error(`Duplicate ${section.name} record.`);
    seen.add(section.name);
    sections.push(Object.freeze(section));
  }
  function rounded(size, unit = 512) {
    return size === 0 ? 0 : (Math.floor(size / unit) + 1) * unit;
  }
  function image(name, offset, size, logicalSize, expectedTerm) {
    requireRange(offset, size + 9, `${name} payload and trailer`);
    const trailer = offset + size;
    const word = view.getUint16(trailer, true);
    const term = ascii(trailer + 2, 7);
    if (
      (expectedTerm && term !== expectedTerm) ||
      !/^DRSW[A-Z0-9]{3}$/.test(term)
    ) {
      throw new Error(`Invalid ${name} section terminator.`);
    }
    add({
      name,
      offset,
      size,
      logicalSize,
      version: word & 0x3ff,
      model: word >>> 10,
    });
    return trailer + 9;
  }

  requireRange(0, 12, "container header");
  const first = u32(0);
  if (first >>> 24 > 1) throw new Error("Unrecognized container header flags.");
  const lengths = [first & 0xffffff, u32(4), u32(8)];
  let pos = 12;
  let soundSize = 0;
  if ((first >>> 24) & 1) {
    expect(pos, "SNDD", "sound header");
    if (u32(pos + 4) !== 12) throw new Error("Invalid sound header length.");
    soundSize = u32(pos + 8);
    if (soundSize < 12) throw new Error("Invalid sound section length.");
    pos += 12;
  }
  for (const [index, name] of ["ui_nu", "dsp_nu", "gps_nu"].entries()) {
    if (lengths[index])
      pos = image(
        name,
        pos,
        rounded(lengths[index]),
        lengths[index],
        CODE_TERMS[name],
      );
  }
  if (soundSize) {
    requireRange(pos, soundSize + 7, "sound payload and footer");
    expect(pos + soundSize, "DRSWSDB", "sound terminator");
    add({
      name: "sound_dbnu",
      offset: pos,
      size: soundSize - 12,
      version: null,
    });
    pos += soundSize + 7;
  }
  while (pos < bytes.length) {
    requireRange(pos, 12, "tagged record header");
    const tag = ascii(pos, 4);
    const headerSize = u32(pos + 4);
    const size = u32(pos + 8);
    if (tag === "NMGF") {
      if (headerSize !== 0 || size !== 100)
        throw new Error("Unrecognized merge-container footer.");
      if (pos + 12 !== bytes.length)
        throw new Error("Unexpected data after the merge-container footer.");
      add({ name: "NMGF", offset: pos, size: 12, version: size });
      return sections;
    }
    if (headerSize !== 12)
      throw new Error(
        `Invalid record header at file offset 0x${pos.toString(16)}.`,
      );
    const body = pos + 12;
    if (tag === "GPSD" || tag === "GASD") {
      if (size < 12) throw new Error("Invalid GPS database length.");
      const extra = tag === "GASD" ? 2 : 0;
      requireRange(body, size + extra + 7, `${tag} payload and footer`);
      const ident = ascii(body + size - 4, 4);
      if (!["LRDB", "DFDB", "IRDB"].includes(ident))
        throw new Error("Unrecognized GPS database encoding.");
      expect(body + size + extra, "DRSWGDB", "GPS database terminator");
      add({
        name: `${tag}:${ident}`,
        offset: body,
        size: size - 12,
        version: null,
      });
      pos = body + size + extra + 7;
    } else if (IMAGE_TAGS.has(tag)) {
      if (!size) throw new Error(`Invalid ${tag} section length.`);
      pos = image(
        tag,
        body,
        rounded(size, tag === "BLES" ? 1024 : 512),
        size,
        TAG_TERMS[tag],
      );
    } else if (tag === "STSD") {
      if (size < 12) throw new Error(`Invalid ${tag} sound length.`);
      requireRange(body, size + 7, `${tag} payload and footer`);
      // Like SNDD, clen includes the opaque 12-byte sound footer. The older
      // Python inventory parser skips this footer incorrectly for STSD.
      const term = ascii(body + size, 7);
      if (term !== "DRSWSTS") {
        throw new Error(`Invalid ${tag} sound terminator.`);
      }
      add({ name: tag, offset: body, size: size - 12, version: null });
      pos = body + size + 7;
    } else {
      throw new Error(
        `Unrecognized section tag at file offset 0x${pos.toString(16)}.`,
      );
    }
  }
  throw new Error("The merge-container footer is missing.");
}

function readText(ui, field) {
  const bytes = ui.subarray(field.offset, field.offset + field.size);
  const end = bytes.indexOf(0);
  if (
    end < 0 ||
    end > field.maxLength ||
    bytes.subarray(0, end).some((b) => b < 32 || b > 126) ||
    bytes.subarray(end).some((b) => b !== 0)
  ) {
    throw new Error(
      `The ${field.label} slot is not a supported null-padded ASCII string.`,
    );
  }
  return String.fromCharCode(...bytes.subarray(0, end));
}

function readLogo(ui) {
  const pixels = new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT);
  for (let i = 0; i < pixels.length; i++)
    pixels[i] = RAMP[(ui[LOGO_OFFSET + (i >>> 2)] >>> ((3 - (i % 4)) * 2)) & 3];
  return pixels;
}

/** Public arrays are copies; a private snapshot is the authority for export. */
export async function inspectFirmware(value) {
  const input = inputBytes(value);
  if (input.length > MAX_FILE_SIZE)
    throw new Error("Firmware files must be 32 MiB or smaller.");
  if (input.length < 24)
    throw new Error(
      "This file is too short to be a merged Uniden firmware container.",
    );
  const bytes = input.slice();
  const sections = parseContainer(bytes);
  const fileHash = await sha256(bytes);
  let supported = true;
  let reason =
    "Verified R7 v153.150.127 code profile. Text and boot-logo editing are available.";
  let ui = null;
  let texts = null;
  let logoPixels = null;
  if (sections.map((section) => section.name).join(",") !== SUPPORTED_LAYOUT) {
    supported = false;
    reason =
      "Inspection only: this container layout differs from the verified R7 merged firmware.";
  }
  for (const [name, profile] of Object.entries(PROFILE)) {
    if (!supported) break;
    const section = sections.find((item) => item.name === name);
    if (
      !section ||
      section.model !== 7 ||
      section.version !== profile.version ||
      section.size !== profile.size ||
      section.logicalSize !== profile.logicalSize
    ) {
      supported = false;
      reason =
        "Inspection only: editing requires the verified R7 v153.150.127 code profile.";
      break;
    }
    const decoded = decodeOldModel(
      profile.key,
      bytes.subarray(section.offset, section.offset + section.size),
    );
    const fingerprint = decoded.slice();
    if (name === "ui_nu") {
      ui = decoded;
      for (const field of TEXT_FIELDS)
        fingerprint.fill(0, field.offset, field.offset + field.size);
      fingerprint.fill(0, LOGO_OFFSET, LOGO_OFFSET + LOGO_SIZE);
    }
    if ((await sha256(fingerprint)) !== profile.sha256) {
      supported = false;
      reason = `Inspection only: ${name} differs from the verified R7 code outside the editable ranges.`;
      break;
    }
  }
  if (supported) {
    try {
      texts = Object.freeze(
        Object.fromEntries(
          TEXT_FIELDS.map((field) => [field.id, readText(ui, field)]),
        ),
      );
      logoPixels = readLogo(ui);
    } catch (error) {
      supported = false;
      reason = `Inspection only: ${error.message}`;
      texts = null;
    }
  }
  const model = Object.freeze({
    bytes: bytes.slice(),
    sha256: fileHash,
    supported,
    reason,
    sections: Object.freeze(sections),
    texts,
    logoPixels,
    fileSize: bytes.length,
  });
  snapshots.set(model, {
    bytes,
    sha256: fileHash,
    supported,
    sections,
    ui,
    texts,
  });
  return model;
}

function sameBytes(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Export only the allowlisted decoded UI ranges; all other file bytes survive. */
export async function exportFirmware(model, options = {}) {
  const snapshot = snapshots.get(model);
  if (!snapshot?.supported)
    throw new Error(
      "Load a verified, supported firmware before exporting edits.",
    );
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Edits must be an object.");
  for (const key of Object.keys(options))
    if (!["texts", "logoPixels"].includes(key))
      throw new Error(`Unknown edit option: ${key}.`);
  const textEdits = options.texts ?? {};
  if (typeof textEdits !== "object" || Array.isArray(textEdits))
    throw new TypeError("Text edits must be an object.");
  for (const key of Object.keys(textEdits))
    if (!TEXT_FIELDS.some((field) => field.id === key))
      throw new Error(`Unknown text field: ${key}.`);
  const edited = snapshot.ui.slice();
  const changes = [];
  const ranges = [];
  for (const field of TEXT_FIELDS) {
    if (!Object.hasOwn(textEdits, field.id)) continue;
    const text = textEdits[field.id];
    if (typeof text !== "string" || !/^[\x20-\x7e]*$/.test(text))
      throw new Error(
        `${field.label} must contain printable ASCII characters only.`,
      );
    if (text.length > field.maxLength)
      throw new Error(
        `${field.label} must be ${field.maxLength} characters or fewer.`,
      );
    if (text === snapshot.texts[field.id]) continue;
    edited.fill(0, field.offset, field.offset + field.size);
    for (let i = 0; i < text.length; i++)
      edited[field.offset + i] = text.charCodeAt(i);
    changes.push({
      label: field.label,
      before: snapshot.texts[field.id],
      after: text,
    });
    ranges.push({
      section: "ui_nu",
      offset: field.offset,
      size: field.size,
      type: "text",
      field: field.id,
    });
  }
  if (options.logoPixels != null) {
    const pixels = options.logoPixels;
    if (
      !(pixels instanceof Uint8Array) ||
      pixels.length !== LOGO_WIDTH * LOGO_HEIGHT ||
      pixels.some((value) => !RAMP.includes(value))
    ) {
      throw new Error(
        "The boot logo must contain 176 × 60 pixels using shades 0, 90, 180, and 255.",
      );
    }
    const packed = new Uint8Array(LOGO_SIZE);
    for (let i = 0; i < pixels.length; i++)
      packed[i >>> 2] |= RAMP.indexOf(pixels[i]) << ((3 - (i % 4)) * 2);
    if (
      !sameBytes(
        packed,
        snapshot.ui.subarray(LOGO_OFFSET, LOGO_OFFSET + LOGO_SIZE),
      )
    ) {
      edited.set(packed, LOGO_OFFSET);
      changes.push({
        label: "Boot logo",
        before: "Original 176 × 60 image",
        after: "Edited 176 × 60 image",
      });
      ranges.push({
        section: "ui_nu",
        offset: LOGO_OFFSET,
        size: LOGO_SIZE,
        type: "2bpp-image",
      });
    }
  }
  const bytes = snapshot.bytes.slice();
  const uiSection = snapshot.sections.find(
    (section) => section.name === "ui_nu",
  );
  if (changes.length)
    bytes.set(encodeOldModel(PROFILE.ui_nu.key, edited), uiSection.offset);
  let changedBytes = 0;
  for (let i = uiSection.offset; i < uiSection.offset + uiSection.size; i++)
    if (bytes[i] !== snapshot.bytes[i]) changedBytes++;
  const outputHash = changes.length ? await sha256(bytes) : snapshot.sha256;
  return {
    bytes,
    changes,
    manifest: {
      schemaVersion: 1,
      tool: "Uniden Firmware Workbench",
      profile: "R7 v153.150.127",
      inputSha256: snapshot.sha256,
      outputSha256: outputHash,
      inputSize: snapshot.bytes.length,
      outputSize: bytes.length,
      changedBytes,
      editedRanges: ranges,
      changes,
      validation:
        "Code fingerprints verified; edits restricted to listed decoded UI ranges. Hardware behavior has not been tested by this web tool.",
    },
  };
}

const SECTION_KEYS = Object.freeze({
  ui_nu: 182,
  dsp_nu: 184,
  gps_nu: 183,
  sound_dbnu: 225,
  "GPSD:LRDB": 210,
  "GPSD:DFDB": 194,
  "GPSD:IRDB": 226,
  "GASD:LRDB": 210,
  "GASD:DFDB": 194,
  "GASD:IRDB": 226,
});
const HISTORY_BYTES = 64 * 1024 * 1024;
const HISTORY_LIMIT = 24;
const OPERATION_LIMIT = 10000;

function workspaceContainer(bytes) {
  try {
    return {
      valid: true,
      error: null,
      sections: Object.freeze(
        parseContainer(bytes).map((section) =>
          Object.freeze({
            ...section,
            logicalSize: section.logicalSize ?? section.size,
            key: SECTION_KEYS[section.name] ?? null,
            model: section.model ?? null,
          }),
        ),
      ),
    };
  } catch (error) {
    return { valid: false, error: error.message, sections: Object.freeze([]) };
  }
}

function coreLayout(sections) {
  return Object.keys(R7_PROFILE)
    .map((name) => {
      const section = sections.find((entry) => entry.name === name);
      return (
        section &&
        [
          name,
          section.offset,
          section.size,
          section.logicalSize,
          section.version,
          section.model,
        ].join(":")
      );
    })
    .join("|");
}

async function recognizeWorkspace(bytes, container) {
  if (!container.valid)
    return { known: false, reason: `Raw file editing: ${container.error}` };
  for (const [name, profile] of Object.entries(R7_PROFILE)) {
    const section = container.sections.find((entry) => entry.name === name);
    if (
      !section ||
      section.model !== 7 ||
      section.version !== profile.version ||
      section.size !== profile.size ||
      section.logicalSize !== profile.logicalSize
    ) {
      return {
        known: false,
        reason:
          "Raw and section editing are available. Named R7 controls require the v153.150.127 layout and verified code fingerprints.",
      };
    }
    const decoded = decodeOldModel(
      profile.key,
      bytes.subarray(section.offset, section.offset + section.size),
    );
    const fingerprint = decoded.slice();
    if (name === "ui_nu") {
      try {
        if ((await sha256(normalizedUiData(decoded))) !== SCAN_DATA_HASH) {
          return {
            known: false,
            reason:
              "UI initialized RAM differs outside the documented scan frames. Load an original verified reference to use named controls.",
          };
        }
      } catch (error) {
        return {
          known: false,
          reason: `${error.message} Raw and section editing remain available.`,
        };
      }
      for (const [start, end] of UI_DATA_RANGES)
        fingerprint.fill(0, start, end);
    } else if (name === "dsp_nu") {
      for (let i = 0; i < 33; i++)
        fingerprint.fill(0, 0xdd34 + i * 16 + 4, 0xdd34 + i * 16 + 12);
    }
    if ((await sha256(fingerprint)) !== profile.sha256) {
      return {
        known: false,
        reason: `${name} differs outside verified data ranges. Raw and section editing remain available; load an original verified reference to restore named controls.`,
      };
    }
  }
  return {
    known: true,
    reason:
      "R7 v153.150.127 code fingerprint verified outside documented editable data ranges. Named controls use this layout; hardware behavior is untested.",
  };
}

function checkRange(offset, length, available, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > available - length
  ) {
    throw new RangeError(
      `${label} is outside the available ${available} bytes.`,
    );
  }
}

function byteDescription(bytes) {
  const preview = Array.from(bytes.subarray(0, 32), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(" ");
  return `${bytes.length} bytes${preview ? `: ${preview}${bytes.length > 32 ? " …" : ""}` : ""}`;
}

/**
 * A lossless local editing session. Every byte can be edited, including unknown
 * containers. Only verified layouts receive names for the researched controls.
 * Public buffers are copies. Mutation methods are synchronous and atomic.
 */
export async function openWorkspace(value, { reference } = {}) {
  const original = inputBytes(value).slice();
  if (original.length > MAX_FILE_SIZE)
    throw new Error("Firmware files must be 32 MiB or smaller.");
  const referenceBytes =
    reference == null ? null : inputBytes(reference).slice();
  if (referenceBytes && referenceBytes.length > MAX_FILE_SIZE)
    throw new Error("Reference firmware must be 32 MiB or smaller.");
  const originalContainer = workspaceContainer(original);
  const originalHash = await sha256(original);
  const recognized = await recognizeWorkspace(original, originalContainer);
  let authority = recognized.known;
  let authorityReason = recognized.reason;
  let referenceHash = null;
  if (referenceBytes) {
    const referenceContainer = workspaceContainer(referenceBytes);
    const referenceProfile = await recognizeWorkspace(
      referenceBytes,
      referenceContainer,
    );
    if (!referenceProfile.known)
      throw new Error(
        `The reference must match the verified R7 profile. ${referenceProfile.reason}`,
      );
    if (
      !originalContainer.valid ||
      coreLayout(originalContainer.sections) !==
        coreLayout(referenceContainer.sections)
    ) {
      throw new Error(
        "The edited firmware and reference must have the same R7 code-section layout, sizes, versions, and model.",
      );
    }
    referenceHash = await sha256(referenceBytes);
    authority = true;
    authorityReason =
      "Named controls use the layout of your verified R7 reference. The edited file code is not fingerprint-verified against stock firmware.";
  }
  const anchorLayout = coreLayout(originalContainer.sections);
  let state = {
    bytes: original,
    container: originalContainer,
    operations: [],
    operationCount: 0,
  };
  let revision = 0;
  let history = [];
  let historySize = 0;
  let comparisonRevision = -1;
  let comparisonSummary;

  function knownNow() {
    return (
      authority &&
      state.container.valid &&
      coreLayout(state.container.sections) === anchorLayout
    );
  }
  function getInfo() {
    const profileKnown = knownNow();
    return Object.freeze({
      sha256: originalHash,
      fileSize: state.bytes.length,
      profileKnown,
      profileReason: profileKnown
        ? state.operationCount
          ? "Named controls use the verified session input or reference layout. Current edited code has not been independently fingerprint-verified; hardware behavior is untested."
          : authorityReason
        : authority
          ? "Code-section layout changed. Named controls are disabled; all bytes remain editable."
          : recognized.reason,
      containerValid: state.container.valid,
      error: state.container.error,
      revision,
      canUndo: history.length > 0,
      changeCount: state.operationCount,
      referenceSha256: referenceHash,
    });
  }
  function sectionByName(name) {
    if (name === "file")
      return { name, offset: 0, size: state.bytes.length, key: null };
    const section = state.container.sections.find(
      (entry) => entry.name === name,
    );
    if (!section)
      throw new Error(
        `Section ${name} is not available in the current container.`,
      );
    return section;
  }
  function commit(bytes, operation) {
    if (sameBytes(bytes, state.bytes)) return false;
    history.push(state);
    historySize += state.bytes.length;
    while (history.length > HISTORY_LIMIT || historySize > HISTORY_BYTES)
      historySize -= history.shift().bytes.length;
    state = {
      bytes,
      container: workspaceContainer(bytes),
      operations: [
        ...state.operations.slice(-(OPERATION_LIMIT - 1)),
        Object.freeze(operation),
      ],
      operationCount: state.operationCount + 1,
    };
    revision++;
    return true;
  }

  const workspace = {
    get info() {
      return getInfo();
    },
    get sections() {
      return state.container.sections;
    },
    get changes() {
      return state.operations.map((operation) => ({
        label: operation.label,
        before: operation.before,
        after: operation.after,
      }));
    },
    getBytes(name = "file", decoded = true) {
      const section = sectionByName(name);
      const bytes = state.bytes.slice(
        section.offset,
        section.offset + section.size,
      );
      return decoded && section.key != null
        ? decodeOldModel(section.key, bytes)
        : bytes;
    },
    reviewChanges(options = {}) {
      if (comparisonRevision !== revision) {
        comparisonSummary = differenceSummary(original, state.bytes);
        comparisonRevision = revision;
      }
      return {
        revision,
        inputSize: original.length,
        outputSize: state.bytes.length,
        changedBytes: comparisonSummary.changedBytes,
        rangeCount: comparisonSummary.diffRangeCount,
        ...differencePage(original, state.bytes, options),
      };
    },
    applyPatches(patches, label = "Edit bytes") {
      if (!Array.isArray(patches))
        throw new TypeError("Patches must be an array.");
      if (patches.length > 10000)
        throw new RangeError("Apply at most 10,000 patches in one operation.");
      const prepared = patches.map((patch) => {
        if (!patch || typeof patch !== "object")
          throw new TypeError("Each patch must describe a byte range.");
        const section = sectionByName(patch.section ?? "file");
        const bytes = inputBytes(patch.bytes).slice();
        checkRange(
          patch.offset,
          bytes.length,
          section.size,
          `Patch in ${section.name}`,
        );
        const decoded = patch.decoded !== false && section.key != null;
        if (decoded && section.size % 4)
          throw new Error(
            `Section ${section.name} cannot be decoded in complete four-byte groups.`,
          );
        return { section, offset: patch.offset, bytes, decoded };
      });
      const bytes = state.bytes.slice();
      const details = [];
      for (const patch of prepared) {
        const { section, offset, decoded } = patch;
        let before;
        if (decoded && patch.bytes.length) {
          // Expand to codec groups so an unaligned one-byte edit never alters
          // neighboring decoded bytes or requires reencoding an entire section.
          const start = offset - (offset % 4);
          const end = Math.ceil((offset + patch.bytes.length) / 4) * 4;
          const group = decodeOldModel(
            section.key,
            bytes.subarray(section.offset + start, section.offset + end),
          );
          before = group.slice(
            offset - start,
            offset - start + patch.bytes.length,
          );
          group.set(patch.bytes, offset - start);
          bytes.set(encodeOldModel(section.key, group), section.offset + start);
        } else {
          before = bytes.slice(
            section.offset + offset,
            section.offset + offset + patch.bytes.length,
          );
          bytes.set(patch.bytes, section.offset + offset);
        }
        if (!sameBytes(before, patch.bytes))
          details.push({
            section: section.name,
            offset,
            size: patch.bytes.length,
            decoded,
            before: byteDescription(before),
            after: byteDescription(patch.bytes),
          });
      }
      return commit(bytes, {
        label: String(label),
        kind: "patch",
        ranges: details,
        before: details
          .map(
            (detail) =>
              `${detail.section} +0x${detail.offset.toString(16)} ${detail.before}`,
          )
          .join("; "),
        after: details
          .map(
            (detail) =>
              `${detail.section} +0x${detail.offset.toString(16)} ${detail.after}`,
          )
          .join("; "),
      });
    },
    replaceSection(
      name,
      value,
      label = `Replace ${name}`,
      { decoded = true } = {},
    ) {
      const bytes = inputBytes(value);
      const section = sectionByName(name);
      if (bytes.length !== section.size)
        throw new Error(
          `Section replacement requires exactly ${section.size} bytes. Use a file splice to change its length and update framing.`,
        );
      return workspace.applyPatches(
        [{ section: name, offset: 0, bytes, decoded }],
        label,
      );
    },
    spliceFile(offset, deleteCount, value, label = "Splice file bytes") {
      const inserted = inputBytes(value).slice();
      checkRange(offset, deleteCount, state.bytes.length, "File splice");
      const size = state.bytes.length - deleteCount + inserted.length;
      if (size > MAX_FILE_SIZE)
        throw new Error("The resulting firmware must be 32 MiB or smaller.");
      const bytes = new Uint8Array(size);
      bytes.set(state.bytes.subarray(0, offset));
      bytes.set(inserted, offset);
      bytes.set(
        state.bytes.subarray(offset + deleteCount),
        offset + inserted.length,
      );
      return commit(bytes, {
        label: String(label),
        kind: "splice",
        offset,
        deleteCount,
        insertCount: inserted.length,
        before: byteDescription(
          state.bytes.subarray(offset, offset + deleteCount),
        ),
        after: byteDescription(inserted),
      });
    },
    undo() {
      if (!history.length) return false;
      state = history.pop();
      historySize -= state.bytes.length;
      revision++;
      return true;
    },
    reset() {
      const changed =
        !sameBytes(state.bytes, original) || state.operationCount > 0;
      state = {
        bytes: original,
        container: originalContainer,
        operations: [],
        operationCount: 0,
      };
      history = [];
      historySize = 0;
      if (changed) revision++;
      return changed;
    },
    async export() {
      const bytes = state.bytes.slice();
      const operations = state.operations.map((operation) => ({
        ...operation,
        ...(operation.ranges
          ? { ranges: operation.ranges.map((range) => ({ ...range })) }
          : {}),
      }));
      const operationCount = state.operationCount;
      const info = getInfo();
      const differences = differenceSummary(original, bytes);
      const outputHash = differences.changedBytes
        ? await sha256(bytes)
        : originalHash;
      const changes = operations.map((operation) => ({
        label: operation.label,
        before: operation.before,
        after: operation.after,
      }));
      return {
        bytes,
        changes,
        manifest: {
          schemaVersion: 2,
          tool: "Uniden Firmware Workbench",
          profile: info.profileKnown ? "R7 v153.150.127" : null,
          profileReason: info.profileReason,
          containerValid: info.containerValid,
          containerError: info.error,
          inputSha256: originalHash,
          outputSha256: outputHash,
          referenceSha256: referenceHash,
          inputSize: original.length,
          outputSize: bytes.length,
          revision: info.revision,
          comparisonBasis: "absolute-file-offsets",
          differenceNote:
            "changedBytes and diffRanges compare bytes at the same absolute offset, up to the longer file length. Insertions or deletions can count unchanged content moved to a new offset as different; operations describe the actual edits.",
          ...differences,
          operationCount,
          operationsTruncated: operationCount > operations.length,
          editedRanges: operations.flatMap(
            (operation) =>
              operation.ranges ?? [
                {
                  section: "file",
                  offset: operation.offset,
                  deleted: operation.deleteCount,
                  inserted: operation.insertCount,
                  type: "splice",
                },
              ],
          ),
          operations,
          changes,
          validation:
            "Byte edits and container framing are reported separately. Code fingerprints establish named-control layout only; edited code, frequencies, and device behavior are not hardware-validated.",
        },
      };
    },
  };
  return Object.freeze(workspace);
}
