import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  openWorkspace,
  encodeOldModel,
  decodeOldModel,
  MAX_FILE_SIZE,
} from "../web/firmware.mjs";
import {
  readScanFrames,
  makeScanFramesPatch,
  decompressLzss,
  compressLzss,
  SCAN_DATA,
} from "../web/resources.mjs";

const ascii = (value) => new TextEncoder().encode(value);

function gpsRecord(bodySize = 512) {
  const bytes = new Uint8Array(12 + bodySize + 12 + 7);
  const view = new DataView(bytes.buffer);
  bytes.set(ascii("GPSD"));
  view.setUint32(4, 12, true);
  view.setUint32(8, bodySize + 12, true);
  const body = new Uint8Array(bodySize).fill(255);
  bytes.set(encodeOldModel(210, body), 12);
  bytes.set(ascii("LRDB"), 12 + bodySize + 8);
  bytes.set(ascii("DRSWGDB"), 12 + bodySize + 12);
  return bytes;
}

function inventedContainer(withGps = false) {
  // A structurally framed but deliberately non-flashable, invented payload.
  const gps = withGps ? gpsRecord() : new Uint8Array();
  const bytes = new Uint8Array(12 + 512 + 9 + gps.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 4, true);
  const decoded = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
  bytes.set(encodeOldModel(182, decoded), 12);
  view.setUint16(524, (7 << 10) | 153, true);
  bytes.set(ascii("DRSWMAI"), 526);
  bytes.set(gps, 533);
  bytes.set(ascii("NMGF"), 533 + gps.length);
  view.setUint32(541 + gps.length, 100, true);
  return bytes;
}

test("raw and malformed files are fully editable with lossless export, undo, reset, and no-op accounting", async () => {
  const original = Uint8Array.of(1, 2, 3, 4, 5);
  const workspace = await openWorkspace(original);
  original.fill(0);
  assert.equal(workspace.info.profileKnown, false);
  assert.equal(workspace.info.containerValid, false);
  assert.deepEqual(workspace.sections, []);
  assert.deepEqual(workspace.getBytes(), Uint8Array.of(1, 2, 3, 4, 5));
  const identity = await workspace.export();
  assert.equal(identity.manifest.changedBytes, 0);
  assert.equal(identity.manifest.inputSha256, identity.manifest.outputSha256);
  assert.deepEqual(identity.changes, []);
  assert.equal(
    workspace.applyPatches([
      { section: "file", offset: 1, bytes: Uint8Array.of(2) },
    ]),
    false,
  );
  assert.equal(workspace.info.revision, 0);
  const patchBytes = Uint8Array.of(8, 9);
  assert.equal(
    workspace.applyPatches(
      [{ section: "file", offset: 1, bytes: patchBytes }],
      "Raw replacement",
    ),
    true,
  );
  patchBytes.fill(0);
  assert.deepEqual(workspace.getBytes(), Uint8Array.of(1, 8, 9, 4, 5));
  const edited = await workspace.export();
  assert.equal(edited.manifest.changedBytes, 2);
  assert.deepEqual(edited.manifest.diffRanges, [{ offset: 1, size: 2 }]);
  assert.equal(edited.changes[0].label, "Raw replacement");
  assert.match(edited.changes[0].before, /02 03/);
  assert.match(edited.changes[0].after, /08 09/);
  edited.manifest.operations[0].ranges[0].offset = 999;
  assert.equal(
    (await workspace.export()).manifest.operations[0].ranges[0].offset,
    1,
  );
  assert.equal(workspace.undo(), true);
  assert.equal(workspace.info.changeCount, 0);
  assert.deepEqual(workspace.getBytes(), Uint8Array.of(1, 2, 3, 4, 5));
  assert.equal(workspace.undo(), false);
  workspace.applyPatches([{ offset: 0, bytes: Uint8Array.of(7) }]);
  assert.equal(workspace.reset(), true);
  assert.equal(workspace.reset(), false);
  assert.equal(workspace.info.canUndo, false);
  assert.deepEqual(
    (await workspace.export()).bytes,
    Uint8Array.of(1, 2, 3, 4, 5),
  );
});

test("unaligned decoded edits preserve every surrounding decoded and container byte", async () => {
  const original = inventedContainer();
  const workspace = await openWorkspace(original);
  assert.equal(workspace.info.containerValid, true);
  assert.equal(workspace.info.profileKnown, false);
  assert.equal(workspace.sections[0].key, 182);
  assert.equal(workspace.sections.at(-1).name, "NMGF");
  const before = workspace.getBytes("ui_nu");
  workspace.applyPatches(
    [
      { section: "ui_nu", offset: 3, bytes: Uint8Array.of(0xaa, 0xbb, 0xcc) },
      { section: "ui_nu", offset: 6, bytes: Uint8Array.of(0xdd) },
      { section: "NMGF", offset: 4, bytes: Uint8Array.of(0), decoded: false },
    ],
    "Unaligned instruction/data patch",
  );
  const after = workspace.getBytes("ui_nu");
  const expected = before.slice();
  expected.set(Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd), 3);
  assert.deepEqual(after, expected);
  const exported = await workspace.export();
  assert.deepEqual(exported.bytes.subarray(0, 12), original.subarray(0, 12));
  assert.deepEqual(exported.bytes.subarray(524), original.subarray(524));
  assert.deepEqual(
    exported.bytes.subarray(12, 524),
    encodeOldModel(182, expected),
  );
  const publicBytes = workspace.getBytes("ui_nu");
  publicBytes.fill(0);
  assert.deepEqual(workspace.getBytes("ui_nu"), expected);
  workspace.replaceSection("ui_nu", before, "Restore section");
  assert.deepEqual((await workspace.export()).bytes, original);
  assert.equal((await workspace.export()).manifest.changedBytes, 0);
  assert.throws(
    () => workspace.replaceSection("ui_nu", new Uint8Array(511)),
    /exactly 512/,
  );
});

test("multi-patch operations validate atomically and unknown-section errors cannot partially mutate state", async () => {
  const workspace = await openWorkspace(inventedContainer());
  const before = workspace.getBytes();
  for (const badPatch of [
    { section: "missing", offset: 0, bytes: Uint8Array.of(1) },
    { section: "ui_nu", offset: 512, bytes: Uint8Array.of(1) },
    { section: "file", offset: -1, bytes: Uint8Array.of(1) },
    { section: "file", offset: 1.5, bytes: Uint8Array.of(1) },
    { section: "file", offset: 0, bytes: [1] },
  ]) {
    assert.throws(() =>
      workspace.applyPatches([
        { section: "ui_nu", offset: 0, bytes: Uint8Array.of(99) },
        badPatch,
      ]),
    );
    assert.deepEqual(workspace.getBytes(), before);
    assert.equal(workspace.info.revision, 0);
    assert.equal(workspace.info.canUndo, false);
  }
  assert.throws(() => workspace.spliceFile(0, -1, new Uint8Array()), /outside/);
  assert.throws(
    () => workspace.spliceFile(0, 0, new Uint8Array(MAX_FILE_SIZE)),
    /32 MiB/,
  );
  assert.deepEqual(workspace.getBytes(), before);
});

test("file headers and trailers remain editable and invalid framing falls back to raw view", async () => {
  const original = inventedContainer();
  const workspace = await openWorkspace(original);
  workspace.applyPatches(
    [{ section: "file", offset: 526, bytes: ascii("BROKEN!") }],
    "Edit code terminator",
  );
  assert.equal(workspace.info.containerValid, false);
  assert.deepEqual(workspace.sections, []);
  assert.throws(() => workspace.getBytes("ui_nu"), /not available/);
  assert.equal((await workspace.export()).manifest.containerValid, false);
  assert.equal((await workspace.export()).bytes.length, original.length);
  workspace.undo();
  assert.equal(workspace.info.containerValid, true);
  workspace.spliceFile(0, 0, Uint8Array.of(0xfe), "Prefix byte");
  assert.equal(workspace.info.fileSize, original.length + 1);
  assert.equal(workspace.getBytes()[0], 0xfe);
  workspace.undo();
  assert.deepEqual(workspace.getBytes(), original);
});

test("GPS record splices update framing and following section offsets while preserving all other bytes", async () => {
  const original = inventedContainer(true);
  const workspace = await openWorkspace(original);
  const gps = workspace.sections.find(
    (section) => section.name === "GPSD:LRDB",
  );
  const footer = workspace.sections.find((section) => section.name === "NMGF");
  assert.equal(gps.key, 210);
  assert.equal(workspace.getBytes(gps.name)[0], 255);
  const replacement = gpsRecord(1024);
  workspace.spliceFile(
    gps.offset - 12,
    gps.size + 31,
    replacement,
    "Replace GPS database",
  );
  assert.equal(workspace.info.containerValid, true);
  assert.equal(
    workspace.sections.find((section) => section.name === gps.name).size,
    1024,
  );
  assert.equal(
    workspace.sections.find((section) => section.name === "NMGF").offset,
    footer.offset + 512,
  );
  assert.deepEqual(
    workspace.getBytes().subarray(0, gps.offset - 12),
    original.subarray(0, gps.offset - 12),
  );
  assert.deepEqual(
    workspace.getBytes().subarray(footer.offset + 512),
    original.subarray(footer.offset),
  );
  const manifest = (await workspace.export()).manifest;
  assert.equal(manifest.outputSize - manifest.inputSize, 512);
  assert.equal(manifest.comparisonBasis, "absolute-file-offsets");
  assert.match(manifest.differenceNote, /unchanged content moved/);
  assert.equal(manifest.operations[0].kind, "splice");
  workspace.undo();
  assert.deepEqual(workspace.getBytes(), original);
});

test("input subarray bounds, asynchronous snapshots, and export snapshots are isolated from callers", async () => {
  const original = inventedContainer();
  const backing = new Uint8Array(original.length + 8);
  backing.set(original, 4);
  const pending = openWorkspace(backing.subarray(4, 4 + original.length));
  backing.fill(0);
  const workspace = await pending;
  assert.deepEqual(workspace.getBytes(), original);
  workspace.applyPatches([{ offset: 4, bytes: Uint8Array.of(1) }]);
  const snapshot = workspace.getBytes();
  const exportPending = workspace.export();
  workspace.applyPatches([{ offset: 5, bytes: Uint8Array.of(2) }]);
  assert.deepEqual((await exportPending).bytes, snapshot);
  await assert.rejects(
    openWorkspace(new Uint8Array(MAX_FILE_SIZE + 1)),
    /32 MiB/,
  );
  await assert.rejects(
    openWorkspace(original, { reference: new Uint8Array(3) }),
    /reference must match/,
  );
  assert.equal((await openWorkspace(new Uint8Array())).info.fileSize, 0);
});

test("Node Buffer inputs and patches cannot expose private snapshots through Buffer.slice views", async () => {
  const expected = inventedContainer();
  const input = Buffer.from(expected);
  const pending = openWorkspace(input);
  input.fill(0);
  const workspace = await pending;
  assert.deepEqual(workspace.getBytes(), expected);
  const publicCopy = workspace.getBytes();
  publicCopy.fill(0);
  assert.deepEqual(workspace.getBytes(), expected);
  const patch = Buffer.from([0x44]);
  workspace.applyPatches([{ section: "ui_nu", offset: 0, bytes: patch }]);
  patch.fill(0);
  assert.equal(workspace.getBytes("ui_nu")[0], 0x44);
  workspace.undo();
  assert.deepEqual((await workspace.export()).bytes, expected);
});

test("undo history and positional diff reports have explicit bounds", async () => {
  const workspace = await openWorkspace(new Uint8Array(10000));
  for (let i = 1; i <= 30; i++)
    workspace.applyPatches([{ offset: 0, bytes: Uint8Array.of(i) }]);
  let undos = 0;
  while (workspace.undo()) undos++;
  assert.equal(undos, 24);
  assert.equal(workspace.getBytes()[0], 6);
  workspace.reset();
  const replacement = Uint8Array.from({ length: 10000 }, (_, i) => i % 2);
  workspace.replaceSection("file", replacement);
  const { manifest } = await workspace.export();
  assert.equal(manifest.changedBytes, 5000);
  assert.equal(manifest.diffRangeCount, 5000);
  assert.equal(manifest.diffRanges.length, 4096);
  assert.equal(manifest.diffRangesTruncated, true);
});

const fixture = process.env.R7_FIXTURE;
test(
  "private R7 fixture: band edits reimport, raw code reference recovery, framing protection, and byte preservation",
  { skip: !fixture },
  async () => {
    const original = new Uint8Array(await readFile(fixture));
    const workspace = await openWorkspace(original);
    assert.equal(
      workspace.info.profileKnown,
      true,
      workspace.info.profileReason,
    );
    assert.equal(workspace.sections.length, 10);
    assert.equal(
      workspace.sections.find((section) => section.name === "sound_dbnu").key,
      225,
    );
    assert.deepEqual((await workspace.export()).bytes, original);
    const dsp = workspace.getBytes("dsp_nu");
    const frequencies = new Uint8Array(8);
    const view = new DataView(frequencies.buffer);
    view.setUint32(0, 33000000, true);
    view.setUint32(4, 34000000, true);
    workspace.applyPatches(
      [{ section: "dsp_nu", offset: 0xdd34 + 4, bytes: frequencies }],
      "Change band start/end",
    );
    const editedDsp = workspace.getBytes("dsp_nu");
    assert.deepEqual(editedDsp.subarray(0, 0xdd38), dsp.subarray(0, 0xdd38));
    assert.deepEqual(editedDsp.subarray(0xdd40), dsp.subarray(0xdd40));
    assert.deepEqual(editedDsp.subarray(0xdd38, 0xdd40), frequencies);
    const section = workspace.sections.find((entry) => entry.name === "dsp_nu");
    let exported = await workspace.export();
    assert.deepEqual(
      exported.bytes.subarray(0, section.offset),
      original.subarray(0, section.offset),
    );
    assert.deepEqual(
      exported.bytes.subarray(section.offset + section.size),
      original.subarray(section.offset + section.size),
    );
    assert.equal((await openWorkspace(exported.bytes)).info.profileKnown, true);
    const oldUi = workspace.getBytes("ui_nu");
    workspace.applyPatches(
      [
        {
          section: "ui_nu",
          offset: 0x200,
          bytes: Uint8Array.of(oldUi[0x200] ^ 1),
        },
      ],
      "Expert code patch",
    );
    assert.equal(workspace.info.profileKnown, true);
    assert.match(
      workspace.info.profileReason,
      /not been independently fingerprint-verified/,
    );
    exported = await workspace.export();
    const reopened = await openWorkspace(exported.bytes);
    assert.equal(reopened.info.profileKnown, false);
    assert.deepEqual((await reopened.export()).bytes, exported.bytes);
    const referenced = await openWorkspace(exported.bytes, {
      reference: original,
    });
    assert.equal(referenced.info.profileKnown, true);
    assert.match(
      referenced.info.profileReason,
      /reference.*not fingerprint-verified/,
    );
    assert.equal(
      referenced.info.referenceSha256,
      "f0197e9f490b58bb7e4b7b14c1c2c4e498166b4389c566a6d49b511f91a48d4a",
    );
    const changedModel = exported.bytes.slice();
    new DataView(changedModel.buffer).setUint16(
      section.offset + section.size,
      (8 << 10) | 150,
      true,
    );
    await assert.rejects(
      openWorkspace(changedModel, { reference: original }),
      /same R7 code-section layout/,
    );
    const gpsSection = workspace.sections.find(
      (entry) => entry.name === "gps_nu",
    );
    workspace.applyPatches(
      [
        {
          offset: gpsSection.offset + gpsSection.size,
          bytes: Uint8Array.of(128, 28),
        },
      ],
      "Change GPS version",
    );
    assert.equal(workspace.info.profileKnown, false);
    workspace.undo();
    assert.equal(workspace.info.profileKnown, true);
    workspace.reset();
    assert.deepEqual(workspace.getBytes(), original);
  },
);

test(
  "private R7 fixture: graphic and scan edits retain recognition, while other initialized RAM and band metadata changes do not",
  { skip: !fixture },
  async () => {
    const original = new Uint8Array(await readFile(fixture));
    const workspace = await openWorkspace(original);
    const ui = workspace.getBytes("ui_nu");
    const frames = readScanFrames(ui);
    frames[0][0] = (frames[0][0] + 1) % 5;
    workspace.applyPatches(
      [
        makeScanFramesPatch(ui, frames),
        {
          section: "ui_nu",
          offset: 0x2c025,
          bytes: Uint8Array.of(ui[0x2c025] ^ 0x80),
        },
      ],
      "Edit glyph and scan motion",
    );
    let reopened = await openWorkspace((await workspace.export()).bytes);
    assert.equal(reopened.info.profileKnown, true, reopened.info.profileReason);
    assert.deepEqual(readScanFrames(reopened.getBytes("ui_nu")), frames);
    const modifiedUi = workspace.getBytes("ui_nu");
    const ram = decompressLzss(
      modifiedUi,
      SCAN_DATA.offset,
      SCAN_DATA.outputLength,
    ).bytes;
    ram[0x100] ^= 1;
    const packed = compressLzss(ram);
    assert.ok(packed.length <= SCAN_DATA.capacity);
    const patch = new Uint8Array(SCAN_DATA.capacity).fill(255);
    patch.set(packed);
    workspace.applyPatches(
      [{ section: "ui_nu", offset: SCAN_DATA.offset, bytes: patch }],
      "Change initialized RAM outside frames",
    );
    reopened = await openWorkspace((await workspace.export()).bytes);
    assert.equal(reopened.info.profileKnown, false);
    assert.match(reopened.info.profileReason, /initialized RAM differs/);
    workspace.reset();
    const dsp = workspace.getBytes("dsp_nu");
    workspace.applyPatches(
      [
        {
          section: "dsp_nu",
          offset: 0xdd34,
          bytes: Uint8Array.of(dsp[0xdd34] ^ 1),
        },
      ],
      "Change band hardware type",
    );
    reopened = await openWorkspace((await workspace.export()).bytes);
    assert.equal(reopened.info.profileKnown, false);
    assert.match(reopened.info.profileReason, /dsp_nu differs/);
  },
);
