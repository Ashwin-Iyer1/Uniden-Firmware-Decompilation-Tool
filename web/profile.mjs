/** R7 v153.150.127 research metadata only; no firmware payload is bundled. */
export const R7_PROFILE = Object.freeze({
  ui_nu: Object.freeze({
    key: 182,
    version: 153,
    logicalSize: 0x2f8d8,
    size: 195072,
    sha256: "3d1cd3d5faa3d1bf4a2f061e575e6f6b352e056b688903074b3dee9c985302a6",
  }),
  dsp_nu: Object.freeze({
    key: 184,
    version: 150,
    logicalSize: 0x1bfe0,
    size: 114688,
    sha256: "4f9f9d16446ee818f691ace9ca351dfe2dc681aaa18cb4a69cd75e33e35bad5e",
  }),
  gps_nu: Object.freeze({
    key: 183,
    version: 127,
    logicalSize: 0x9eac,
    size: 40960,
    sha256: "a33c5ec9f01f1c91d4c4f9983b847c1f327134c8f8b4dd923610e03a5cffd607",
  }),
});

// Keep code and pointer tables fingerprinted. Candidate strings outside the
// three previously verified slots require the original reference on reimport.
export const UI_DATA_RANGES = Object.freeze(
  [
    [0x2268, 0x2274],
    [0xa458, 0xa46c],
    [0xa478, 0xa48c],
    [0x1fbca, 0x2df76], // Documented bitmap/font region through boot-logo end.
    [0x2f7ac, 0x2fa00], // Compressed .data plus its verified padding capacity.
  ].map(Object.freeze),
);
export const SCAN_DATA_HASH =
  "14a733c65c5d30de57f97e75595118ff15d82b8f9dc49e256fd1944c50c7f9fe";

/** Bounded startup decoder used solely to fingerprint initialized RAM. */
export function normalizedUiData(ui) {
  const out = new Uint8Array(0x514);
  let read = 0x2f7ac;
  let written = 0;
  const byte = () => {
    if (read >= ui.length) throw new Error("Truncated UI startup data.");
    return ui[read++];
  };
  while (written < out.length) {
    const control = byte();
    const literal = control & 7 || byte();
    const match = control >>> 4 || byte();
    if (literal < 1) throw new Error("Invalid UI startup literal length.");
    if (written + literal - 1 > out.length)
      throw new Error("UI startup literal exceeds initialized RAM.");
    for (let i = 1; i < literal; i++) out[written++] = byte();
    if (control & 8) {
      const back = byte();
      if (back < 1 || back > written || written + match + 2 > out.length)
        throw new Error("Invalid UI startup back-reference.");
      for (let i = 0; i < match + 2; i++) {
        out[written] = out[written - back];
        written++;
      }
    } else {
      if (written + match > out.length)
        throw new Error("UI startup zero run exceeds initialized RAM.");
      written += match;
    }
  }
  // Frame values index five tiles per theme. Reject values that address beyond
  // the documented tile set even though these bytes are excluded from the hash.
  if (out.subarray(0x298, 0x338).some((value) => value > 4))
    throw new Error("Scan frames contain an invalid tile index.");
  out.fill(0, 0x298, 0x338);
  return out;
}
