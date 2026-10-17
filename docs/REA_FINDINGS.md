# R7 REA/Ghidra continuation — 2026-10-15

This pass produced persistent Ghidra projects and C-like output for all **1,654 discovered
functions** in the three R7 application images, and corrected several protocol conclusions.
It does not recover original source names/types or prove that every indirect/unreachable
function has been discovered. Firmware was analyzed statically; no detector was connected or flashed.

## Artifacts and repeatable decompilation

| Image | Decoded bytes | Discovered/exported functions | Decompiler failures/timeouts |
|---|---:|---:|---:|
| `ui_nu` | 195,072 | 920 | 0 |
| `dsp_nu` | 114,688 | 454 | 0 |
| `gps_nu` | 40,960 | 280 | 0 |

Local outputs, deliberately ignored by Git:

- [UI C](../decoded/ghidra-complete/export/ui_nu/all_functions.c),
  [DSP C](../decoded/ghidra-complete/export/dsp_nu/all_functions.c),
  [GPS C](../decoded/ghidra-complete/export/gps_nu/all_functions.c).
- Each export directory contains `all_functions.asm`, per-function C/assembly,
  `functions.json`, `summary.json`, and `unclassified_flash_ranges.csv`.
- Saved projects: `decoded/ghidra-complete/projects/R7_ui_nu.gpr`,
  `R7_dsp_nu.gpr`, and `R7_gps_nu.gpr`.
- Complete REA MCP records and evidence bundles: `decoded/rea/`.

The raw-image headless workflow uses `ARM:LE:32:Cortex`, flash base zero, Thumb context,
actual vector targets, documented starts, the 30-entry DSP console table, and the two known
UI dispatch tables. It reconstructs all three startup `.data` regions and models writable
boot-zeroed `.bss`; remaining SRAM is uninitialized. SRAM model sizes are analysis choices,
not measurements of the exact MCU capacity. Adding the verified indirect tables recovered
28 functions beyond the first pass.

```sh
# Run a new analysis; use a new output directory if a project already exists.
GHIDRA_INSTALL_DIR=/path/to/ghidra \
JAVA_HOME=/path/to/compatible/jdk \
python3 tools/r7_decompile.py --output-dir decoded/ghidra-complete

# Export an existing saved project after annotations, preserving import provenance.
GHIDRA_INSTALL_DIR=/path/to/ghidra \
JAVA_HOME=/path/to/compatible/jdk \
python3 tools/r7_decompile.py --output-dir decoded/ghidra-complete --reexport
```

The runner validates exact decoded-image hashes and startup descriptors before applying
version-specific seeds. Export manifests distinguish decompilation success, timeout, failure,
and error. Successful decompilation means Ghidra produced pseudocode, not that the function's
types or behavior have been independently proven. The output is not guaranteed to compile.

## REA setup and evidence identity

Existing **Ghidra 12.1.2**, the native `mac_arm_64` decompiler, and **JDK 22.0.2** passed a real
headless/decompiler smoke test. No additional installation was needed. REA 6.5.0's persistent
Codex environment now sets `GHIDRA_INSTALL_DIR` and `JAVA_HOME`, with a 600-second tool timeout.
The previous config was backed up beside `~/.codex/config.toml`.

The already-connected REA process predated that environment change. This pass therefore used
fresh **REA stdio MCP** connections through `tools/r7_rea_session.py`, with initialization,
tool catalog, complete responses, and stderr retained locally. The host's existing MCP
connection needs reconnection to inherit the saved environment; the fresh connections used
here were verified with actual Ghidra analysis. See the official [MCP environment settings](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [Ghidra requirements](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.4_build/GhidraDocs/GettingStarted.md).

REA's generic raw ARM import does not admit a Cortex-M language override. For focused MCP
analysis, `tools/r7_analysis_elf.py` creates an **analysis-only ELF wrapper**: its single load
segment contains exactly the original decoded bytes at VA zero; the reset vector retains
the Thumb bit. Explicit seed/vector symbols are analyst-supplied metadata, not recovered
original symbols. ELF file offsets are decoded offsets plus `0x1000`; addresses in this report
remain decoded virtual addresses. The wrapper and its JSON manifest retain both hashes.

```sh
python3 tools/r7_analysis_elf.py decoded/ui_nu.bin --vector-count 158 \
  --seed b340:seed_b340 --seed 13e3c:seed_13e3c --seed f1a0:seed_f1a0
```

The source container is `R7_v153.150.127_db260702.bin`, SHA-256
`f0197e9f490b58bb7e4b7b14c1c2c4e498166b4389c566a6d49b511f91a48d4a`.
Fresh container decoding reproduced all three existing section files exactly:

| Image | SHA-256 |
|---|---|
| UI | `16a8c58e25766909faaa114beb22d87e2dd5108c3a176a2587fccb901218d79f` |
| DSP | `feb85e6dfff8eb23c095beafc6d028c15e3da446c6954d0266e11c1ddcba2a9d` |
| GPS | `a33c5ec9f01f1c91d4c4f9983b847c1f327134c8f8b4dd923610e03a5cffd607` |

## Confirmed corrections

### UI Ka labels and polarity

Menu cases 40–48 read `config[0xe0]` through `[0xe8]` and call renderer `0xb340` with segment
numbers 1–9. Renderer labels are explicitly “Ka 1” through “Ka 9”. A config value of **zero**
passes an On argument; a nonzero value passes Off. At `0xb3de`, argument two equal to 1 selects
`0xb52c` (`" On"`), otherwise `0xb530` (`"Off"`).

The SUB builder `0xf1a0` sets its corresponding wire bit when that config byte is zero.
`r7_iplink.py` previously inverted this menu meaning in `config_from_ka` and its decoder;
those helpers are corrected without changing the underlying bit layout. Literal frame
regressions cover every segment and all/none/mixed states. SUB bit positions are not DSP mask
positions: the DSP builder independently constructs its own bitmap.

Ghidra omitted the second argument in the first case's displayed `seed_b340(1)` call.
The assembly at `0x14482` (`r1=1`) and `0x14484` (`r0=r1`) establishes `(1,1)`.
This illustrates why inferred function signatures must be checked against instructions.

### Direct UI→DSP route and field byte order

UI `0xd61c` builds the 33-byte radar configuration frame beginning `0x90`. It calls byte-to-hex
encoder `0xdbf0`, sender `0xd5d0`, and TX routine `0x1b67c`, which writes **UART5 `0x40075000`**.
The DSP receives the matching protocol on UART3 `0x40073000`. The UI's own UART3 handler
`0x10cc` instead implements a `0x40`→`0x41` handshake; its matching numeric peripheral base
was not evidence that it carried DSP configuration.

The UI emits every u16 **low byte first**. DSP `0xcea4` decodes the first hex pair into the
low byte, the second pair into the next byte, then loads a little-endian halfword. For example,
`0x0005` appears as ASCII `0500`, not `0005`. `r7_ipc.py` now builds and decodes that ordering;
the XOR checksum still covers the original ASCII characters. The complete twelve-field and
config-offset map is in [DSP_PROTOCOL.md](DSP_PROTOCOL.md).

UI `0xd31c`/`0xd330`/`0xd468` send eight opcode-`0x11` records; `0xd994` invokes the opcode-`0x10`
builder. These functions were previously mislabeled as EEPROM operations. Their retries and
timeouts belong to DSP synchronization. The separate persistent-settings trace was unresolved
in this pass; it is now described in the [settings continuation](#r7-settings-continuation--2026-10-17).

### DSP mask selection and parsing

`0x8908` calls the 36-record combined builder `0x53c0` when bits 0 and 2 are set. Its fallback
`0x5788` also has a Ka-mask loop. Bit 1 takes priority over bit 0 when choosing a standard
group, so Ka segment records are masked when **bit0 && (bit2 || !bit1)**. The old “both bits
required” warning was wrong. This condition describes table mutation, not observed RF response.

The hex-byte decoder `0xdb76` accepts only `0–9` and `A–F`. The host decoder previously normalized
lowercase checksum text and could call it valid; it now rejects malformed wire characters.
For long opcodes `0x0f`/`0x10`/`0x11`, the dispatcher compares the XOR before configuration work.
Short opcodes `0x32`/`0x33`/`0x70` instead parse their two characters without that comparison;
host `checksum OK` output does not predict their hardware acceptance. Configuration updates
are sequential: a malformed later field can leave earlier updates applied.

## Evidence ledger

All rows below are **static Ghidra observations of byte-preserving analysis wrappers**;
semantic conclusions combine pseudocode with original-byte/Thumb checks. No row proves execution.

| Claim / address | REA Evidence ID | Retained local source |
|---|---|---|
| UI Ka renderer `0xb340` | `ev_e6d4fb1e2b439b8a898d0db290d028a47092d89bda0b8ea078b718ca16d34761` | `decoded/rea/session/03_ka_renderer.json` |
| UI menu dispatcher `0x13e3c` | `ev_53f584001ac53190d37096005bae91975e0586728e9aec9ddead2278b7e8395c` | Full record in `ui_evidence.json`; pseudocode view `session/08_menu_pseudocode.json` |
| On/Off bytes | `ev_d5449079275a00994e073b0eb2043831c54f850ba0f867be4e8d86766276a07f` | `session/06_on_off_strings.json` |
| SUB builder `0xf1a0` | `ev_788cbb49ce3b4b4d51fb8218f9f6d641002d4483fa3c75bc6826498c04e83c68` | `session/05_sub_config.json` |
| UI DSP builder `0xd61c` | `ev_98ad9bcd378482dea509bd03e9f8200430a881c9f51c2efd12223233bbb20ef3` | `ui_dsp_link/02_dsp_config_builder.json` |
| UI ASCII encoder `0xdbf0` | `ev_2b3aa457efbdcc11acbc9bb1a8f81f418ab8a8254819b842be8a32f39d8648e0` | `ui_dsp_link/03_hex_encoder.json` |
| UI DSP sender `0xd5d0` | `ev_f80fc1525742ea87861871531e370c311480c2d4ad015b57fdbdadd2ca74518a` | `ui_dsp_link/04_dsp_send.json` |
| UI UART5 writer `0x1b67c` | `ev_bace26a69c7d35f5d8c2b4e14a3ee3c9ab944e89a3b7829bf747d1bfa7312dd5` | `ui_dsp_link/05_uart5_tx.json` |
| UI UART3 handshake `0x10cc` | `ev_5cd04850a879f70354c9e1fafbee3b3f034231836e9b2c03bcf8c5ebd00312e0` | `session/14_uart3_irq_seeded.json` |
| DSP u16 decoder `0xcea4` | `ev_88ded55ca4d01c9c4c7f39c7416c2624cdc4cef0c612fad5177f723341d370ba` | `dsp_fields/02_u16_parser.json` |
| DSP byte decoder `0xdb76` | `ev_7843127ff9c3642a1bcafa35cb9a984fe251232187e643abc44f5b57db292c62` | `dsp_session/02_hex_decoder.json` |
| DSP dispatcher `0xc780` | `ev_10f3e18d08948d985522a7100f10712abbd9283fd955bf3d165b9ce93ed6d312` | `dsp_sweep/05_frame_dispatch.json` |
| DSP selector `0x8908` | `ev_f9d373ff2980a0433ea3e0a96c12820e1102be7b2fd0d28dd3d594caa2d32062` | `dsp_sweep/02_sweep_select.json` |
| DSP standard builder `0x5788` | `ev_7dd3ab246d0065049573e39ad538848f53ba73888afed9db1ff0a70b273e7ce8` | `dsp_sweep/03_sweep_standard.json` |
| DSP combined builder `0x53c0` | `ev_736c0a58b355d5f1c5aebde838a7ea7ef260552828540cee68e2d437dca7e415` | `dsp_sweep/04_sweep_combined.json` |

Paths in the last column after the first row are relative to `decoded/rea/`. The large menu
dossier exceeded MCP's transport budget; REA retained the complete record and supplied a
paged view. It was exported rather than re-analyzed or treated as truncated canonical JSON.

## Remaining work and boundaries

- **Answered:** working Ghidra/REA setup; complete export of the discovered R7 application
  functions; verified indirect-table coverage; menu polarity; UI→DSP builder, transport,
  byte order and config-field sources; mask-gating correction.
- **Partial:** semantic names/types, hardware register structures, remaining indirect targets,
  and unknown-byte classification. Large UI/DSP gaps include graphics, fonts, coefficient
  tables and padding; they are not automatically missing executable code. DSP `0x401c` is a
  plausible unreferenced routine requiring further provenance before adding a function seed.
- **Unresolved at this pass:** actual NVM persistence (subsequently traced below), exact GPS fix-message semantics/signedness, short
  DSP-command argument meaning, remaining filter/coefficient behavior, and external USB-to-UART
  reachability. No runtime or RF-equivalence checks have been performed.
- **Outside these exports:** LDROM bootloader bytes (not supplied) and the sibling STM32
  STUI/STDS/STGP images in the combined container. Those are separate targets, not R7 execution.

The existing functions and evidence are sufficient to continue those traces without restarting
the investigation or presenting automatic decompilation as complete semantic reconstruction.

## Verification performed

- Saved-project reexports retained the same 920/454/280 function counts, with zero decompiler
  timeouts/failures or assembly-export errors; every manifest entry has its C and assembly file.
- All 30 DSP console-table targets and all 14 UI initialized dispatch-table targets are exported.
- Actual Ghidra flash hashes match the decoded inputs; source-container SHA is unchanged.
- All 19 codec regression tests and both codec selftests pass. Literal fixtures check byte
  order, Ka polarity, checksum character validation, and mask-selection priority.
- A bounded headless timeout test stopped its owned process group and left failure provenance,
  without a success marker. A fresh UI import with the final scripts reproduced all 920 starts.


## Full browser editor follow-up

The browser workbench now uses the documented decoded layouts for all 33 DSP band
records, fixed-slot ASCII candidates, 234 bitmap/font presets, the compressed
20-by-8 scan table, and GPS LRDB records. Raw editing also exposes all section bytes,
headers and trailers, with typed patches, same-size section replacement, and file
splices. The ISD3800 directory provides 250 clip spans for raw inspection/export.

A fresh REA MCP/Ghidra session rechecked DSP routines `0x47e0` and `0x5cc0` while
connecting those controls to the existing analysis. The former contains PLL
frequency/divider arithmetic; the latter traverses 20-byte sweep records. These
are static evidence, not proof of new RF coverage or hardware acceptance:

- `0x47e0`: `ev_726c013ff3c55bf7ff2262f1d8a2662365276d83b9145195813b9476106ec1c7`.
- `0x5cc0`: `ev_1f28f47879b2e2d160d58b187d468ef6b76d7f8bc486f64e3b55e40547be1bf3`.
- Complete local records: `decoded/rea/web-editor-profile/`.

JavaScript format checks include independent Python vectors and exact round trips.
With the private stock file, all 234 bitmap presets round-trip without changing
a byte; all 13,050 GPS records survive CSV export/import at Float32 precision;
unchanged scan data preserves its compressed bytes and padding. Browser integration
checks reconstruct downloaded band, text, image, scan, GPS and code edits with the
Python tools and compare complete firmware bytes. No firmware or derived assets
are included in the website, Git repository or public CI. See
[WEB_EDITOR.md](WEB_EDITOR.md) for supported operations and remaining limits.

## R7 settings continuation — 2026-10-17

The local `R7om.pdf` owner's manual (Issue 2, November 2023) guided a continuation
through the retained UI C/assembly and decoded bytes. The complete new map, patch
sites, exact stock bytes, manual-page references, and limitations are in
[R7 settings](R7_SETTINGS.md). This work identifies additional modification targets
without claiming real-device execution or RF performance.

### Corrected default initialization and persistent storage

- **Menu reset is `0x1cf48`, not `0x1d29c`.** Reset handler `0x14c64` calls
  `0x1cf48`, serializes via `0x1e888`, and displays `Reset Completed`. The earlier
  147-store initializer `0x1d29c` instead belongs to the invalid-marker path:
  `0x1d680` → `0x1ce44` when settings word zero is not `0xffff0100`.
- The paths differ: theme `config+0xb7` is 5 (Red) on menu reset, 6 (White) after
  an invalid marker. Menu case 54 and the literal color labels establish the enum;
  palette `0x9980` independently supplies RGB565 Red `0xf800` and White `0xffff`.
  Normal startup subsequently loads valid saved settings, so changing defaults
  does not force them over a user's stored preferences.
- **Actual settings persistence is a separate I2C-style path.** Reads are
  `0x1d658` → `0xeb58` → `0xeb94`; writes are `0x1d66c` → `0xed04`.
  Framing `0xe87c` and ACK sampling `0x848` operate GPIO aliases
  `0x40004800`/`0x40004804`, send seven-bit slave address `0x50`, and use an
  eight-bit memory address. This supports serial EEPROM-style storage, without
  identifying a physical memory part or its capacity. It is not the DSP UART path.

### Auto-mute settings, timers, and output

`config+0xc1` is Auto Mute signal level (0 Off, 1–8), and `config+0xca` is Auto
Mute volume (0–7). Renderer labels, actual TBB entries in incrementers `0x11a30`
and `0x11b24`, and the runtime consumer corroborate these meanings. Both reset
paths default to level 8 and volume 2. Each has a dedicated immediate-store site,
so independent guarded edits are possible without altering shared-register groups.

Routine `0x16914` maintains `{u16 duration, u16 absence, u8 active}` at
`0x20000188`. When the configured level is enabled and the signal does not exceed
it, an alert engages auto-mute after 3000 elapsed units; absence clears it after
10000. There are three coupled engagement-delay instruction sites and four
runtime reset-gap sites. Consumer `0x196dc` uses the same active flag to select
the mute volume only when it is below the master volume. This resolves why the
older manual's configurable-volume description on p. 30 is more accurate than
its fixed-level-1 sentence on p. 19.

Clock setup `0x17a84`, Timer0 initialization `0x1b2a0`, and IRQ32 `0xc84` establish
nominal millisecond units: a 22.1184 MHz HIRC source, compare 2212, and division by
ten in the IRQ. The calculation is approximately 1.00007 ms per unit, consistent
with the manual's 3-/10-second descriptions, not a measurement of hardware timing.
The matched constants and addresses use Nuvoton's
[NUC472/442 clock header](https://github.com/OpenNuvoton/NUC472_442BSP/blob/master/Library/StdDriver/inc/clk.h)
and [register definitions](https://github.com/OpenNuvoton/NUC472_442BSP/blob/master/Library/Device/Nuvoton/NUC472_442/Include/NUC472_442.h).
This is a NUC472/442-compatible register model, not exact SKU identification; the
previous map's M480/EBI label for `0x40050000` was incorrect.

Remaining work includes complete band/arbitration exceptions, different-signal
resets, physical settings-memory identification, and hardware validation. These
findings do not establish additional RF sensitivity, new radar bands, live
mark/lockout editing, or the ability to flash edited images safely.
