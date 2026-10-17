# R7 settings, persistent storage, and auto-mute

This analysis applies to `R7_v153.150.127_db260702.bin`, with decoded `ui_nu`
SHA-256 `16a8c58e25766909faaa114beb22d87e2dd5108c3a176a2587fccb901218d79f`.
Addresses below are decoded UI offsets, also the MCU's flash addresses. Findings
combine retained Ghidra C/assembly with original instruction and literal bytes.
The findings combine static observations and the bounded emulation described below;
no detector was connected or flashed.

The local [R7 owner's manual](../R7om.pdf), Issue 2, November 2023, supplies user
behavior and terminology. Page numbers below are both printed and PDF page numbers.
The manual predates this firmware, so it cannot establish newer setting semantics.

## Guarded command-line editor

`tools/r7_settings.py` exposes four settings:

| Name | Accepted values | Effect |
|---|---|---|
| `auto_mute_delay_ms` | 100–30000 | Changes the runtime engagement comparison and its two clamp values. |
| `default_theme` | 0–7 | Changes the display-color default in both initialization paths. |
| `default_mute_volume` | 0–7 | Changes the reduced-volume default in both paths. |
| `default_mute_level` | 0–8 | Changes the auto-mute signal-level default in both paths; 0 disables it. |

The 100–30000 nominal-millisecond delay bounds are **editor policy**, not a vendor
menu range. The stock reset gap remains 10000; the tool does not expose its research
sites as an editable setting.

```sh
python3 tools/r7_settings.py inspect R7_v153.150.127_db260702.bin

python3 tools/r7_settings.py plan R7_v153.150.127_db260702.bin \
  --set auto_mute_delay_ms=5000 --set default_theme=0 \
  --set default_mute_volume=1 --set default_mute_level=6

python3 tools/r7_settings.py apply R7_v153.150.127_db260702.bin \
  --set auto_mute_delay_ms=5000 --set default_theme=0 \
  --set default_mute_volume=1 --set default_mute_level=6 \
  --output decoded/r7-custom-settings.bin
```

`inspect` and `plan` write no firmware. `apply` creates a new file and refuses an
existing output or symlink. JSON output records input/output hashes and exact
instruction changes. It validates all nine known sites, restores only those sites
to their stock bytes in a temporary buffer, and requires the resulting complete UI
SHA-256 to match the reference. The R7 model, UI version 153, declared UI length
194776, and padded length 195072 are also required. It accepts its own consistent profiles, including
the stock unequal Red/White defaults, and rejects other UI edits or partially changed
coupled groups. There is no force bypass. Bytes outside the UI payload are preserved
exactly; this does not certify the contents of independently modified other sections.

Existing saved settings override default edits until the relevant initializer runs.
The runtime delay edit applies when this firmware executes, subject to the current
auto-mute enable/level state. The tool neither flashes a detector nor proves hardware
acceptance of the output.

### Reproduce the offline validation

The editor uses Python's standard library. The optional execution harness requires
Unicorn (tested with 2.1.4) and your private firmware file:

```sh
python3 tools/r7_validate_settings.py R7_v153.150.127_db260702.bin
python3 tools/r7_validate_settings.py decoded/r7-custom-settings.bin \
  --reference R7_v153.150.127_db260702.bin \
  --report decoded/settings-validation.json
R7_FIRMWARE=R7_v153.150.127_db260702.bin python3 -m unittest discover -s tests -v
```

The harness executes actual Thumb instructions for both initializers and compares
all unrelated SRAM writes and final bytes against the reference, with external calls
`0x103ec`, `0x18010`, and `0x9980` replaced by declared no-op stubs. It executes
the isolated auto-mute block `0x16a8e`–`0x16b3c`, with the enclosing routine's timer
input supplied explicitly. It also runs volume selector `0x196dc`, recording calls
to the audio helper instead of producing audio.

The stock image passed **16 initializer comparisons, 39 mute-state transitions,
and 134 volume-routing cases**. A profile with delay 5000, theme 0, volume 1, and
level 6 passed **16 / 52 / 134** against stock. The differing transition count
includes the profile's additional delay alongside the three boundary/default cases.
The profile changes 15 decoded UI bytes (22 encoded container bytes), with every
byte outside UI unchanged. Reports are retained locally at
`decoded/r7-settings-stock-validation.json`, `decoded/r7-settings-patched-validation.json`,
and `decoded/r7-settings-patch-report.json`; the test profile is an ignored local
artifact, not a recommended configuration.

These checks cover instruction behavior and output integrity. They do not execute
full boot, storage peripherals, alert classification/Laser exclusion, the audio
driver, or a real firmware update. The harness reports these boundaries explicitly.

## Two default paths, not one

The earlier description of `0x1d29c` as the factory-reset initializer was incomplete.
There are two similar routines with different values:

| Path | Call chain | Observed behavior |
|---|---|---|
| Menu Factory Reset | `0x14c64` → `0x1cf48` → `0x1e888` | Applies reset settings, serializes them, then displays `Reset Completed` through `0x1fc4`. |
| Missing/invalid settings marker | `0x1d680` → `0x1ce44` → `0x1d29c` → `0x1e888` | Used when the word read at settings offset zero is not `0xffff0100`; `0x1ce44` then writes that marker. |
| Normal startup | `0x17b54` → `0x4da0` → `0x1cf48`, later `0x1d680` | Initializes RAM first, then restores valid saved settings. A defaults patch does not override existing saved values. |

For example, menu reset selects theme **5 (Red)**, while invalid-marker initialization
selects **6 (White)**. The manual lists Red as the factory display color on p. 18,
consistent with the menu-reset path. The routines also differ in X-band state and
left-display defaults; do not assume they are interchangeable. A patch intended to
change both initialization paths must identify and guard both sites.

The settings structure at `0x200008ec` is RAM, not an editable defaults table in the
firmware. Its fields are restored from a compact persistent representation. Firmware
default edits apply when their initializer executes; they do not edit a connected
device's saved preferences or GPS marks.

## Confirmed settings and instruction sites

Each site below is an independent `movs r0,#imm8`; the next listed store identifies
its destination. Unlike many other stores in these routines, changing one of these
immediates does not change a later group of settings that shares the same register.

| Setting | RAM field | Range / encoding | Menu-reset site / stock bytes | Invalid-marker site / stock bytes |
|---|---|---|---|---|
| Display color | config `+0xb7` | 0 Blue, 1 Amber, 2 Green, 3 Pink, 4 Gray, 5 Red, 6 White, 7 Violet | `0x1d05e`: `05 20`; store `0x1d060` | `0x1d458`: `06 20`; store `0x1d45a` |
| Auto Mute volume | config `+0xca` | 0–7; effective volume is capped by the current master volume | `0x1d0a6`: `02 20`; store `0x1d0aa` | `0x1d488`: `02 20`; store `0x1d48c` |
| Auto Mute signal level | config `+0xc1` | 0 Off; 1–8 enable auto-mute when current signal level is at or below this value | `0x1d21a`: `08 20`; store `0x1d21c` | `0x1d608`: `08 20`; store `0x1d60a` |

Color mapping comes from menu case 54 at `0x1462c` and label helpers
`0xad4c`–`0xae0c`. The palette routine `0x9980` independently gives Red the bright
RGB565 value `0xf800` and White `0xffff`. Menu incrementers `0x11a30` and `0x11b24`
wrap level 8 and volume 7 to zero: the actual TBB entries at `0x11a40` and `0x11b34`
were checked, rather than relying on incomplete jump-table pseudocode.

The manual's volume range and default 2 are on pp. 19 and 30. Its p. 19 sentence
about reducing to fixed level 1 conflicts with the configurable volume and master
volume cap described on p. 30; the firmware consumer establishes the latter behavior.
The newer **Auto Mute Lv** label is established by renderer `0xa904`, menu case 81,
and the runtime comparison below, not by assuming it appears in that older manual.

For editing, require the supported decoded-image identity and expected instruction
bytes, preserve each destination register and instruction width, and reject out-of-range
values. Merely matching a version trailer is insufficient. Shared-immediate stores
elsewhere in the initializer should not be exposed as independent settings.

## Auto-mute state machine and timing

UI `0x16914` uses a five-byte state at `0x20000188`:

| Offset | Type | Role |
|---|---|---|
| `+0` | u16 | Accumulated qualifying-alert duration |
| `+2` | u16 | Accumulated absence duration after auto-mute engages |
| `+4` | u8 | Auto-mute active flag |

The routine disables and resets this state if config `+0xc1` is zero or less than
the current signal-level byte at `0x2000003c`. Otherwise, while the alert-active byte
at `0x20000035` is nonzero, it accumulates duration and sets the flag at **3000 timer
units**. Continuing alerts set the absence timer to zero. Once the alert is absent,
an active auto-mute state clears at **10000 timer units**. This is a state-machine
description, not a complete model of every band/arbitration path.

The output consumer `0x196dc` reads the same `0x20000188+4` flag. When there is no
temporary volume override and the mute volume is below the master volume, it passes
config `+0xca` to `0x19660`; otherwise it passes the master volume. Thus changing the
level threshold and changing the reduced volume have distinct effects.

All coupled sites for the two runtime constants are:

| Parameter | Address | Stock bytes | Instruction / role |
|---|---|---|---|
| Engagement delay | `0x16af2` | `40 f6 b8 30` | `movw r0,3000`, clamp when already active |
| Engagement delay | `0x16b14` | `40 f6 b8 31` | `movw r1,3000`, threshold comparison |
| Engagement delay | `0x16b22` | `40 f6 b8 30` | `movw r0,3000`, clamp on activation |
| Reset gap | `0x16ac4` | `42 f2 10 71` | `movw r1,10000`, absence threshold comparison |
| Reset gap | `0x16ad4` | `42 f2 10 70` | `movw r0,10000`, reset after expiry |
| Reset gap | `0x16ae2` | `42 f2 10 70` | `movw r0,10000`, inactive-state reset |
| Reset gap | `0x16b36` | `42 f2 10 70` | `movw r0,10000`, disabled/strong-signal reset |

The comparisons use the loaded constant directly (`blt` skips the transition), so
the threshold instruction must change with its associated clamp instructions.
Counters are u16; arbitrary large or zero values are not established safe behavior.
Other initialization paths also set an inactive state's absence counter to 10000;
that inactive value does not itself govern the active-state expiration comparison.

### Why timer units are approximately milliseconds

The clock argument `0x5e800002` at literal `0x17b44` matches `TMR0_MODULE` in
[Nuvoton's NUC472/442 clock header](https://github.com/OpenNuvoton/NUC472_442BSP/blob/master/Library/StdDriver/inc/clk.h).
Clock setup `0x17a84` passes this module and `0x700` to `0x5e8`, selecting the
22.1184 MHz HIRC source. Timer initialization `0x1b2a0` writes compare **2212** and
control `0x68010000` (periodic, enabled, prescaler zero) at `0x40050000`.
These addresses and fields match the
[NUC472/442 register header](https://github.com/OpenNuvoton/NUC472_442BSP/blob/master/Library/Device/Nuvoton/NUC472_442/Include/NUC472_442.h),
which places Timer0 here and EBI at `0x40010000`.

IRQ32 `0xc84` increments `0x20000514+6` once per ten interrupts. `0x16914` snapshots
that counter into `+8`, clears `+6`, and adds the snapshot to its durations. The
nominal elapsed unit is consequently `10 × 2212 / 22,118,400` seconds, approximately
1.00007 ms. This supports interpreting 3000 and 10000 as nominal 3 and 10 seconds,
matching the manual's pp. 19 and 30. It does not measure oscillator accuracy,
interrupt latency, or real-device timing. Describe edits as nominal milliseconds or
timer units, not calibrated elapsed time.

This establishes a **NUC472/442-compatible register model**, not the exact processor
SKU. Earlier M480/EBI attribution for `0x40050000` was incorrect.

## Persistent settings use a separate serial-memory path

The actual settings read/write chain is distinct from the DSP configuration sender:

| Purpose | Functions | Evidence |
|---|---|---|
| Restore settings | `0x1d680` → `0x1d658` → `0xeb58` → `0xeb94` | Reads a marker and packed words, unpacks fields into config RAM; the byte reader wraps its address at 8 bits. |
| Serialize settings | `0x1e888` and helpers `0x1e708`, `0x1e23c`–`0x1e654` | Packs settings into words; compares a RAM shadow before writing changed values. |
| Write a word | `0x1d66c` → `0xed04` | Sends four bytes to the requested low-eight-bit address. |
| Bus framing | `0xe87c`, `0x848` | START, fixed address bits `1010000` followed by R/W, and an active-low ACK sample. |

GPIO aliases `0x40004800` (clock) and `0x40004804` (data) carry this bit-banged
I2C-style exchange. The observed seven-bit slave address is `0x50`, with a one-byte
memory address, random-read sequence, and write delay. This is consistent with
serial EEPROM-style settings storage; it does not identify the chip, its physical
capacity, or every other use of the bus. Reading errors yield `0xff` bytes, and a
failed marker can therefore enter the same initialization path as uninitialized
storage. No attached-device read/write operation was performed.

Examples of the compact representation, derived from matching encoder and decoder:

- Word offset `0x08`, bits 26–28: display color (`config+0xb7`).
- Word offset `0x0c`, bits 24–26: auto-mute volume (`config+0xca`).
- Word offset `0x20`, bits 9–12: auto-mute signal level (`config+0xc1`).

These are external settings-memory offsets, **not firmware offsets**. The RAM
shadow and validation/fallback logic must be preserved in any future settings-dump
tool. GPS user marks and mute-memory locations are separate external-flash data on
the SUB processor; this trace does not make those records editable in a firmware file.

## Evidence and remaining work

Retained function-level evidence is under
`decoded/ghidra-complete/export/ui_nu/functions/`, with filenames such as
`00016914_FUN_00016914.c` and `.asm`. The menu dossier is additionally retained in
`decoded/rea/session/08_menu_pseudocode.json`; byte checks resolved the relevant
indirect branches. No original proprietary source code is claimed or reproduced here.

Fresh REA evidence is retained in `decoded/rea/r7-settings-evidence.json`:

- `ev_4695a1965632617732a477f71d9666da8ac8d7722c9d3021d6a3750aee211e5c`
  re-decompiles the timer, volume consumer, reset chain, settings wrappers, and clock/IRQ routines.
- `ev_a8229be5206e01841699511b3e371d05f727cf5b9ac9175c31b9d0071130f0cd`
  analyzes initializer `0x1d29c`.
- `ev_fd0f5fd4ccd14dd64efbf600355093d306821592add3f7fa6b7189a9217bfb90`
  covers serial-memory helpers, the settings reader, theme palette, and mute labels.
- `ev_f93167cb9e6dc86bc271525ab85cd0e997c87e08bf15f9b50092549ddf1a7be9`
  retains twelve re-decompiled routines with descriptive analyst-assigned names.

These names are analysis metadata, not recovered original symbols. The evidence
bundle retains their C-like output; the existing full Ghidra project exports remain
separate. Proprietary firmware and decompilation artifacts remain ignored by Git.

Next useful traces include the entire alert-arbitration path for band exceptions and
different-signal resets, the Quiet Ride branch in `0x16914` and helper `0x16790`, and
the GPS mark/lockout storage policy. Quiet Ride's threshold is `config+0xd6`, with
unit flag `+0xc0` and an upper-range packing flag `+0x111`; `0x12f28` confirms
5-mph/10-km/h steps. The manual pp. 20 and 30–31 distinguishes Quiet Ride's
below-threshold muting from RLC Quiet Ride's above-threshold muting. Those neighboring
fields are not interchangeable, and no additional speed or RF patch is established
by the mute-delay work.
