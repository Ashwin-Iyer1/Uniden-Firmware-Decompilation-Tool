# R4W and R8W support

The toolkit supports **container inspection, component extraction, wireless-image
inspection, and byte-exact reproduction** for these stock updates:

- `R8W_v142.113.127_db260702.bin`
- `R4W_v127.128.123_db260702.bin`

The main, DSP and GPS code payloads remain opaque. Applying the R7
transpose/subtract keys to these images does not produce valid Cortex-M vector
tables. R7 editing tools therefore reject these models before writing output.
These operations do not include controller-code decompilation or a verified
custom-firmware flashing workflow.

## Usage

No Python packages are needed for the container tools. Firmware is supplied
locally and is never included in this repository.

```sh
python3 tools/rseries.py inspect /path/to/R8W_v142.113.127_db260702.bin
python3 tools/rseries.py inspect /path/to/R4W_v127.128.123_db260702.bin --json
python3 tools/rseries.py extract /path/to/R8W_v142.113.127_db260702.bin decoded/r8w
python3 tools/rseries.py repack decoded/r8w /tmp/r8w-reproduced.bin
```

Extraction requires an empty directory. It writes:

- A `manifest.json` with the model, source SHA256, component offsets, versions,
  declared and padded lengths, encoding status, and component SHA256 hashes.
- Raw files covering **every original byte**, including the package header,
  component headers, padding and version trailers.
- Separate decoded files only when a decoder is established (R7 code, legacy
  R7 sound and legacy camera databases).
- ESP segment files named with their actual load addresses, plus ESP-IDF build
  metadata in the manifest. The ESP segment XOR checksum and appended digest,
  when present, are validated before extraction.

`repack` concatenates the original raw pieces and verifies the manifest's
original whole-image SHA256. It rejects changed, missing, resized or reordered
pieces and never overwrites an existing output. It intentionally does not
accept edited components; integrity/signature rules for custom W-model firmware
have not been established. Separately exported decoded/ESP segment files are
analysis artifacts and are not repack inputs.

The `rseries_unpack.py parse` and `extract` commands also accept these containers.
They preserve unsupported components as `.raw.bin`, and `parse --json` exposes
the added metadata. Use `rseries.py` for complete framing preservation and ESP
validation.

## Verified component map

Offsets point to payloads, not their preceding headers. Lengths include
container padding where applicable. Values below were measured directly from
the two input files; they are not guesses from their filenames.

| Component | R8W offset / length | R4W offset / length | R8W / R4W version | Status |
|---|---|---|---|---|
| Main (`ui_nu`) | `0x00000c` / 242176 | `0x00000c` / 232960 | 142 / 127 | Opaque |
| DSP (`dsp_nu`) | `0x03b215` / 119296 | `0x038e15` / 82432 | 113 / 128 | Opaque |
| GPS (`gps_nu`) | `0x05841e` / 46592 | `0x04d01e` / 47104 | 127 / 123 | Opaque |
| Camera DB (`GPSD:AEUS`) | `0x063a33` / 208896 | `0x058833` / 208896 | 20260702 / 20260702 | AES-128 identifier; ciphertext preserved |
| Sound (`STSD`) | `0x096a52` / 2211828 | `0x08b852` / 2223092 | 107 / 108 | Payload codec/key unresolved |
| Laser interface (`LSRS`) | `0x2b2a65` / 48128 | `0x2aa465` / 48128 | 123 / 123 | Opaque |
| Alternate DSP (`N2DS`) | `0x2be67a` / 119296 | `0x2b607a` / 88064 | 113 / 128 | Opaque; selected by MCU ID |
| Wireless (`BLES`) | `0x2db88f` / 1162240 | `0x2cb88f` / 1162240 | 124 / 124 | Valid ESP32-C3 image |
| Merge footer (`NMGF`) | `0x3f7498` / 12 | `0x3e7498` / 12 | Merge value 109 / 109 | Plain framing |

Model IDs in the main trailers are **28 (R8W)** and **24 (R4W)**. The camera
bodies are identical, and their clear footers report **13,050 POIs** and
**20260702**. The standalone camera update supplied for this investigation
contains the same body plus its 12-byte footer. The two laser-interface payloads
are also identical. Component metadata alone does not establish that hardware
or code is interchangeable between models.

The sound footer's version word uses the legacy transform with key **225**:
it produces little-endian 107/108. This does **not** identify the sound payload's
codec or decoding key. The same key is used by the existing `rseries_sound.py` for
R7 ISD3800 payloads; the unpacker's former key 255 was inconsistent with that
tool and is corrected for `sound_dbnu`.

Both wireless images have entry point **`0x403803fe`**, six segments and a valid
XOR checksum (`0xfb`). Their chip ID is 5 (ESP32-C3) and their app descriptors
identify ESP-IDF **`v5.0.8-dirty`**, project `main`, app version `1`. Build times
are **Feb 5 2026 18:29:01** for R8W and **Feb 4 2026 21:52:13** for R4W. Their
headers indicate no appended SHA256 digest; the toolkit also handles images
that do append one. These build timestamps describe the wireless component,
not the date of the entire update package.

For completed offline checks and container-related updater findings, see
[firmware findings](FIRMWARE_FINDINGS.md).

## Current support limits

- Main/DSP/GPS and alternate-DSP decoding: repeated 16-byte blocks suggest a
  block-based encoding/encryption, but this observation does not prove an AES
  algorithm, key or mode. The code is labelled `opaque`, not incorrectly
  labelled as decoded ARM code.
- Camera records: `AEUS` identifies the newer AES-128 database format in the
  upstream container parser. No decryption key has been recovered here; the
  old `LRDB` camera editor is not applicable.
- Sound: its footer is readable, but neither R7 sound extraction nor a
  clean-speech decoder is established for these `STSD` payloads.
- Hardware dispatch: updater v2.26 selects the primary or `N2DS` DSP component
  by matching the returned MCU ID to its Nuv/Nuv2 identifiers. The hardware
  identity of a particular detector is not encoded in these update files.
- Hidden buttons and diagnostics: no factory/service key combination has been
  verified from these opaque controller images.
- Parameters absent from the device menu: no verified patch offsets or support
  for changing such values are included.

## Validation

```sh
# Synthetic fixtures; no copyrighted firmware needed.
python3 -m unittest discover -s tests -v

# Additionally validate the exact two stock images above, outside the repo.
UNIDEN_FIRMWARE_DIR=/path/to/firmware python3 -m unittest discover -s tests -v
```

The optional integration test verifies source hashes, file sizes, model IDs,
component versions, DB count/date, ESP layout/checksum, and extraction/repack
identity for both images. Synthetic tests cover R7 compatibility, model guards,
truncation at every byte, malformed framing, changed manifests/pieces, and ESP
checksum/digest failures. Real R7 firmware was not supplied for this validation;
R7 framing/transform regressions are covered by synthetic fixtures.

Stock SHA256 hashes:

```text
R8W: 116584d1e688e4b7d7a448288c72d29fc93557382685cbaca0e32980a6ed7314
R4W: e7d6063a6241fe4bace7d766ba2357f4924648082ca518b9fa4332e9b648dbb3
```

## Sources

- [Upstream container layout and legacy transform](https://github.com/RadarDetectors/uniden-firmware-tool/blob/master/src/file.rs).
- [Espressif ESP32-C3 firmware image format](https://docs.espressif.com/projects/esptool/en/latest/esp32c3/advanced-topics/firmware-image-format.html).
- [Uniden R8W updates and release notes](https://www.uniden.info/download/index.cfm?s=r8w).
- [Uniden R4W updates and release notes](https://www.uniden.info/download/index.cfm?s=r4w).
