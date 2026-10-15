import test from "node:test";
import assert from "node:assert/strict";
import { differencePage, differenceSummary } from "../web/comparison.mjs";
import { openWorkspace } from "../web/firmware.mjs";
import { practiceBytes } from "../web/practice.mjs";

test("review reports net changes, not the number of applied operations", async () => {
  const workspace = await openWorkspace(Uint8Array.of(1, 2, 3, 4));
  workspace.applyPatches([{ offset: 1, bytes: Uint8Array.of(7, 8) }]);
  let review = workspace.reviewChanges();
  assert.equal(review.changedBytes, 2);
  assert.deepEqual(review.ranges[0], { offset: 1, size: 2, before: [2, 3], after: [7, 8], truncated: false });
  review.ranges[0].before[0] = 255;
  assert.equal(workspace.reviewChanges().ranges[0].before[0], 2);
  workspace.applyPatches([{ offset: 1, bytes: Uint8Array.of(2, 3) }]);
  assert.equal(workspace.info.changeCount, 2);
  assert.equal(workspace.reviewChanges().changedBytes, 0);
  workspace.undo();
  assert.equal(workspace.reviewChanges().changedBytes, 2);
  workspace.reset();
  assert.equal(workspace.reviewChanges().changedBytes, 0);
});

test("comparison reports insertions and deletions positionally with missing bytes", async () => {
  const workspace = await openWorkspace(Uint8Array.of(10, 20, 30, 40));
  workspace.spliceFile(1, 0, Uint8Array.of(99));
  const inserted = workspace.reviewChanges();
  assert.equal(inserted.changedBytes, 4);
  assert.deepEqual(inserted.ranges[0].before, [20, 30, 40, null]);
  assert.deepEqual(inserted.ranges[0].after, [99, 20, 30, 40]);
  assert.equal(inserted.outputSize - inserted.inputSize, 1);
  assert.equal((await workspace.export()).manifest.changedBytes, inserted.changedBytes);
  workspace.reset();
  workspace.spliceFile(2, 2, new Uint8Array());
  assert.deepEqual(workspace.reviewChanges().ranges[0].after, [null, null]);
});

test("cursor pages reach all changes beyond the manifest range cap without duplicate ranges", () => {
  const before = new Uint8Array(20000);
  const after = Uint8Array.from(before, (_, i) => i % 2);
  assert.equal(differenceSummary(before, after).diffRangesTruncated, true);
  let offset = 0, count = 0, previous = -1;
  do {
    const page = differencePage(before, after, { offset, limit: 100 });
    for (const range of page.ranges) {
      assert.equal(range.offset, previous + 2);
      assert.equal(range.size, 1);
      previous = range.offset;
      count++;
    }
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(count, 10000);
});

test("large contiguous ranges have bounded previews and exact sizes", () => {
  const before = new Uint8Array(100000), after = new Uint8Array(100000).fill(255);
  const page = differencePage(before, after);
  assert.equal(page.ranges.length, 1);
  assert.equal(page.ranges[0].size, 100000);
  assert.equal(page.ranges[0].before.length, 24);
  assert.equal(page.ranges[0].truncated, true);
  assert.equal(page.nextOffset, null);
  for (const options of [{ offset: -1 }, { offset: 100001 }, { limit: 0 }, { limit: 101 }, { previewBytes: 257 }, { offset: 0.5 }])
    assert.throws(() => differencePage(before, after, options), RangeError);
  assert.deepEqual(differencePage(before, before).ranges, []);
});

test("practice sample stays unrecognized and uses the real edit, review, and export path", async () => {
  const original = practiceBytes();
  assert.equal(original.length, 256);
  assert.match(new TextDecoder().decode(original), /NOT DEVICE FIRMWARE/);
  const workspace = await openWorkspace(original);
  assert.equal(workspace.info.profileKnown, false);
  assert.equal(workspace.info.containerValid, false);
  workspace.applyPatches([{ offset: 0x40, bytes: new TextEncoder().encode("LOCAL") }]);
  const review = workspace.reviewChanges();
  assert.equal(review.changedBytes, 5);
  assert.equal(review.ranges[0].offset, 0x40);
  const output = await workspace.export();
  assert.equal(new TextDecoder().decode(output.bytes.slice(0x40, 0x4b)), "LOCAL WORLD");
  assert.notEqual(output.manifest.inputSha256, output.manifest.outputSha256);
  workspace.undo();
  assert.deepEqual(workspace.getBytes(), original);
});
