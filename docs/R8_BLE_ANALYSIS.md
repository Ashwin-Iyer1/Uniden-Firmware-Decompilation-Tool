# Reproducible R8 plaintext Bluetooth-firmware analysis

The R7 workflow can be applied to an R8 component after establishing its encoding,
CPU and memory map. The `BLES` component in the R8 releases below is a directly
readable DA14585 ARM Cortex-M0 RAM image. The R7 subtract keys are not used.
This workflow does not decode the opaque main/DSP/GPS images or encrypt AEUS
camera records. No physical detector behavior or custom-camera alert is verified.

## 1. Validate the component before disassembly

Supply your own official firmware; this repository contains no vendor images,
disassembly dumps or extracted assets.

```sh
python3 tools/r8_ble.py inspect /path/to/R8_firmware.bin
python3 tools/r8_ble.py extract /path/to/R8_firmware.bin \
  --output /tmp/r8-ble.bin
```

The output file must be new. The tool validates a bounded `BLES` length, the
1024-byte stored extent, `DRSWBLE` trailer, FF padding, RAM stack pointer, Thumb
reset vector and core exception vectors. It reports full-input and exact-payload
SHA-256 hashes. It scans candidate tags, rejects malformed candidates and refuses
ambiguous multiple valid components. These checks establish a plausible layout,
not an authenticity/signature or runtime integrity check. Unknown chip layouts
are rejected rather than inferred.

The declared length excludes the FF padding. As in the existing container grammar,
the stored extent is `(length // 1024 + 1) * 1024`, including an extra block when
the declared length is an exact multiple of 1024.

## 2. Import the exact unpadded payload into Ghidra

Use the language ID `ARM:LE:32:Cortex` and the separate compiler specification
`default`. `ARM:LE:32:Cortex:default` is the combined language/compiler display
string, not a valid language-ID argument. Load the bytes at `0x07fc0000` and
seed the reset handler as Thumb code. Do not assign a CPU to the encrypted
camera database and treat the resulting arbitrary instructions as evidence.

The following was exercised with Ghidra 12.1.4 and a 64-bit JDK 21. Keep the
project directory, extracted payload and output report outside the repository:

```sh
mkdir -p /tmp/r8-ghidra-work
/path/to/ghidra/support/analyzeHeadless /tmp/r8-ghidra-work r8ble \
  -import /tmp/r8-ble.bin \
  -loader BinaryLoader -loader-baseAddr 0x07fc0000 \
  -processor ARM:LE:32:Cortex -cspec default \
  -scriptPath "$PWD/ghidra_scripts" \
  -preScript SeedR8Ble.java \
  -postScript R8BleReport.java /tmp/r8-ghidra-work/ble-report.json \
  -analysisTimeoutPerFile 180 -deleteProject
```

`SeedR8Ble.java` establishes Thumb context and seeds the mapped core vectors.
`R8BleReport.java` records string anchors, direct references, references to
literal/pointer locations, containing functions and decompiler results. The
output includes local pseudocode: keep it local, as with extracted firmware.
Automatic analysis and pseudocode can be incomplete or wrong; follow the actual
instructions and data access before assigning a behavior to a function.

## 3. Compare firmware versions using payload identity

Static extraction was checked against eleven retained R8 firmware containers.
They contain two distinct BLES payloads. Offsets below are payload file offsets,
not header offsets or MCU addresses.

| Container version/date | Payload offset | Declared bytes | Payload identity |
| --- | --- | --- | --- |
| v126.106.116 / 230104_BLE | `0x8b052` | 52012 | A |
| v127.106.116 / 230406 | `0x8b052` | 52012 | A |
| v128.106.116 / 240402 | `0x8e452` | 52012 | A |
| v128.106.116 / 240702 | `0x8e452` | 52012 | A |
| v135.109.122 / 241002 | `0x1de865` | 53804 | B |
| v136.109.123 / 241002 | `0x1de865` | 53804 | B |
| v136.109.123 / 250103 | `0x1de865` | 53804 | B |
| v136.109.123 / 250403 | `0x1df865` | 53804 | B |
| v136.109.123 / 250702 | `0x1e2865` | 53804 | B |
| v138.110.124 / 250702 | `0x1e5465` | 53804 | B |
| v139.111.125 / 251002 | `0x1e5265` | 53804 | B |

Payload A SHA-256:
`309349b77de745222c05129504b1c07df0a2f01d481733975e484bf995e8e978`

Payload B SHA-256:
`651ac9987a5b7ee159a0b78dce60ce435c5051d5490106e57bb4f4c7ae6a37be`

For the v139 container, the BLES header is at `0x1e5259`, the payload is at
`0x1e5265`, and its stored extent is 54272 bytes. Initial SP is `0x07fcf1a8`;
reset vector is `0x07fc056d` (Thumb entry address `0x07fc056c`). Input SHA-256:
`00f38d574487c5bcf86a1914a5271fce93bb782299adabb96f155f1c7ae46be6`.

Exact payload equality supports reusing *that component's* address findings
between containers carrying B. It does not imply the main/DSP/GPS images or
database are identical, or that a different model uses this BLE layout.

## 4. Validation and remaining work

Ghidra 12.1.4 completed import, vector seeding, auto-analysis and native
decompilation for both payload identities. The mapped extent was
`0x07fc0000..0x07fccb2b` for A and `0x07fc0000..0x07fcd22b` for B. BinaryLoader's
Program image-base property remained zero; the mapped addresses, rather than
that property alone, establish the load interpretation.

| Static anchor / consumer | Payload A | Payload B |
| --- | --- | --- |
| `AEUS` string | `0x07fccb0a` | `0x07fcd20a` |
| Reference inside database-format consumer | `0x07fc834c` | `0x07fc8712` |
| Containing function entry | `0x07fc8324` | `0x07fc86ea` |
| Bluetooth request classifier entry | `0x07fc5fe0` | `0x07fc6288` |
| Equality helper called by both classifiers | `0x07fca280` | `0x07fca922` |

The database-format consumer compares four-byte identifiers from a 12-byte
buffer against consecutive `AEUS`, `AENZ`, `AEIL`, `AEEU`, and `LRDB` strings,
with state-dependent branches. It stores a small format value in its context;
this is a format classifier, not evidence of an AES key or of accepting any
legacy database on an R8. The equality helper in A compares bytes and returns
1 for equality. Its read helper at `0x07fc1c12` issues an apparent SPI flash
read command (`0x03` with a 24-bit address) and copies bytes into the buffer.
The hardware role of the accessed flash and detector-side acceptance still
require corroboration.

The Bluetooth classifier recognizes request prefixes including `BTreqUMRK`,
and download-stage prefixes including `BTdnGDSTR` / `BTdnGDEND`. This identifies
an interface to investigate; it does not establish arbitrary-coordinate marks,
unencrypted uploads, or a custom-camera alert path.

Auto-analysis identified 420 function entries in A and 433 in B. These are
tool observations, not independently verified counts of all real functions.
Reference discovery can miss indirect uses; decompiler results are evidence
to check against the instructions and hardware, not original source.

```sh
python3 -m unittest discover -s tests -v
```

Synthetic tests cover malformed lengths, truncation, trailer/padding corruption,
invalid vectors, false tags, ambiguous valid components and exact extraction
without overwriting existing files. The eleven-file corpus check is separate
from these tests; fixtures do not redistribute vendor bytes.

Follow the database-format/POI string references through their consumers and
message handlers, then corroborate the relevant interface on a physical R8.
A reference to `AEUS` is not an encryption key. To support new camera records,
an encoder must reproduce complete official ciphertext across independent
releases, followed by a controlled detector alert test. That remains unresolved.
