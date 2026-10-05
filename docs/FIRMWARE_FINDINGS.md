# R4W/R8W firmware findings

**Scope:** R8W `v142.113.127` and R4W `v127.128.123`, with database
`260702`. The main/DSP/GPS payloads have not been decoded. This document records
measured properties and completed offline checks. Unsupported payloads are
preserved unchanged; no controller-code decoder or editor is claimed.

## Reproduce the offline probes

```sh
python3 tools/rseries_probe.py /path/to/R8W_v142.113.127_db260702.bin
python3 tools/rseries_probe.py /path/to/R4W_v127.128.123_db260702.bin
```

This read-only command reports byte entropy, aligned 4/8/16/32-byte block
repetition, and candidate Cortex-M vectors under two address-map assumptions:
SRAM at `0x20000000`, code at zero or `0x08000000`. It tests all 256 legacy
transpose/subtract keys and 16 periodic XOR/subtract hypotheses per component.
The periodic hypotheses use the most frequent aligned 8/16-byte block as
possible uniform zero/FF padding, on raw and transposed data. A candidate vector
is a heuristic result, not a verified decoder. Other memory maps, a header
preceding the vector table, nonuniform padding or a different transform are
outside these tests.

Measured results:

| Payload | R8W entropy (bits/byte) | R8W repeated 16-byte occurrences | R4W entropy | R4W repeated 16-byte occurrences |
|---|---:|---:|---:|---:|
| Main | 7.9956 | 738 | 7.9747 | 1814 |
| DSP | 7.9981 | 344 | 7.9966 | 323 |
| GPS | 7.9947 | 95 | 7.9945 | 88 |
| Alternate DSP (`N2DS`) | 7.9980 | 340 | 7.9968 | 325 |

Repeated occurrences count copies beyond the first occurrence of each block.
Every component produced **zero candidate vectors in these 272 probes**. The
probe tests include positive controls for real-shaped legacy-encoded vectors
and a periodic XOR fixture so a probe failure is not just a nonworking detector.

The repeated aligned 16-byte blocks and near-uniform byte distribution do not
identify a cipher or decoding transform. These observations do not establish
AES-ECB or make the R7 decoding keys applicable.

## Container-related updater findings

The Windows Uniden R Series Tool v2.26 and the installed Mac updater were
inspected locally. No executable, vendor disassembly or extracted asset is
included in this repository. The following names identify methods in the
Windows updater, not API contracts implemented by this toolkit:

- `FWDloadFormat`: legacy sound/database keys and model-specific MCU ID strings.
  Its AES database flag identifies a format, not a recovered decryption key.
- `FWUpdate.DloadCheckMCUID`: matches the device's returned MCU ID to the
  component file offset and page count. R4W/R8W each have both `Nuv` and `Nuv2`
  DSP matches. The latter selects `dspNu2FileOffset`/`dspNu2FileLength`, consistent
  with `N2DS`. The container alone does not identify which DSP variant a
  particular detector uses.
- `FWUpdate.UpdateMCUSW`: its transfer loop copies a page directly from
  `FWFileInfo.fileData`, computes a transport checksum and sends it through
  `UARTCommUtils.WriteBytes`. This method does not decrypt the copied code page.
  A transport checksum is not evidence that arbitrary modified firmware is accepted.

A local candidate-key scan tested every byte offset of the Windows executable,
Mac executable and R8W wireless payload as contiguous AES-128/192/256 key
material, and as key bytes stored one per 32-bit word. Four repeated main-code
blocks (two per model, including the repeated early-vector-region block) were
used as targets. None decrypted to a uniform 16-byte value. This scan assumes
ordinary key storage, direct AES input and uniform plaintext: it does **not**
exclude byte-swapped keys/data, derived keys, expanded schedules, runtime-loaded
keys, other ciphers or additional transforms. No claim of an exhaustive AES
key search is made.

A follow-up AES-128 scan also tested original, reversed and 32-bit-word-swapped
key layouts, with original/reversed/word-swapped/legacy-transposed ciphertext
blocks on the same three files. It likewise found no uniform-padding match.
A synthetic AES-encrypted-zero fixture with a deliberately embedded key was
used to verify the scanning code's positive path. These representation checks
do not exclude derived keys, expanded schedules or non-AES transforms.
