/** Guarded R7 v153 instruction edits, equivalent to tools/r7_settings.py.
 * No firmware payload is bundled. All offsets address decoded ui_nu bytes.
 */
import { inputBytes } from "./binary.mjs";

export const UI_SHA256 =
  "16a8c58e25766909faaa114beb22d87e2dd5108c3a176a2587fccb901218d79f";
export const UI_LENGTH = 195072;
export const UI_DECLARED_LENGTH = 194776;
export const THEMES = Object.freeze([
  "Blue", "Amber", "Green", "Pink", "Gray", "Red", "White", "Violet",
]);

function site(offset, kind, register, original) {
  return Object.freeze({ offset, kind, register, original: Object.freeze(original) });
}
function setting(label, minimum, maximum, sites, description, valueOrder) {
  return Object.freeze({
    label, minimum, maximum, sites: Object.freeze(sites), description,
    valueOrder: Object.freeze(valueOrder ?? ["factory reset", "invalid storage"]),
  });
}

export const SETTINGS = Object.freeze({
  auto_mute_delay_ms: setting("Auto-mute delay", 100, 30000, [
    site(0x16af2, "movw", 0, [0x40, 0xf6, 0xb8, 0x30]),
    site(0x16b14, "movw", 1, [0x40, 0xf6, 0xb8, 0x31]),
    site(0x16b22, "movw", 0, [0x40, 0xf6, 0xb8, 0x30]),
  ], "Nominal milliseconds until auto mute; updates comparison and both saturation values.",
  ["active saturation", "threshold", "new saturation"]),
  default_theme: setting("Default display theme", 0, 7, [
    site(0x1d05e, "movs", 0, [0x05, 0x20]),
    site(0x1d458, "movs", 0, [0x06, 0x20]),
  ], `Theme index: ${THEMES.map((name, index) => `${index}=${name}`).join(", ")}.`),
  default_mute_volume: setting("Default auto-mute volume", 0, 7, [
    site(0x1d0a6, "movs", 0, [0x02, 0x20]),
    site(0x1d488, "movs", 0, [0x02, 0x20]),
  ], "Auto Mute Vol default in both reset and invalid-storage initialization."),
  default_mute_level: setting("Default auto-mute signal level", 0, 8, [
    site(0x1d21a, "movs", 0, [0x08, 0x20]),
    site(0x1d608, "movs", 0, [0x08, 0x20]),
  ], "Auto Mute Lv default in both initializers; 0 disables, 1..8 are signal-level gates."),
});

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(bytes) {
  if (!globalThis.crypto?.subtle)
    throw new Error("SHA-256 requires HTTPS or a localhost browser session.");
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)));
}

function encodeSite(site, value) {
  if (site.kind === "movs")
    return Uint8Array.of(value, 0x20 | site.register);
  // Thumb-2 MOVW immediate fields are imm4:i:imm3:imm8. Preserve opcode and Rd.
  const first = 0xf240 | ((value >>> 12) & 15) | (((value >>> 11) & 1) << 10);
  const second = (((value >>> 8) & 7) << 12) | (site.register << 8) | (value & 255);
  return Uint8Array.of(first & 255, first >>> 8, second & 255, second >>> 8);
}

function decodeSite(ui, site) {
  const raw = ui.subarray(site.offset, site.offset + site.original.length);
  if (raw.length !== site.original.length)
    throw new Error(`Truncated instruction at 0x${site.offset.toString(16)}.`);
  let value = raw[0];
  if (site.kind === "movw") {
    const first = raw[0] | (raw[1] << 8), second = raw[2] | (raw[3] << 8);
    value = ((first & 15) << 12) | (((first >>> 10) & 1) << 11)
      | (((second >>> 12) & 7) << 8) | (second & 255);
  }
  if (!encodeSite(site, value).every((byte, index) => byte === raw[index]))
    throw new Error(`Unexpected instruction at 0x${site.offset.toString(16)}.`);
  return value;
}

function inspectSites(ui) {
  if (ui.length !== UI_LENGTH)
    throw new Error(`Unsupported UI length: expected ${UI_LENGTH} bytes.`);
  const values = {};
  for (const [name, definition] of Object.entries(SETTINGS)) {
    const current = definition.sites.map((site) => decodeSite(ui, site));
    if (current.some((value) => value < definition.minimum || value > definition.maximum))
      throw new Error(`${name} has an out-of-range instruction value.`);
    // Vendor defaults intentionally differ: reset = Red, invalid NVM = White.
    const stockTheme = name === "default_theme" && current[0] === 5 && current[1] === 6;
    if (!stockTheme && current.some((value) => value !== current[0]))
      throw new Error(`${name} has inconsistent coupled instruction values.`);
    values[name] = current;
  }
  return values;
}

/** Validate the parsed workspace section before exposing code controls. */
export function validateSettingsSection(section) {
  if (!section || section.name !== "ui_nu" || section.model !== 7 || section.version !== 153)
    throw new Error("Settings require one R7 ui_nu section with version 153.");
  if (section.size !== UI_LENGTH || section.key !== 182 || section.logicalSize !== UI_DECLARED_LENGTH)
    throw new Error("Unsupported R7 UI section layout.");
  return section;
}

/** Restore verified instruction groups to stock for another full code fingerprint.
 * This checks opcodes, registers, bounds and coupling, but is NOT a hash gate.
 * Call validateSettingsUi before offering settings edits.
 */
export function normalizeSettingsUi(value) {
  const normalized = inputBytes(value).slice();
  inspectSites(normalized);
  for (const definition of Object.values(SETTINGS))
    for (const site of definition.sites) normalized.set(site.original, site.offset);
  return normalized;
}

/** Reject all UI changes outside this tool's validated instruction immediates. */
export async function validateSettingsUi(value) {
  const ui = inputBytes(value).slice();
  const values = inspectSites(ui);
  if (await sha256(normalizeSettingsUi(ui)) !== UI_SHA256)
    throw new Error("Unsupported or independently modified UI: normalized SHA256 does not match R7 v153.");
  return values;
}

/** Produce a preview and workspace-ready, complete coupled instruction patches. */
export async function settingsPatch(value, changes) {
  const ui = inputBytes(value).slice();
  if (!changes || typeof changes !== "object" || Array.isArray(changes))
    throw new TypeError("Settings changes must be an object.");
  // Snapshot mutable callers before any asynchronous hash operation.
  const entries = Object.entries(changes);
  for (const [name, value] of entries) {
    if (!Object.hasOwn(SETTINGS, name)) throw new Error(`Unknown setting: ${name}.`);
    const { minimum, maximum } = SETTINGS[name];
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new Error(`${name} requires an integer from ${minimum} to ${maximum}.`);
  }
  const before = await validateSettingsUi(ui);
  const bytes = ui.slice(), patches = [], instructions = [];
  for (const [name, value] of entries) {
    for (const site of SETTINGS[name].sites) {
      const replacement = encodeSite(site, value);
      const old = ui.subarray(site.offset, site.offset + replacement.length);
      if (replacement.every((byte, index) => byte === old[index])) continue;
      bytes.set(replacement, site.offset);
      patches.push({ section: "ui_nu", offset: site.offset, bytes: replacement });
      instructions.push({
        setting: name, ui_offset: `0x${site.offset.toString(16)}`,
        before: hex(old), after: hex(replacement),
      });
    }
  }
  const after = await validateSettingsUi(bytes);
  const [inputHash, outputHash] = await Promise.all([sha256(ui), sha256(bytes)]);
  return {
    bytes, patches,
    report: {
      reference_ui_sha256: UI_SHA256, input_ui_sha256: inputHash,
      output_ui_sha256: outputHash, before, after, instructions,
      changed_ui_bytes: bytes.reduce((count, byte, index) => count + Number(byte !== ui[index]), 0),
      hardware_verified: false,
    },
  };
}
