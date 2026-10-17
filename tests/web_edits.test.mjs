import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parsePatchFile, readStringField, patchStringField } from "../web/edits.mjs";
import { openWorkspace } from "../web/firmware.mjs";
import { encodeOldModel, MAX_FILE_SIZE } from "../web/binary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const latin1 = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));

function inventedContainer(decoded) {
  // Invented payload and valid R7 framing; no vendor firmware is committed.
  assert.equal(decoded.length % 512, 0);
  const bytes = new Uint8Array(12 + decoded.length + 9 + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, decoded.length - 1, true);
  bytes.set(encodeOldModel(182, decoded), 12);
  view.setUint16(12 + decoded.length, (7 << 10) | 153, true);
  bytes.set(latin1("DRSWMAI"), 14 + decoded.length);
  bytes.set(latin1("NMGF"), 21 + decoded.length);
  view.setUint32(29 + decoded.length, 100, true);
  return bytes;
}

function pythonPatch(original, operation) {
  const directory = mkdtempSync(path.join(tmpdir(), "r7-web-edits-"));
  try {
    writeFileSync(path.join(directory, "input.bin"), original);
    const result = spawnSync(
      process.env.PYTHON || "python3",
      ["-c", String.raw`
import contextlib, io, json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / 'tools'))
from rseries_patch import patch, setstr
directory = pathlib.Path(sys.argv[2])
operation = json.load(sys.stdin)
with contextlib.redirect_stdout(io.StringIO()):
    if operation['mode'] == 'string':
        setstr(str(directory / 'input.bin'), 'ui_nu', operation['offset'],
               operation['text'], str(directory / 'output.bin'))
    else:
        patchfile = directory / 'patch.txt'
        patchfile.write_text(operation['text'])
        patch(str(directory / 'input.bin'), 'ui_nu', str(patchfile),
              str(directory / 'output.bin'))
`, root, directory],
      { input: JSON.stringify(operation), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return new Uint8Array(readFileSync(path.join(directory, "output.bin")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("patch files accept Python hex offsets, comments, blank lines, and preserve order", () => {
  const patches = parsePatchFile(
    "# heading\r\n  0x0a 0102 # first\r\n\r\nB FF\n0C 0aBc\n",
    { section: "dsp_nu", decoded: false, size: 32 },
  );
  assert.deepEqual(patches, [
    { section: "dsp_nu", decoded: false, offset: 10, bytes: Uint8Array.of(1, 2) },
    { section: "dsp_nu", decoded: false, offset: 11, bytes: Uint8Array.of(255) },
    { section: "dsp_nu", decoded: false, offset: 12, bytes: Uint8Array.of(10, 188) },
  ]);
  assert.deepEqual(parsePatchFile("# empty\n\n", { size: 0 }), []);
  const [last] = parsePatchFile("f ff", { size: 16 });
  assert.equal(last.section, "ui_nu");
  assert.equal(last.decoded, true);
  assert.equal(last.offset, 15);
});

test("patch files reject malformed input, unsafe offsets, oversized files, and too many lines", () => {
  for (const text of [
    "0", "0 0", "0 00 11", "0 GG", "-1 ff", "1.0 ff", "1e1 ff",
    "0x ff", "10000000000000000 ff", "10 ff", "f ffff", "0 0xff",
  ])
    assert.throws(() => parsePatchFile(text, { size: 16 }), undefined, text);
  for (const size of [undefined, -1, 0.5, Infinity, NaN, MAX_FILE_SIZE + 1])
    assert.throws(() => parsePatchFile("0 ff", { size }));
  assert.throws(() => parsePatchFile(null, { size: 1 }));
  assert.throws(() => parsePatchFile("0 ff", { size: 1, section: "" }));
  assert.throws(() => parsePatchFile("0 ff", { size: 1, decoded: "true" }));
  assert.throws(() => parsePatchFile("#".repeat(MAX_FILE_SIZE + 1), { size: 1 }));
  assert.throws(() => parsePatchFile("#" + "é".repeat(MAX_FILE_SIZE / 2), { size: 1 }));
  assert.equal(parsePatchFile("0 ff\n".repeat(10000), { size: 1 }).length, 10000);
  assert.throws(() => parsePatchFile("0 ff\n".repeat(10001), { size: 1 }));
});

test("patch files apply overlapping lines sequentially, atomically, and undo together", async () => {
  const original = Uint8Array.of(10, 11, 12, 13, 14, 15);
  const ws = await openWorkspace(original);
  assert.throws(() => ws.applyPatches(parsePatchFile("0 aabb\n5 ccdd", {
    section: "file", size: original.length,
  })));
  assert.deepEqual(ws.getBytes(), original);
  assert.equal(ws.info.revision, 0);
  const patches = parsePatchFile("1 aabbcc\n2 1122\n3 ff", {
    section: "file", decoded: false, size: original.length,
  });
  ws.applyPatches(patches, "Python patch file");
  assert.deepEqual(ws.getBytes(), Uint8Array.of(10, 170, 17, 255, 14, 15));
  assert.equal(ws.info.changeCount, 1);
  assert.equal(ws.undo(), true);
  assert.deepEqual(ws.getBytes(), original);
});

test("decoded patch files produce the exact complete output of Python patch", async () => {
  const decoded = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
  const original = inventedContainer(decoded);
  const text = "# unaligned codec groups and sequential overlap\n1 aabbccdd\n3 112233\n1ff fe\n";
  const ws = await openWorkspace(original);
  ws.applyPatches(parsePatchFile(text, { size: decoded.length }), "Python patch file");
  assert.deepEqual((await ws.export()).bytes, pythonPatch(original, { mode: "patch", text }));
});

test("explicit string fields include all NUL padding, short and empty fields, and Latin-1 bytes", () => {
  assert.deepEqual(readStringField(Uint8Array.of(65, 0, 0, 255), 0), {
    offset: 0, size: 3, maxLength: 2, text: "A",
  });
  assert.deepEqual(readStringField(Uint8Array.of(255, 0, 0, 0), 1), {
    offset: 1, size: 3, maxLength: 2, text: "",
  });
  const bytes = Uint8Array.from([...Array.from({ length: 255 }, (_, i) => i + 1), 0]);
  const field = readStringField(bytes, 0);
  assert.equal(field.text.length, 255);
  assert.equal(field.text.charCodeAt(127), 128);
  assert.equal(field.text.charCodeAt(158), 159);
  assert.equal(field.text.charCodeAt(254), 255);
  const long = new Uint8Array(4096);
  long.fill(65, 0, 1500);
  assert.equal(readStringField(long, 0).size, 4096);
  assert.equal(readStringField(long, 0).text.length, 1500);
  for (const offset of [-1, 2, 0.5, Infinity, NaN, "0"])
    assert.throws(() => readStringField(Uint8Array.of(65, 0), offset));
  assert.throws(() => readStringField(Uint8Array.of(65, 66), 0), /NUL/);
  assert.throws(() => readStringField(new Uint8Array(), 0));
});

test("Latin-1 replacement preserves exact printf tokens and rejects truncation or implicit encoding", () => {
  const bytes = new Uint8Array(80);
  bytes.set(latin1("Réglage %3d / %.*f / %é"));
  assert.doesNotThrow(() => patchStringField(bytes, 0, "État %3d / %.*f / %é 100%%"));
  for (const text of [
    "État %d / %.*f / %é", "État %.*f / %3d / %é", "État %3d / %.*f / %ñ",
    "État %3d / %.*f / %é %n", "État %3d / %.*f / %é %", "x\0y", "€", "😀",
  ])
    assert.throws(() => patchStringField(bytes, 0, text), undefined, text);
  const original = Uint8Array.of(65, 0, 0, 255);
  assert.deepEqual(patchStringField(original, 0, "\x80\x9f"), Uint8Array.of(128, 159, 0));
  assert.deepEqual(patchStringField(original, 0, ""), new Uint8Array(3));
  assert.deepEqual(original, Uint8Array.of(65, 0, 0, 255));
  assert.throws(() => patchStringField(original, 0, "ABC"));
  assert.throws(() => patchStringField(original, 0, 12));
});

test("short, empty, long, and Latin-1 string edits match Python setstr byte for byte", async () => {
  const cases = [
    { before: "A", size: 8, text: "OK" },
    { before: "", size: 8, text: "New" },
    { before: "Café", size: 32, text: "\x80\x9fDéjà\xff" },
    { before: "A".repeat(600), size: 1000, text: "B".repeat(800) },
    { before: "Temp %3d", size: 32, text: "Degré %3d" },
    { before: "Erase", size: 16, text: "" },
  ];
  for (const example of cases) {
    const decoded = new Uint8Array(2048).fill(0xaa), offset = 17;
    decoded.fill(0, offset, offset + example.size);
    decoded.set(latin1(example.before), offset);
    const original = inventedContainer(decoded), ws = await openWorkspace(original);
    ws.applyPatches([{
      section: "ui_nu", offset, decoded: true,
      bytes: patchStringField(ws.getBytes("ui_nu"), offset, example.text),
    }]);
    assert.deepEqual((await ws.export()).bytes,
      pythonPatch(original, { mode: "string", offset, text: example.text }));
  }
});
