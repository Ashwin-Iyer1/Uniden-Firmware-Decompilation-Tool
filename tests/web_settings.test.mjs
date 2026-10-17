import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  SETTINGS, THEMES, UI_LENGTH, UI_SHA256,
  normalizeSettingsUi, validateSettingsUi, validateSettingsSection, settingsPatch,
} from "../web/settings.mjs";
import { openWorkspace, inspectFirmware } from "../web/firmware.mjs";

// Independently specified instruction sites; no vendor firmware is bundled.
const STOCK = [
  [0x16af2, [0x40, 0xf6, 0xb8, 0x30]],
  [0x16b14, [0x40, 0xf6, 0xb8, 0x31]],
  [0x16b22, [0x40, 0xf6, 0xb8, 0x30]],
  [0x1d05e, [5, 0x20]], [0x1d458, [6, 0x20]],
  [0x1d0a6, [2, 0x20]], [0x1d488, [2, 0x20]],
  [0x1d21a, [8, 0x20]], [0x1d608, [8, 0x20]],
];
const VALUES = {
  auto_mute_delay_ms: [3000, 3000, 3000], default_theme: [5, 6],
  default_mute_volume: [2, 2], default_mute_level: [8, 8],
};
const SECTION = {
  name: "ui_nu", model: 7, version: 153, size: 195072,
  logicalSize: 194776, key: 182,
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function syntheticUi() {
  const bytes = Uint8Array.from({ length: 195072 }, (_, index) => index % 256);
  for (const [offset, instruction] of STOCK) bytes.set(instruction, offset);
  return bytes;
}

test("settings metadata matches all Python controls and distinguishes both stock themes", () => {
  assert.deepEqual(Object.keys(SETTINGS), Object.keys(VALUES));
  assert.equal(THEMES[5], "Red");
  assert.equal(THEMES[6], "White");
  assert.deepEqual(Object.values(SETTINGS).flatMap((setting) => setting.sites)
    .map((site) => [site.offset, [...site.original]]), STOCK);
  assert.throws(() => { SETTINGS.default_theme.sites[0].original[0] = 4; }, TypeError);
  assert.throws(() => { SETTINGS.default_mute_level.maximum = 255; }, TypeError);
});

test("normalization restores exact stock instructions and preserves all other bytes", () => {
  const original = syntheticUi(), modified = original.slice();
  // Independently assembled MOVW r0/r1, #1500 and MOVS r0, #3/#5/#4.
  modified.set([0x40, 0xf2, 0xdc, 0x50], 0x16af2);
  modified.set([0x40, 0xf2, 0xdc, 0x51], 0x16b14);
  modified.set([0x40, 0xf2, 0xdc, 0x50], 0x16b22);
  for (const offset of [0x1d05e, 0x1d458]) modified[offset] = 3;
  for (const offset of [0x1d0a6, 0x1d488]) modified[offset] = 5;
  for (const offset of [0x1d21a, 0x1d608]) modified[offset] = 4;
  assert.deepEqual(normalizeSettingsUi(modified), original);
  assert.notDeepEqual(modified, original);
  const unrelatedChange = modified.slice();
  unrelatedChange[100] ^= 1;
  assert.equal(normalizeSettingsUi(unrelatedChange)[100], unrelatedChange[100]);
  const buffer = Buffer.from(original), normalized = normalizeSettingsUi(buffer);
  buffer.fill(0);
  assert.deepEqual(normalized, original);
});

test("normalization rejects opcode/register changes, partial groups, invalid values, and wrong length", () => {
  for (const offset of [0x1d05f, 0x16af3, 0x16b17]) {
    const ui = syntheticUi(); ui[offset] ^= 1;
    assert.throws(() => normalizeSettingsUi(ui), /Unexpected instruction/);
  }
  for (const offset of [0x16af4, 0x1d05e, 0x1d0a6, 0x1d21a]) {
    const ui = syntheticUi(); ui[offset] ^= 1;
    assert.throws(() => normalizeSettingsUi(ui), /inconsistent coupled|out-of-range/);
  }
  // The inverse mixed theme pair is not the vendor's intentional [5, 6] pair.
  const theme = syntheticUi(); theme[0x1d05e] = 6; theme[0x1d458] = 5;
  assert.throws(() => normalizeSettingsUi(theme), /inconsistent coupled/);
  for (const offsets of [[0x1d05e, 0x1d458], [0x1d0a6, 0x1d488], [0x1d21a, 0x1d608]]) {
    const ui = syntheticUi(); for (const offset of offsets) ui[offset] = 255;
    assert.throws(() => normalizeSettingsUi(ui), /out-of-range/);
  }
  const tooFast = syntheticUi();
  tooFast.set([0x40, 0xf2, 99, 0], 0x16af2);
  tooFast.set([0x40, 0xf2, 99, 1], 0x16b14);
  tooFast.set([0x40, 0xf2, 99, 0], 0x16b22);
  assert.throws(() => normalizeSettingsUi(tooFast), /out-of-range/);
  for (const length of [0, UI_LENGTH - 1, UI_LENGTH + 1])
    assert.throws(() => normalizeSettingsUi(new Uint8Array(length)), /Unsupported UI length/);
});

test("synthetic instructions never grant stock identity or a patching override", async () => {
  const ui = syntheticUi();
  await assert.rejects(validateSettingsUi(ui), /normalized SHA256/);
  await assert.rejects(settingsPatch(ui, { default_theme: 1 }), /normalized SHA256/);
  // Extra arguments cannot replace the fixed reference hash.
  await assert.rejects(validateSettingsUi(ui, hash(ui)), /normalized SHA256/);
});

test("settings section guard requires model, version, encoded key, and exact declared/padded sizes", () => {
  assert.equal(validateSettingsSection(SECTION), SECTION);
  for (const [field, values] of Object.entries({
    name: ["dsp_nu"], model: [8, 24, 28], version: [152, 154],
    size: [194776, 195071, 195073], key: [183, null],
    logicalSize: [194560, 194775, 194777, 195071],
  })) for (const value of values)
    assert.throws(() => validateSettingsSection({ ...SECTION, [field]: value }));
  assert.throws(() => validateSettingsSection(null));
});

test("settings changes refuse unknown names and non-integer or out-of-range values", async () => {
  const ui = syntheticUi();
  for (const [name, setting] of Object.entries(SETTINGS))
    for (const value of [setting.minimum - 1, setting.maximum + 1, true, false, 1.5, "2", null, NaN, Infinity])
      await assert.rejects(settingsPatch(ui, { [name]: value }), /requires an integer/);
  await assert.rejects(settingsPatch(ui, { unknown: 1 }), /Unknown setting/);
  for (const changes of [null, [], "", 2])
    await assert.rejects(settingsPatch(ui, changes), /must be an object/);
});

const fixture = process.env.R7_FIXTURE;
test("private R7 fixture: every settings value boundary produces Python-identical bytes and reports", { skip: !fixture }, async () => {
  const original = new Uint8Array(await readFile(fixture));
  const workspace = await openWorkspace(original);
  validateSettingsSection(workspace.sections.find((section) => section.name === "ui_nu"));
  const ui = workspace.getBytes("ui_nu");
  assert.equal(hash(ui), UI_SHA256);
  assert.deepEqual(await validateSettingsUi(ui), VALUES);
  const profiles = [{}];
  for (const [name, values] of [
    ["auto_mute_delay_ms", [100, 255, 256, 2047, 2048, 4095, 4096, 30000]],
    ["default_theme", Array.from({ length: 8 }, (_, i) => i)],
    ["default_mute_volume", Array.from({ length: 8 }, (_, i) => i)],
    ["default_mute_level", Array.from({ length: 9 }, (_, i) => i)],
  ]) for (const value of values) profiles.push({ [name]: value });
  profiles.push({ auto_mute_delay_ms: 1500, default_theme: 3, default_mute_volume: 5, default_mute_level: 4 });
  const python = `
import hashlib, json, sys
from pathlib import Path
sys.path.insert(0, 'tools')
import r7_settings as settings
original = Path(sys.argv[1]).read_bytes()
_, ui = settings.read_ui(original)
results = []
profiles = json.loads(sys.stdin.read())
for profile in profiles:
    changed, report = settings.patch_ui(ui, profile)
    results.append({'hash': hashlib.sha256(changed).hexdigest(), 'report': report})
container, _ = settings.patch_firmware(original, profiles[-1])
print(json.dumps({'profiles': results, 'container_hash': hashlib.sha256(container).hexdigest()}))
`;
  const reference = JSON.parse(execFileSync(process.env.PYTHON ?? "python3", ["-c", python, fixture], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), input: JSON.stringify(profiles), encoding: "utf8",
  }));
  let last;
  for (const [index, profile] of profiles.entries()) {
    const result = await settingsPatch(ui, profile);
    assert.equal(hash(result.bytes), reference.profiles[index].hash);
    assert.deepEqual(result.report, reference.profiles[index].report);
    const applied = ui.slice();
    for (const patch of result.patches) applied.set(patch.bytes, patch.offset);
    assert.deepEqual(applied, result.bytes);
    last = result;
  }
  assert.equal(workspace.applyPatches(last.patches, "Change R7 settings"), true);
  const exported = await workspace.export();
  assert.equal(hash(exported.bytes), reference.container_hash);
  const section = workspace.sections.find((section) => section.name === "ui_nu");
  assert.deepEqual(exported.bytes.subarray(0, section.offset), original.subarray(0, section.offset));
  assert.deepEqual(exported.bytes.subarray(section.offset + section.size), original.subarray(section.offset + section.size));
  const reopened = await openWorkspace(exported.bytes);
  assert.equal(reopened.info.profileKnown, true, reopened.info.profileReason);
  assert.equal((await inspectFirmware(exported.bytes)).supported, true);
  const again = await settingsPatch(reopened.getBytes("ui_nu"), { default_theme: 0 });
  assert.deepEqual(again.report.after.default_theme, [0, 0]);
  workspace.undo();
  assert.deepEqual((await workspace.export()).bytes, original);
});

test("private R7 fixture: settings guard ignores reference authority and never accepts unrelated changes", { skip: !fixture }, async () => {
  const original = new Uint8Array(await readFile(fixture));
  const workspace = await openWorkspace(original), ui = workspace.getBytes("ui_nu");
  const patched = await settingsPatch(ui, { auto_mute_delay_ms: 1000, default_theme: 7 });
  workspace.applyPatches(patched.patches);
  // Existing data editors continue to recognize legitimate settings changes.
  workspace.applyPatches([{ section: "ui_nu", offset: 0xa458, bytes: Uint8Array.of(ui[0xa458] ^ 1) }]);
  const dataChanged = await openWorkspace((await workspace.export()).bytes);
  assert.equal(dataChanged.info.profileKnown, true);
  await assert.rejects(settingsPatch(dataChanged.getBytes("ui_nu"), { default_theme: 2 }), /normalized SHA256/);
  workspace.reset();
  for (const offset of [0, 0x100, 0xa458, UI_LENGTH - 1]) {
    const changed = ui.slice(); changed[offset] ^= 1;
    await assert.rejects(validateSettingsUi(changed), /normalized SHA256/);
  }
  workspace.applyPatches([{ section: "ui_nu", offset: 0x200, bytes: Uint8Array.of(ui[0x200] ^ 1) }]);
  const unrecognizedBytes = (await workspace.export()).bytes;
  const referenced = await openWorkspace(unrecognizedBytes, { reference: original });
  assert.equal(referenced.info.profileKnown, true);
  await assert.rejects(settingsPatch(referenced.getBytes("ui_nu"), { default_theme: 2 }), /normalized SHA256/);
  workspace.reset();
  workspace.applyPatches([{ section: "ui_nu", offset: 0x1d05e, bytes: Uint8Array.of(4) }]);
  const partial = await openWorkspace((await workspace.export()).bytes);
  assert.equal(partial.info.profileKnown, false);
  assert.match(partial.info.profileReason, /inconsistent coupled/);
});

test("private R7 fixture: asynchronous validation snapshots caller buffers and requested values", { skip: !fixture }, async () => {
  const workspace = await openWorkspace(new Uint8Array(await readFile(fixture)));
  const buffer = Buffer.from(workspace.getBytes("ui_nu"));
  const changes = { default_theme: 3 };
  const pending = settingsPatch(buffer, changes);
  changes.default_theme = 6; buffer.fill(0);
  const result = await pending;
  assert.deepEqual(result.report.before, VALUES);
  assert.deepEqual(result.report.after.default_theme, [3, 3]);
  const verifyBuffer = Buffer.from(result.bytes), validation = validateSettingsUi(verifyBuffer);
  verifyBuffer.fill(0);
  assert.deepEqual((await validation).default_theme, [3, 3]);
});
