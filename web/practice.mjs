/** Entirely invented bytes; no vendor firmware, instructions, or assets. */
export function practiceBytes() {
  const bytes = new Uint8Array(256);
  const text = new TextEncoder();
  bytes.set(text.encode("WORKBENCH PRACTICE / NOT DEVICE FIRMWARE"));
  bytes.set(text.encode("HELLO WORLD"), 0x40);
  bytes.set([0x10, 0x20, 0x30, 0x40], 0x80);
  for (let i = 0xc0; i < bytes.length; i++) bytes[i] = i - 0xc0;
  return bytes;
}
