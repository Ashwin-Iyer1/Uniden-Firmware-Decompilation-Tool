/** Advanced editors matching the R7 Python patch-file and string workflows. */
import { inputBytes, MAX_FILE_SIZE } from "./binary.mjs";
import { formatSignature } from "./resources.mjs";

const MAX_PATCHES = 10000;

/** Parse Python patch lines: hexadecimal offset, contiguous hex bytes, # comment.
 * All ranges are checked before returning. Pass the returned array to one
 * workspace.applyPatches call so overlapping lines apply in order, atomically.
 */
export function parsePatchFile(
  text,
  { section = "ui_nu", decoded = true, size } = {},
) {
  if (typeof text !== "string") throw new TypeError("Patch file must be text.");
  if (
    text.length > MAX_FILE_SIZE ||
    new TextEncoder().encode(text).length > MAX_FILE_SIZE
  )
    throw new RangeError("Patch files must be 32 MiB or smaller.");
  if (typeof section !== "string" || !section)
    throw new TypeError("Choose a patch region.");
  if (typeof decoded !== "boolean")
    throw new TypeError("The decoded option must be a boolean.");
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SIZE)
    throw new RangeError("Patch region size must be an integer from 0 to 32 MiB.");
  const patches = [];
  let totalBytes = 0;
  for (const [index, raw] of text.split(/\r\n|\n|\r/).entries()) {
    const line = raw.split("#", 1)[0].trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (
      fields.length !== 2 ||
      !/^(?:0x)?[0-9a-f]+$/i.test(fields[0]) ||
      !/^(?:[0-9a-f]{2})+$/i.test(fields[1])
    )
      throw new RangeError(
        `Patch line ${index + 1} needs a hexadecimal offset and contiguous byte pairs, such as 0x2268 524F4144.`,
      );
    const offset = Number.parseInt(fields[0], 16),
      length = fields[1].length / 2;
    if (!Number.isSafeInteger(offset) || offset > size - length)
      throw new RangeError(`Patch line ${index + 1} extends beyond the selected region.`);
    if (patches.length === MAX_PATCHES)
      throw new RangeError("Apply at most 10,000 patch lines in one operation.");
    totalBytes += length;
    if (totalBytes > MAX_FILE_SIZE)
      throw new RangeError("Patch bytes must total 32 MiB or less.");
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++)
      bytes[i] = Number.parseInt(fields[1].slice(i * 2, i * 2 + 2), 16);
    patches.push({ section, offset, bytes, decoded });
  }
  return patches;
}

function latin1Text(bytes) {
  let text = "";
  // TextDecoder's latin1 label uses Windows-1252, which changes 0x80..0x9f.
  for (let offset = 0; offset < bytes.length; offset += 4096)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  return text;
}

/** Match Python field_size: text through its first NUL, plus all following NULs. */
export function readStringField(value, offset) {
  const bytes = inputBytes(value);
  if (bytes.length > MAX_FILE_SIZE)
    throw new RangeError("String regions must be 32 MiB or smaller.");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length)
    throw new RangeError("String offset must lie inside the selected region.");
  const end = bytes.indexOf(0, offset);
  if (end < 0) throw new RangeError("String has no NUL terminator in this region.");
  let stop = end + 1;
  while (stop < bytes.length && bytes[stop] === 0) stop++;
  return {
    offset,
    size: stop - offset,
    maxLength: stop - offset - 1,
    text: latin1Text(bytes.subarray(offset, end)),
  };
}

/** Return the entire replacement field, including NUL padding, without mutation. */
export function patchStringField(value, offset, text) {
  const field = readStringField(value, offset);
  if (typeof text !== "string" || /[^\x01-\xff]/.test(text))
    throw new RangeError("Text must use Latin-1 characters (1–255), without NUL.");
  if (text.length > field.maxLength)
    throw new RangeError(`Text is limited to ${field.maxLength} characters.`);
  if (formatSignature(field.text) !== formatSignature(text))
    throw new RangeError(
      "Keep printf format tokens unchanged and in their original order. Use %% for a new literal percent sign.",
    );
  const result = new Uint8Array(field.size);
  for (let i = 0; i < text.length; i++) result[i] = text.charCodeAt(i);
  return result;
}
