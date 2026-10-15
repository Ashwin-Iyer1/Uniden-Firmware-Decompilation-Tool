import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeOldModel, encodeOldModel, inspectFirmware, exportFirmware, TEXT_FIELDS, LOGO_WIDTH, LOGO_HEIGHT, MAX_FILE_SIZE } from '../web/firmware.mjs';

function syntheticContainer() {
  // Invented payload, deliberately not a supported or flashable firmware.
  const bytes = new Uint8Array(12 + 512 + 9 + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 4, true);
  bytes.set(encodeOldModel(182, new Uint8Array(512)), 12);
  view.setUint16(524, 7 << 10 | 153, true);
  bytes.set(new TextEncoder().encode('DRSWMAI'), 526);
  bytes.set(new TextEncoder().encode('NMGF'), 533);
  view.setUint32(541, 100, true);
  return bytes;
}

test('codec matches independent Python vectors for each R7 code key', () => {
  const source = Uint8Array.of(0, 1, 2, 3, 0x55, 0xaa, 0xff, 0x80);
  for (const [key, expected] of [[182, '4ea5ffaa9352f824'], [183, '93a9ffaae453f824'], [184, 'e4aaffaa3993f824']]) {
    const encoded = encodeOldModel(key, source);
    assert.equal(Buffer.from(encoded).toString('hex'), expected);
    assert.deepEqual(decodeOldModel(key, encoded), source);
  }
});

test('codec is a byte-exact inverse across all byte values and does not mutate input', () => {
  const source = Uint8Array.from({ length: 8192 }, (_, i) => (i * 73 + (i >>> 8)) & 255);
  const before = source.slice();
  for (const key of [0, 182, 183, 184, 210, 255]) {
    assert.deepEqual(encodeOldModel(key, decodeOldModel(key, source)), source);
    assert.deepEqual(decodeOldModel(key, encodeOldModel(key, source)), source);
  }
  assert.deepEqual(source, before);
  assert.throws(() => encodeOldModel(182, new Uint8Array(3)), /four-byte/);
  assert.throws(() => decodeOldModel(182, new Uint8Array(5)), /four-byte/);
  assert.throws(() => encodeOldModel(256, new Uint8Array(4)), /key/);
});

test('unsupported version-shaped synthetic images remain inspect-only, including model forgery', async () => {
  const bytes = syntheticContainer();
  const model = await inspectFirmware(bytes);
  assert.equal(model.supported, false);
  assert.equal(model.sections.length, 2);
  assert.equal(model.sections[0].version, 153);
  assert.equal(model.sections[1].name, 'NMGF');
  assert.equal(model.texts, null);
  assert.equal(model.logoPixels, null);
  assert.match(model.sha256, /^[0-9a-f]{64}$/);
  await assert.rejects(exportFirmware(model, { texts: { selfTest: 'Test' } }), /verified/);
  await assert.rejects(exportFirmware({ ...model, supported: true }), /verified/);
  assert.deepEqual(bytes, syntheticContainer());
});

test('inspection respects subarray bounds and takes an immutable input snapshot', async () => {
  const input = syntheticContainer();
  const backing = new Uint8Array(input.length + 8);
  backing.set(input, 4);
  const view = backing.subarray(4, 4 + input.length);
  const pending = inspectFirmware(view);
  view.fill(0);
  const model = await pending;
  assert.deepEqual(model.bytes, input);
  assert.equal(model.fileSize, input.length);
});

test('bounded parser rejects truncation, oversized lengths, unknown framing, and trailing data', async () => {
  const original = syntheticContainer();
  for (const length of [0, 12, 23, 524, 532, 544]) await assert.rejects(inspectFirmware(original.slice(0, length)), /short|Truncated|footer/);
  await assert.rejects(inspectFirmware(new Uint8Array(MAX_FILE_SIZE + 1)), /32 MiB/);
  const huge = original.slice();
  new DataView(huge.buffer).setUint32(4, 0xffffffff, true);
  await assert.rejects(inspectFirmware(huge), /Truncated|invalid/);
  const badTerm = original.slice(); badTerm[526] = 0;
  await assert.rejects(inspectFirmware(badTerm), /terminator/);
  const badFlags = original.slice(); badFlags[3] = 0x80;
  await assert.rejects(inspectFirmware(badFlags), /flags/);
  const unknownTag = original.slice(); unknownTag.set(new TextEncoder().encode('FAKE'), 533);
  new DataView(unknownTag.buffer).setUint32(537, 12, true);
  await assert.rejects(inspectFirmware(unknownTag), /Unrecognized section/);
  const badFooter = original.slice(); badFooter[537] = 12;
  await assert.rejects(inspectFirmware(badFooter), /footer/);
  const trailing = new Uint8Array(original.length + 1); trailing.set(original);
  await assert.rejects(inspectFirmware(trailing), /after.*footer/);
});

test('strict next-block padding is preserved at an exact 512-byte logical length', async () => {
  const bytes = new Uint8Array(12 + 1024 + 9 + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 512, true);
  view.setUint16(1036, 7 << 10 | 153, true);
  bytes.set(new TextEncoder().encode('DRSWMAI'), 1038);
  bytes.set(new TextEncoder().encode('NMGF'), 1045);
  view.setUint32(1053, 100, true);
  assert.equal((await inspectFirmware(bytes)).sections[0].size, 1024);
});

test('sound records include their twelve-byte footer before the terminator', async () => {
  const base = syntheticContainer();
  const tag = new Uint8Array(12 + 16 + 7);
  const view = new DataView(tag.buffer);
  tag.set(new TextEncoder().encode('STSD'));
  view.setUint32(4, 12, true);
  view.setUint32(8, 16, true); // four payload bytes plus a twelve-byte footer
  tag.fill(0xa5, 12, 28);
  tag.set(new TextEncoder().encode('DRSWSTS'), 28);
  const bytes = new Uint8Array(base.length + tag.length);
  bytes.set(base.subarray(0, 533));
  bytes.set(tag, 533);
  bytes.set(base.subarray(533), 533 + tag.length);
  const model = await inspectFirmware(bytes);
  assert.equal(model.sections[1].name, 'STSD');
  assert.equal(model.sections[1].size, 4);
  assert.equal(model.sections[2].offset + 12, bytes.length);
  bytes[533 + 28] = 0;
  await assert.rejects(inspectFirmware(bytes), /sound terminator/);
});

const fixture = process.env.R7_FIXTURE;
test('local private fixture: identity, bounded edits, reimport, invalid edits, and snapshot trust', { skip: !fixture }, async () => {
  const original = new Uint8Array(await readFile(fixture));
  const originalCopy = original.slice();
  const model = await inspectFirmware(original);
  assert.equal(model.supported, true, model.reason);
  assert.equal(model.sha256, 'f0197e9f490b58bb7e4b7b14c1c2c4e498166b4389c566a6d49b511f91a48d4a');
  assert.deepEqual(model.texts, { selfTest: 'Self Test', owner1: 'Alert Display #1', owner2: 'Alert Display #2' });
  assert.equal(model.logoPixels.length, LOGO_WIDTH * LOGO_HEIGHT);
  assert.equal(model.sections.at(-1).offset + 12, original.length);
  const noOp = await exportFirmware(model, { texts: model.texts, logoPixels: model.logoPixels });
  assert.deepEqual(noOp.bytes, original);
  assert.deepEqual(noOp.changes, []);
  assert.equal(noOp.manifest.inputSha256, noOp.manifest.outputSha256);
  assert.equal(noOp.manifest.changedBytes, 0);
  const pixels = model.logoPixels.slice(); pixels[0] = pixels[0] === 0 ? 255 : 0;
  const exported = await exportFirmware(model, { texts: { selfTest: 'MY R7', owner1: '', owner2: 'X'.repeat(19) }, logoPixels: pixels });
  assert.equal(exported.changes.length, 4);
  assert.equal(exported.bytes.length, original.length);
  assert.notEqual(exported.manifest.inputSha256, exported.manifest.outputSha256);
  const ui = model.sections.find((s) => s.name === 'ui_nu');
  assert.deepEqual(exported.bytes.subarray(0, ui.offset), original.subarray(0, ui.offset));
  assert.deepEqual(exported.bytes.subarray(ui.offset + ui.size), original.subarray(ui.offset + ui.size));
  const oldUi = decodeOldModel(182, original.subarray(ui.offset, ui.offset + ui.size));
  const newUi = decodeOldModel(182, exported.bytes.subarray(ui.offset, ui.offset + ui.size));
  for (let i = 0; i < oldUi.length; i++) {
    if (oldUi[i] !== newUi[i]) assert.ok(TEXT_FIELDS.some((f) => i >= f.offset && i < f.offset + f.size) || (i >= 0x2d526 && i < 0x2d526 + 2640), `Unexpected change at decoded 0x${i.toString(16)}`);
  }
  const reopened = await inspectFirmware(exported.bytes);
  assert.equal(reopened.supported, true, reopened.reason);
  assert.deepEqual(reopened.texts, { selfTest: 'MY R7', owner1: '', owner2: 'X'.repeat(19) });
  assert.deepEqual(reopened.logoPixels, pixels);
  assert.deepEqual((await exportFirmware(reopened)).bytes, exported.bytes);
  for (const text of ['X'.repeat(12), 'Hello\n', 'Unidén', '\0']) await assert.rejects(exportFirmware(model, { texts: { selfTest: text } }), /characters|ASCII/);
  await assert.rejects(exportFirmware(model, { texts: { unknown: 'x' } }), /Unknown text/);
  await assert.rejects(exportFirmware(model, { logoPixels: new Uint8Array(1) }), /176/);
  const wrongShade = pixels.slice(); wrongShade[2] = 128;
  await assert.rejects(exportFirmware(model, { logoPixels: wrongShade }), /shades/);
  assert.deepEqual(original, originalCopy);
  // Public copies cannot trick export into using caller-modified file bytes.
  model.bytes.fill(0);
  original.fill(0);
  assert.deepEqual((await exportFirmware(model)).bytes, originalCopy);
  const tampered = noOp.bytes.slice(); tampered[ui.offset + 100] ^= 1;
  const untrusted = await inspectFirmware(tampered);
  assert.equal(untrusted.supported, false);
  await assert.rejects(exportFirmware(untrusted), /verified/);
  // Trailer and logical-size spoofing cannot pass just because payload hashes match.
  const wrongLogicalSize = noOp.bytes.slice();
  const logicalView = new DataView(wrongLogicalSize.buffer);
  logicalView.setUint32(0, logicalView.getUint32(0, true) + 1, true);
  assert.equal((await inspectFirmware(wrongLogicalSize)).supported, false);
  const wrongModel = noOp.bytes.slice();
  const trailerView = new DataView(wrongModel.buffer);
  trailerView.setUint16(ui.offset + ui.size, 8 << 10 | 153, true);
  assert.equal((await inspectFirmware(wrongModel)).supported, false);
  const wrongVersion = noOp.bytes.slice();
  new DataView(wrongVersion.buffer).setUint16(ui.offset + ui.size, 7 << 10 | 154, true);
  assert.equal((await inspectFirmware(wrongVersion)).supported, false);
  // Masked text still needs a NUL and ASCII content: arbitrary data is refused.
  const badTextUi = oldUi.slice(); badTextUi.fill(0xff, 0x2268, 0x2268 + 12);
  const badTextFile = noOp.bytes.slice(); badTextFile.set(encodeOldModel(182, badTextUi), ui.offset);
  assert.equal((await inspectFirmware(badTextFile)).supported, false);
});
