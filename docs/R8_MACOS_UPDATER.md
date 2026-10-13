# R8 macOS updater: format selection and unchanged AEUS transfer

The official Uniden R Series Tool **2.22** selects the R8's AEUS database and
transfers its encrypted body unchanged. Its `oldModelDecoder` implements the
legacy two-bit transpose/subtract transform; the R8 database path skips it.
This investigation recovered neither an AEUS key nor an arbitrary-coordinate
encoder. Successful transfer does not establish that a camera record alerts.

## Target and analysis scope

- Mach-O x86-64 executable, 1,507,680 bytes, bundle version 2.22 (build 1).
- Executable SHA-256:
  `e9f58c4d3c3c8635dd038fef4acfda731a760d084aa0b70fc77e50508358b4c2`.
- Database fixture: `R4R8_R4WR8W_GPS_DB_20260702.bin`, 208,908 bytes;
  SHA-256 `4514be05ea02f4f2ff0b46d972923afa8b11758a29589043e432484c6b2b697b`.
- REA 6.4.0 with the native Ghidra 12.1.4 provider, JDK 21, Linux/amd64 Docker.
  The target was mounted read-only and the analysis container had no network.
- Ghidra imported 1,229 procedures and 5,126 strings. Twenty-five distinct
  procedures were selected for decompilation. This is a focused path analysis,
  not exhaustive semantic coverage of every procedure.
- Unicorn 2.1.4 executed the original x86-64 instructions in isolated checks.
  No macOS application runtime, USB device or detector was exercised.

Ghidra's Objective-C Message Analyzer logged `ArrayIndexOutOfBoundsException`
errors in its parallel analysis; the overall import and selected decompilations
completed. Selector/argument recovery must therefore be treated carefully.
The consequential format-selection, copy and legacy-decoder claims below were
also checked against disassembly and actual instruction execution. Framework
implementations were not supplied to Ghidra.

## Observed path

| Procedure | Address | Observation |
| --- | --- | --- |
| `FWfileInfo::readOnlyDBFileProc` | `0x100108470` | Reads the final 12 bytes, recognizes the marker and extracts count/date metadata. |
| `utils::getModelNameString:` | `0x1000c7331` | Model ID `0x12` is R8; `0x13`/`0x14`/`0x15` are R8NZ/R8IL/R8EU, and `0x1c` is R8w. |
| `FWUpdate::dloadCheckAvailableGPSDB::` | `0x1000f1a08` | R8-family eligibility requires the AES128-file flag. |
| `FWUpdate::dloadCheckDBType::::::::` | `0x1000f289d` | R8 models expect `RDY` and select a slot whose database type is 1. Returns its offset, complete 128-byte block count and type. |
| `FWUpdate::updateGPSDB::::::` | `0x1000f610f` | Negotiates upload, sends metadata, erases, copies blocks, checks acknowledgements and finishes. |
| `utils::oldModelDecoder::::` | `0x1000c7536` | Transposes two-bit groups in each four-byte word and subtracts a byte key modulo 256. |
| `utils::getCheckSumFromBytes::` | `0x1000c76bd` | Computes bytewise XOR without changing its input. |
| `UartComm::WriteBytes::` | `0x1000de2a0` | Passes the supplied buffer and length to the OS `write` call. |

### Footer parsing does not decrypt records

`AEUS`, `AENZ`, `AEIL` and `AEEU` set database type 1 and the
`gpsDBExistAES128File` flag. Count and date are read directly from the footer.
The legacy `LRDB`, `DFDB` and `IRDB` paths set type 0 and use the old decoder
for their encoded count field. Recognizing `AEUS` is a format classification,
not evidence that this function understands encrypted coordinates.

### The R8 skips the legacy decoder

The block-copy window begins at `0x1000f66d0`. It copies 128 bytes from the
selected input offset into the upload buffer. At `0x1000f674b`, type zero
enters the legacy path at `0x1000f6755`; nonzero type goes directly to the
checksum path at `0x1000f678f`. The R8 selection routine supplies type 1.

The `oldGPSDBKey` property does not establish an R8 AES key. Its setter in
`RDInfo::setModel:` (`0x10005e841`) assigns the byte subtraction constants for
legacy models; R8-family model cases skip that assignment. The upload code
only obtains this property inside the type-zero legacy branch.

For the July fixture, integer division of the 208,908-byte file length by 128
selects 1,632 blocks, or **208,896 body bytes**. The final 12-byte footer is
used as metadata rather than copied into those blocks. Each transmitted block
is followed by its one-byte XOR checksum; there is no AEUS transform in this
traced buffer-to-serial path.

### USB conversation and other possible leads

The traced database procedure uses the synchronization exchange, then `DBW`,
then the `RDY` type check. It exchanges a two-byte record count, four-byte date
and two-byte block count, checks their echoes, performs the erase handshake,
and sends the blocks with acknowledgement/retry handling. These fields and
acknowledgements are transport checks; none demonstrates successful coordinate
decoding or a GPS alert. The fixture's footer count is 13,050.

`FWUpdate::updateMCUSW:::::::` (`0x1000f51f4`) selects a component by its
identifier, copies its selected file bytes into the transfer buffer and sends
them with a checksum. The inspected MCU-ID selection and transfer routines did
not expose a host-side main-firmware decryption step or key setup.

The explicit read routes inspected were version/MCU identification and user
settings. `ReadRDVersion::userSettingRead::` (`0x10005a05f`) uses `USR`, receives
a reported length and data, and checks the XOR byte. The R8
`user_k_block_n_data_read` routine (`0x100058020`) decodes K-band settings in an
already supplied buffer; its name does not describe a flash-read command.
No arbitrary-memory, bootloader-dump or camera-record write command was found
in these inspected routes. That is a coverage-limited finding, not proof that
no such interface exists anywhere in the detector.

## Reproduce the instruction checks

Supply your own matching updater executable and AEUS database. The checker
ships no vendor binary, record fixture or pseudocode. It requires the exact
updater hash before using its addresses; its supported fixture size is capped
to keep the emulator's data and modeled-service regions separate.

```sh
python3 -m venv /tmp/r8-updater-checks
/tmp/r8-updater-checks/bin/pip install unicorn==2.1.4
/tmp/r8-updater-checks/bin/python tools/r8_macos_updater_checks.py \
  '/path/to/Uniden R Series Tool.app/Contents/MacOS/Uniden R Series Tool' \
  '/path/to/R4R8_R4WR8W_GPS_DB_20260702.bin' \
  --output /tmp/r8-updater-checks.json
```

Verified results:

- Five deterministic synthetic 4,096-byte inputs/key cases matched an
  independently authored mathematical legacy-transform reference.
- All 1,632 actual AEUS body blocks were copied unchanged through the type-1
  branch. Type zero entered the separate legacy-decoder branch.
- The original checksum instructions matched XOR on every block and preserved
  the payload bytes.
- Thirteen format-selection cases passed: five R8-family models accepted
  type 1 and rejected legacy-only slots; additional cases covered a wrong
  response, selection of a second type-1 slot, and an R7 legacy control.

The selection checks execute the real routine but model Objective-C property
access, retain/release and byte-comparison services. The surrounding app,
serial I/O and physical detector remain outside the emulation.

## Reproduce native REA queries

With REA's Ghidra provider configured, select the executable and use these
addresses in a retained MCP session (`open_binary`, then `batch_decompile`),
or query through the CLI:

```sh
rea analyze '/path/to/Uniden R Series Tool' --provider ghidra --json
rea decompile '/path/to/Uniden R Series Tool' 0x100108470 --provider ghidra --json
rea decompile '/path/to/Uniden R Series Tool' 0x1000f289d --provider ghidra --json
rea decompile '/path/to/Uniden R Series Tool' 0x1000f610f --provider ghidra --json
```

Keep raw pseudocode, disassembly, snapshots and vendor inputs locally. Import
on the tested emulated Linux host took about eight minutes; its configured
`REA_GHIDRA_STARTUP_TIMEOUT_MS` was 900000. A persistent MCP session avoids
reimporting the target for each new question. Successful import does not erase
the analyzer warnings noted above.

## What this contributes to working Hong Kong alerts

This independently corroborates the
[BLES staging/serial-transfer findings](R8_DATABASE_TRANSFER.md): the examined
host and BLE paths move the encoded data onward. The macOS installer supplies
useful protocol and format-selection evidence, but it does not provide the
missing general R8 database encoder. Changing a footer marker or reproducing
an upload acknowledgement cannot establish a valid new encrypted record.

The remaining target is the receiving controller's AEUS decoder/key setup, or
a separately verified supported coordinate-write interface. Any recovered
transform must reproduce complete official databases across releases before
building a new point. A later controlled test on the user's R8 is still needed
to establish a real alert. Detector access was unavailable during this work.
