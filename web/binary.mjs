/** Byte-preserving Uniden old-model codec shared by browser editors. */
export const MAX_FILE_SIZE = 32 * 1024 * 1024;
export function inputBytes(value) {
  // Buffer is a Uint8Array subclass whose .slice() creates a shared view. Return
  // a plain typed-array view so callers' .slice() always makes an owned copy.
  if (value instanceof Uint8Array)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected a firmware ArrayBuffer or Uint8Array.");
}

function checkCodecInput(key, value) {
  if (!Number.isInteger(key) || key < 0 || key > 255)
    throw new RangeError("Codec key must be a byte.");
  const bytes = inputBytes(value);
  if (bytes.length % 4)
    throw new RangeError(
      "Encoded sections must contain complete four-byte groups.",
    );
  return bytes;
}

export function decodeOldModel(key, value) {
  const source = checkCodecInput(key, value);
  const result = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 4) {
    for (let p = 0; p < 4; p++) {
      let v = 0;
      for (let j = 0; j < 4; j++)
        v |= ((source[i + j] >>> (2 * p)) & 3) << (2 * j);
      result[i + p] = (v - key) & 255;
    }
  }
  return result;
}

export function encodeOldModel(key, value) {
  const source = checkCodecInput(key, value);
  const result = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 4) {
    for (let j = 0; j < 4; j++) {
      let v = 0;
      for (let p = 0; p < 4; p++)
        v |= ((((source[i + p] + key) & 255) >>> (2 * j)) & 3) << (2 * p);
      result[i + j] = v;
    }
  }
  return result;
}
