/** Positional binary comparisons. No alignment or firmware semantics are inferred. */
export function differenceSummary(before, after) {
  const ranges = [];
  const length = Math.max(before.length, after.length);
  let start = -1, changedBytes = 0, rangeCount = 0;
  for (let i = 0; i <= length; i++) {
    if (i < length && before[i] !== after[i]) {
      changedBytes++;
      if (start < 0) start = i;
    } else if (start >= 0) {
      rangeCount++;
      if (ranges.length < 4096) ranges.push({ offset: start, size: i - start });
      start = -1;
    }
  }
  return {
    changedBytes, diffRanges: ranges, diffRangeCount: rangeCount,
    diffRangesTruncated: rangeCount > ranges.length,
  };
}

/** Cursor pagination also reaches ranges beyond the manifest's bounded preview. */
export function differencePage(before, after, { offset = 0, limit = 8, previewBytes = 24 } = {}) {
  const length = Math.max(before.length, after.length);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length)
    throw new RangeError("Comparison offset is outside the file.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("Comparison page size must be between 1 and 100.");
  if (!Number.isInteger(previewBytes) || previewBytes < 1 || previewBytes > 256)
    throw new RangeError("Comparison preview must be between 1 and 256 bytes.");
  const ranges = [];
  let i = offset;
  while (i < length) {
    if (before[i] === after[i]) { i++; continue; }
    if (ranges.length === limit) return { ranges, nextOffset: i };
    const start = i;
    while (i < length && before[i] !== after[i]) i++;
    const end = Math.min(i, start + previewBytes);
    ranges.push({
      offset: start, size: i - start,
      before: Array.from({ length: end - start }, (_, n) => before[start + n] ?? null),
      after: Array.from({ length: end - start }, (_, n) => after[start + n] ?? null),
      truncated: end < i,
    });
  }
  return { ranges, nextOffset: null };
}
