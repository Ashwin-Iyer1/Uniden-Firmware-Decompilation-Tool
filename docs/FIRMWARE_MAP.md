# Firmware map — the master reference

A complete, region-by-region map of the Uniden R7 combined firmware image, reverse-engineered from
**`R7_v153.150.127_db260702.bin`** (5,121,719 bytes). This is the reference companion to
[FORMAT.md](FORMAT.md) (container framing) and the per-capability guides
([TEXT.md](TEXT.md), [GRAPHICS.md](GRAPHICS.md), [SCAN_ANIMATION.md](SCAN_ANIMATION.md),
[GPS_DATABASE.md](GPS_DATABASE.md)). For what you can *practically change*, see
[WHAT_YOU_CAN_CHANGE.md](WHAT_YOU_CAN_CHANGE.md).

> **All offsets are for `R7_v153.150.127`.** On another version the *contents* are the same but the
> offsets move — find them yourself (`strings`, the tools' `parse`, or the blitter/table scans
> described in [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md)).

### Offset conventions used below

- **File offset** — a byte position in the raw `.bin`.
- **Decoded / internal offset** — a position *inside* a section after `decode_old_model(key, …)`.
  For the code sections this equals the MCU's own flash address (load base `0x0`). The tools
  (`r7_patch.py`, `r7_gfx.py`, `r7_scan.py`) take decoded-section offsets.
- **SRAM address** — a runtime RAM address (base `0x20000000`); *not* a position in the file.

---

## 0. Top-level container

| # | Section | File offset | Stored len | Key | Contents |
|---|---|---|---|---|---|
| — | header | `0x000000` | 24 B | plain | lengths + flags + SNDD sound descriptor |
| 1 | **ui_nu** (DRSWMAI) | `0x000018` | 195072 | 182 | Main MCU — UI, menus, display, graphics, fonts, strings |
| 2 | **dsp_nu** (DRSWDSP) | `0x02fa21` | 114688 | 184 | DSP MCU — RF sweep, band logic, serial console |
| 3 | **gps_nu** (DRSWSUB) | `0x04ba2a` | 40960 | 183 | Sub/GPS MCU |
| 4 | sound_dbnu (DRSWSDB) | `0x055a33` | ~2 MB | 255 | voice / alert audio (internal format not cracked) |
| 5 | **GPSD:LRDB** | `0x255a46` | ~204 KB | 210 | camera / POI database |
| 6 | STUI / STDS / STGP / STSD | `0x288a65`+ | — | 182/184/183/255 | parallel STM32 image set (not run by the R7) |
| — | NMGF footer | `0x4e26a4` | 12 B | plain | merge marker; file ends at NMGF+12 |

The payload transform (2-bit-plane transpose per 4-byte group + subtract per-section key) and the
key table are documented in [FORMAT.md](FORMAT.md) §1. All sections round-trip byte-exact
(`encode(decode(x)) == x`).

### 0.1 Fixed 24-byte header  ·  confidence: high

| Offset | Size | Field | Value on v153 |
|---|---|---|---|
| `0x00` | u32 | ui_nu logical length in **low 24 bits**; **byte 3** = flags | low24 = `0x2f8d8` (194776) |
| `0x03` | 1 bit | flags byte, **bit0 = has_sound**; bits 1–7 reserved (=0) | `0x01` |
| `0x04` | u32 | dsp_nu logical length | `0x1bfe0` |
| `0x08` | u32 | gps_nu logical length | `0x9eac` |
| `0x0c` | 12 B | **SNDD** record: `['SNDD'][u32 0x0c][u32 sound_total_len]` | `0x0c`, `0x200000` |

The three length words are **logical** (pre-rounding) lengths. Stored payload length is
`alter_length(n) = ((n // 512) + 1) * 512`; the rounding gap is filled with **encoded-`0xFF`**
(erased-flash fill). Verified: ui_nu real content ends at internal `0x2f8d8`, the pad runs from file
`0x2f8f0` to the trailer at `0x2fa18` with zero gap.

### 0.2 Section trailers  ·  confidence: high

Each code/image section ends in a **9-byte trailer**: `u16 (model<<10 | version)` + 7-byte
`"DRSWxxx"` ASCII terminator. `version = u16 & 0x3FF`, `model = u16 >> 10` (R7 = 7).

| Section | Trailer file offset | u16 | model/ver | Term |
|---|---|---|---|---|
| ui_nu | `0x2fa18` | `0x1c99` | 7 / 153 | `DRSWMAI` |
| dsp_nu | `0x4ba21` | — / 150 | 7 / 150 | `DRSWDSP` |
| gps_nu | `0x55a2a` | — / 127 | 7 / 127 | `DRSWSUB` |
| STUI | `0x2b9a65` | `0x1c99` | 7 / 153 | `DRSWSTU` |
| STDS | `0x2d7a7a` | `0x1c96` | 7 / 150 | `DRSWSTD` |
| STGP | `0x2e268f` | `0x1c7f` | 7 / 127 | `DRSWSTG` |

Sound-type sections (`sound_dbnu`, `STSD`, both key 255) get **only** a 7-byte terminator, no u16.

> **Disagreement worth noting.** The container-framing analysis reads the ST* trailers as
> **model 7 (R7)** with the *same* version triplet as ui/dsp/gps, suggesting "ST" is a parallel R7
> image set rather than another model — contradicting the older FORMAT.md note that calls them
> "R8/R4". The image-content analysis independently finds the ST* code is linked at STM32 flash base
> `0x08000000` (not `0x0`) and STGP uses a hardware FPU, i.e. **different silicon** from the R7's own
> Nuvoton MCUs. Both agree the ST* set is **not executed by an R7** and must never be flashed to one.
> The trailer-model bytes are certain; their *interpretation* is medium-confidence. See §7.

### 0.3 Tag-record convention  ·  confidence: high

Tagged sections share a 12-byte head `[4B tag][u32 0x0c hdr-size][u32 clen]`, with three body
conventions:

| Convention | Sections | Body | Trailer |
|---|---|---|---|
| GPSD/GASD | `GPSD:LRDB` | `clen-12`, no 512 rounding | 12-byte footer + 7-byte term |
| STUI/STDS/STGP | ST* code | `alter_length(clen)` | 9-byte trailer |
| STSD/SUSD | ST* sound | `clen-12` | 7-byte term (key 255) |

Confirmed `clen`: GPSD `0x3300c`, STUI `0x30fe8`, STDS `0x1dfa4`, STGP `0xab24`, STSD `0x200000`.

### 0.4 NMGF footer  ·  confidence: high

Final 12 bytes at file `0x4e26ab`: `['NMGF'][u32 0][u32 0x64=100]`. Middle `0` (vs `0x0c` on real
records) marks it as a terminator; trailing `100` = merge-container format/version, **not** a
checksum. File ends exactly at NMGF+12.

> Parser note: `r7_unpack.py parse()` never emits the NMGF row — its `while pos < len-12` loop exits
> exactly at the footer offset. It also hardcodes version 0 for ST* sections, missing their
> `model7/ver153·150·127` trailers.

### 0.5 Integrity — DEFINITIVELY ABSENT  ·  confidence: high

CRC32 / Adler32 / sum32 (LE+BE) / sum-of-bytes / xor32 were computed over **every section** (encoded
*and* decoded, full and minus-trailer) and over whole-image ranges (up to NMGF, minus last 4/8/12) —
**none** of the resulting 32-bit values appears anywhere in the 5.12 MB file, in either byte order.
The only "matches" are 16-bit CRC values landing in random data (birthday coincidence), never in a
structural slot. **There is no in-file integrity/CRC/signature over any section or the whole image.**
Any edit that preserves framing (correct length words, tag records, trailers, 512-rounding) parses
cleanly with nothing to recompute. Integrity is enforced only by the update transport; Recovery Mode
makes a bad flash recoverable (see [FLASHING.md](FLASHING.md)).

---

## 1. ui_nu — Main MCU (key 182, load base `0x0`)

Nuvoton NuMicro **Cortex-M4F** (see §8). Initial SP `0x20001ef8`, reset `0x2ac`. Decode a little
past the nominal 195072 B to capture the compressed `.data` tail (the tools do this;
`buf[0x18:0x18+0x30000]` is the working window).

### 1.1 ui_nu region overview

| Decoded offset | Size | What it is | Format |
|---|---|---|---|
| `0x0000` | `0x278` | Interrupt vector table (158 entries) | Cortex-M vectors |
| `0x02ac` | ~`0x40` | Reset / unlock / clock init | Thumb-2 |
| `0x0290` | ~`0x1c` | Real HardFault handler | Thumb-2 |
| `0x0830` | 21 ch | `"In Hard Fault Handler"` diag string | ASCII |
| `0x0488` | — | LZSS decompressor `FUN_00000488` (.data block1) | Thumb-2 |
| `0x14a0` | — | memset-to-zero copier `FUN_000014a0` (.bss block2) | Thumb-2 |
| `0x1934`–`0xc460` | ~ | Main menu / label **string table** (~165 strings) | ASCII, NUL-term |
| `0x1b1e8`–`0x1b243` | ~90 B | HardFault register-dump printf templates | ASCII |
| `0x1d29c` | 147 writes | Factory-default initializer `FUN_0x1d29c` | Thumb-2 |
| `0x1fbca`–`0x2116d` | ~`0x5a3`+ | 85 × 1-bpp label/badge/icon bitmaps | 1-bpp |
| `0x2116d`, `0x21bbd` | 2640 B ea | 2 main-screen backgrounds (176×60 2-bpp) | 2-bpp |
| `0x2260e`–`0x249ea` | — | RGB565 alert icons (laser/cam/GPS pin/arrow) | RGB565 |
| `0x2534a` + i·`0x804` | 2052 B ×9 | Signal-strength bars (114×9 RGB565) | RGB565 |
| `0x29b6e` | 30×176 B | Scan-animation tiles (11×8 RGB565) | RGB565 |
| `0x2b00e` | 880 B | Uniform-fill block (RGB565 `0x1802`) | RGB565 |
| `0x2b37e`, `0x2b704` | — | 2× 8-frame expanding-arrow animations | RGB565 |
| `0x2ba8a`–`0x2d526` | ~`0x1a9c` | **Font family** (6 fonts) | 1-bpp glyphs |
| `0x2d526` | 2640 B | Boot logo "Uniden" (176×60 2-bpp) | 2-bpp |
| `0x2f78c` | 32 B | .data/.bss copy-descriptor table | 2× 16-B records |
| `0x2f7ac` | `0x12c` B | **block1** = LZSS-compressed `.data` | custom LZSS |
| `0x2f8d8` | ~`0x128` B | `0xFF` padding (recompression headroom) | fill |

### 1.2 Boot chain  ·  confidence: high

`reset FUN_0x2ac` (watchdog/POR unlock: `0x40000100 <= 0x59/0x16/0x88`, `0x40000024 <= 0x5aa5`;
window-watchdog key `0x4000c018 <= 0x5aa5`) → `blx FUN_0xc70` (clock enable, OR `0xf00000`; enables
FPU via `CPACR |= 0xF00000`) → C-runtime `FUN_0x278` (sets SP `0x20001ef8`, calls data-init
`FUN_0x3d4`) → app main `FUN_0x11114` (init `FUN_0x17b54/1b600/0e214/0d994/0d31c`, then poll loop at
`0x1112a`).

### 1.3 `.data` / `.bss` copy-descriptor table @ `0x2f78c`  ·  confidence: high

Two 16-byte records `{src, dst, len, func}` walked by `FUN_0x3d4` at boot:

| # | src (flash) | dst (SRAM) | len | func | Meaning |
|---|---|---|---|---|---|
| block1 | `0x2f7ac` | `0x20000000` | `0x514` | `0x488` | **real initialized `.data`** — LZSS-decompress |
| block2 | `0x2f8d8` | `0x20000514` | `0x19e4` | `0x14a0` | **`.bss` zero-init** — memset-to-zero |

> **Correction to earlier notes:** only block1 is compressed `.data`. block2's copier `FUN_0x14a0`
> disassembles to a plain memset-to-zero (`movs r0,#0; stm r1!,{r0}; subs r2,#4; bne`) — its `src`
> field `0x2f8d8` is **ignored**. So block2 is RAM cleared at boot, **not** stored data.
> `.data(0x514) + .bss(0x19e4)` ends at `0x20001ef8` = the ui_nu initial SP, exactly.

block1's compressed stream is only `0x12c` bytes (`0x2f7ac`..`0x2f8d8`), inflating to `0x514`.
`~0x128` bytes of `0xFF` pad follow before the next content, so a re-compressed stream may grow to
`~0x250` B. The copy-table decompressed-length field `0x514` **must stay fixed**.

### 1.4 Decompressed `.data` (block1) table map  ·  confidence: high

Contents of the `0x514`-byte image at SRAM `0x20000000` (offsets are block1-relative = SRAM
address):

| SRAM addr | Size | What it is | Editable as |
|---|---|---|---|
| `0x200000dc` | 9×4 B | **Dispatch table A** — Thumb fn-pointers (handlers ~`0x1f000`); refs `0x17c08/0x1f1e4/0x1f222` | code-patch |
| `0x20000118` | 5×4 B | **Dispatch table B** — Thumb fn-pointers (handlers ~`0x19000`); refs `0x19158/78/…` | code-patch |
| `0x200001f8` | 40×4 B | **Scan-tile pointer LUT** — `LUT[colorset*5 + state]` → tiles at `0x29b6e + n·0xb0` | code-patch (repoint) |
| `0x20000298` | 160 B | **Scanner framedata[20][8]** — per-cell brightness 0–4 | data-edit |
| `0x200004ec` | ~`0x28` B | Clock/UART constants: `0x1518000`=22.1184 MHz, `0xb71b00`=12 MHz, `0x8000`=32768, `0x2710`=10000, `22` | code-patch |
| `0x20000178` | 4 B | Hot state global (205 refs) | code-patch |
| `0x200001a4` | 4 B | Hot state global — glyph color source (246 refs) | code-patch |
| `0x20000030` | 4 B | Hot state global (35 refs) | code-patch |
| `0x2000003c`–`0x51` | bytes | Byte flags/counters (some =10) | code-patch |
| `0x20000130`–`0x174` | ~`0x44` B | `0xFFFF`-fill / padding | — |

> The **scan-tile LUT has 40 entries = 8 color-themes × 5 brightness states**, indexed
> `LUT[colorset*5 + framedata_state]` where `colorset` (0 or 5) is chosen from the color theme via a
> `tbb` jump at `0x58f2`. This corrects the older "6 themes × 5 = 30" note (the *tiles* number 30
> because rows reuse/alias physical tiles). Framedata is a bouncing "Knight-Rider" wave: head=4 with
> a 3-2-1 trailing gradient sweeping right frames 0–10, left frames 11–19.

### 1.5 Config / settings struct — SRAM `0x200008ec`  ·  confidence: high

The most-referenced global (219 base loads, 1333 field accesses). It lives in `.bss`
(zero-init at boot, then populated at runtime), so **it has no default values stored in the firmware
image** — it is loaded from external EEPROM/NVM and initialized by factory-init code. Size ≥ `0x608`
bytes; **202 distinct field offsets** were enumerated. Field offsets below are relative to base
`0x200008ec`.

| Field off | Type | Meaning | Default | Confidence |
|---|---|---|---|---|
| `+0x00`..`+0x0f` | 15× u8 | Enable flags | mostly 1 | high |
| `+0x10` | u8 | (init) | 7 | high |
| `+0x1c` | 8×20 B array | Per-record `{u8=2, u16, u16, u8=1, u8=7, u8=0}` | see fmt | high |
| `+0xb0`..`+0x11e` | bytes | Dense user-toggle bytes | — | high |
| `+0xb7` | u8 | **Color theme** (range 0–7, 8 themes) | 6 | high |
| `+0xc9` | u8 | Display mode / state flag | 1 | high |
| `+0xcb`, `+0xdb` | u8 | flags | 1 | med |
| `+0xd1` | u8 | **Main-display mode** (0/1/2) | — | high |
| `+0xdd`/`+0xde`/`+0xdf` | u8 | Numeric group (handler `0xa38c`) | 7 | high |
| `+0xe0`..`+0xe8` | u8 | Band-enable group (handler `0xb340`) | — | high |
| `+0x112`/`+0x113`/`+0x114` | u8 | numeric | 8 | high |
| `+0x1e0` | 19 B | Write-heavy buffer (literal `0x20000acc`) | — | med |
| `+0x214` | u16,u16,u32×6 | Grouped fields (literal `0x20000b00`) | — | med |
| `+0x5a0`/`+0x5ec` | — | Grouped fields (literals `0x20000e8c/0xee0`) | — | med |

- **Field[0]** (base byte) = active settings-screen id, keyed by the menu dispatcher (§1.6).
- Defaults are set at runtime by **factory-init `FUN_0x1d29c`** as immediate stores (`movs #imm;
  strb/strh`), **not** from a `.data` table. 147 concrete defaults were extracted (theme `+0xb7`=6,
  `+0x112/113/114`=8, `+0xdd/de/df`=7, the 8×20 array default `{2,_,_,1,7,0}`, most `+0x00..0x0c`
  flags=1). To change power-on/factory-reset defaults, patch these immediates (code-patch).
- Renderer `FUN_0x58dc` reads `[base+0xb7]` (color theme, `cmp #8`) and `[base+0xd1]` (display mode),
  confirming the base and those two field roles.

### 1.6 Settings-menu dispatcher `FUN_0x13e3c`  ·  confidence: high

A **137-case (`0x89`) Thumb jump table** at `0x13e54`, keyed on `config[0]` (byte at
`0x200008ec`). `target = 0x13e54 + u32(0x13e54 + idx*4)`; `idx >= 0x89` → default `0x14624`. Each case
reads/writes one config byte at a fixed offset and calls a per-screen render helper. Handlers span
`0x14078`..`0x14ae2`. Extracted case → config-byte map (selection):

| Case(s) | Config off | Helper | Setting |
|---|---|---|---|
| c0 | `[0x117]` | `0xbb54` | — |
| c2–4 | `[0xdd/de/df]` | `0xa38c` | numeric |
| c6–9 | `[0x112–0x114]` | `0xbdc8/0xbe58` | numeric |
| c10,11,13,16,18–23 | `[0x01/03/04/05/06..0x0b]` | — | on/off toggles |
| c24 | `[0xcf]` | — | — |
| c30–37 | `[0xb7]` | `0xb0b4` | **color theme** (8 options) |
| c38 | `[0xb5]`+`[0x115]` | — | — |
| c40–48 | `[0xe0–0xe8]` | `0xb340` | **band group** |
| c50–52 | `[0xf4–0xf6]` | — | — |
| c56–60 | `[0xb8–0xbb]` | `0xa51c` | grouped toggles |
| c62–66 | `[0xbc–0xbf]` | `0xaa50` | grouped toggles |
| c68 | `[0xd5]` | — | — |
| c69 | `[0xd2/d3]` | `~0x19xx` | — |
| c72–80 | `[0xeb–0xf2]` | `0xc0a4` | — |
| c102–133 | — (no cfg byte) | `0xb6d8` | 32 list-item screens (scrollable list) |
| c136 | — | `0xd994/0xd330` | **save to NVM** |

### 1.7 Display-mode dispatch `config[0xd1]`  ·  confidence: high

At `0x8f32` inside the display-refresh routine: `config[0xd1]` is a 3-way selector — `0` →
`FUN_0x8a0c` (full signal/mode draw), `1` → `FUN_0x91ac` (clears a box via fill-rect), `2` → inline
`0x8f42` (1-bpp blit `FUN_0x5690`). `config[0xc9]`/`[0xd5]` modify layout. Voice labels `Scan
Display` @`0x2354`, `Time Display` @`0x2338` correspond to the modes. The **scan tile animation**
(`FUN_0x9268` → `FUN_0x58dc`, callers `0x18042`/`0x1c07a`) is a **separate context**, not one of
the `0xd1` modes.

### 1.8 Settings NVM load/save  ·  confidence: medium

`config` is loaded from external EEPROM in **8 blocks** by `FUN_0xd31c` → `FUN_0xd330`
(validate/retry `FUN_0xd468`/`FUN_0xd61c`, `status==4` → error `FUN_0xe4bc`, timeouts `0xbb8`/`0x1388`).
Menu case 136 triggers save (`FUN_0xd994`). **No factory-default table exists in the ui_nu image** —
defaults come from EEPROM/`FUN_0x1d29c`.

### 1.9 Font family @ `0x2ba8a`–`0x2d526`  ·  confidence: high

Six 1-bpp fonts, each with its own draw routine (hardcoded height/stride/first-char) and, except the
big-digit font, a leading per-glyph advance-width byte. Font-select pointer table @ `0x6c60` =
`[0x2c024, 0x2bd92, 0x2bcba, 0x2d379, 0x2be8e]`.

| Font | Offset | Glyphs | Rec stride | Chars | Draw fn | Notes |
|---|---|---|---|---|---|---|
| Main 16×24 proportional | `0x2c024` | 101 | 49 B (1 width + 24×2) | `0x20`–`0x84` | `0x68a8`/`0x6924` | width-lookup `FUN_0x6c74` (stride 49) |
| 16×16 digit | `0x2d379` | 13 | 33 B (1 width + 16×2) | `0x2d`–`0x39` | `0x67bc` | ends at boot logo `0x2d526` |
| 16×14 mid digit | `0x2be8e` | 14 | 29 B (1 width + 14×2) | `0x2d`–`0x3a` | — | — |
| 16×20 big digit | `0x2ba8a` | 14 | 40 B (**no** width byte, fixed adv 12) | `0x2d`–`0x3a` | `0x6838` | not in `0x6c60` table |
| 8×13 small | `0x2bd92` | 18 | 14 B (1 width + 13×1) | `0x28`–`0x39` | `0x69f8` | — |
| 8×11 small | `0x2bcba` | 18 | 12 B (1 width + 11×1) | `0x28`–`0x39` | `0x697c` | — |

Char draw `FUN_0x68a8(x,y,char)→width` indexes `char-0x20` into the table and blits via
`FUN_0x171cc` (mode=2), glyph color from RAM state `0x200001a4`, cell height `0x18`. String-width
measure: `FUN_0x6c74` (per-glyph) / `FUN_0x6c88` (sum over a glyph buffer). Glyph *shapes* are
data-edit (length-preserving); char-range/box-size constants are hardcoded immediates in each draw
routine (code-patch).

### 1.10 Graphics-asset catalog  ·  confidence: high

267 blitter call sites (`FUN_0x5690` 1-bpp, `FUN_0x56dc` 2-bpp, `FUN_0x9d9c` RGB565) resolve to 120
distinct static `(x,y,w,h,ptr)` draws. Whole ui_nu round-trips byte-exact and no checksum guards it,
so every bitmap/glyph is an in-place data-edit (`r7_gfx.py`).

| Asset group | Offset(s) | Dims / count | Format |
|---|---|---|---|
| 1-bpp UI labels/badges | `0x1fbca`–`0x2116d` | 85 assets | 1-bpp |
| — band badges Ka/K/X/POP/MRCD/RT3/RT4 | `0x1fcfa + i·0x50` | 7 × 32×20 | 1-bpp |
| Main-screen backgrounds | `0x2116d`, `0x21bbd` | 2 × 176×60 | 2-bpp |
| Laser-burst icon (bright/dim) | `0x2260e`, `0x22d16` | 2 × 45×20 | RGB565 |
| Red-light cam / speed cam / GPS pin | `0x2372a`, `0x2408a`, `0x249ea` | 3 × 40×30 | RGB565 |
| Directional arrow | `0x2341e` | 30×13 | RGB565 |
| Signal-strength bars | `0x2534a + i·0x804` | 9 × 114×9 | RGB565 |
| Scan tiles | `0x29b6e` | 30 × 11×8 | RGB565 |
| Uniform-fill block | `0x2b00e` | 880 B | RGB565 |
| Expanding-arrow anim set A/B | `0x2b37e`, `0x2b704` | 2 × 8 frames (5×5→12×10) | RGB565 |
| Boot logo "Uniden" | `0x2d526` | 176×60 | 2-bpp |

**Asset / pointer tables in code** (`code-patch` — repoint only to relocate/resize): master
screen-composition tables `@0x424c` & `@0x48dc` (12 ptrs each: top label `0x20a92`, bg `0x21bbd`,
mode label `0x202bb/0x2025b`, then the nine 114×9 signal bars `0x2534a…0x2936a`) drive display modes
0/1; arrow-frame tables `@0x62bc` (14) / `@0x65c4` (8); font-select `@0x6c60`; compass-direction
labels `@0x6db0` (9) / `@0x8bd0` (8); band-badge icons `@0x76e0` / `@0x77c4` (7); plus
`@0x9570/9648/9970/9b54/0xa184/0xc6c4`.

### 1.11 String zone  ·  confidence: high

Genuine UI text lives only in flash: two diagnostic strings (`0x830`, `0x1b1e8`–`0x1b243`), the main
menu/label table `0x1934`–`0xc460` (~165 strings), a laser source-name pool `0x7578`–`0x760c`, and
`"Over Speed"` @`0x7c23`. All are latin1/ASCII, NUL-terminated, 4-byte aligned. Each is `data-edit`
in place via `r7_patch.py setstr` — see [TEXT.md](TEXT.md). Editable field = bytes to next non-null
data; **max new chars = field − 1**. `%`-format specifiers (`%2d`, `%3d`, `%4d`, `%8d`, `%x`,
`(%d)`) are load-bearing and must be preserved. Notable string groups:

- **Laser/lidar source names** `0x7578`–`0x760c`: 17 packed names (LTI 20/20, RIEGL, Laser Ally,
  Kustom, Atlanta, Stalker, Laveg, SL700, SCS-102, TraffiPat, Truspeed S, Stealth, TruCam, XLR,
  Dragon_C, Dragon_F, POLISCAN) — drives the "Laser Gun ID" readout.
- **Ka-segmentation freq boundaries** `0xb534`–`0xb5e6`: 9 GHz-range strings (33.399→35.701) + `Ka
  1`–`9` labels `0xb4e3`–`0xb524` + heading `Ka Segmentation` `0xb5f4`. **Display text only** — the
  RF tuning is DSP-side (§6).
- **Hardware-fault banners** `0xbc84`–`0xbcd4`: 5 × `Sys Err<DSP Boot/UART/SPI, Tuner, UI UART`.
- **HardFault serial diagnostics** `0x830` (`In Hard Fault Handler`) + `0x1b1e8`–`0x1b243` (register
  dump `r0 = 0x%x` … `psr = 0x%x`, fixed 10-B slots).
- Owner-name/email repurpose slots: `Alert Display #1` `0xa458`, `#2` `0xa478` (20 B each),
  `Self Test` `0x2268` (12 B) — see [TEXT.md](TEXT.md).

### 1.12 ui_nu vector table  ·  confidence: high

632 B (158 × u32) at `0x0`. `[0]` SP=`0x20001ef8`, `[1]` reset=`0x2ad`, `[2]` NMI=`0x2e7`, `[3]`
HardFault=`0x291`, default handler `0x2f9`, `[16..157]` = 142 IRQ slots. Non-default IRQs:
IRQ32→`0xc85` (Timer0), IRQ65→`0x955`, IRQ104→`0x1009`, IRQ107→`0x10cd`, IRQ108→`0x1149`,
IRQ109→`0x1251`. Boot/integrity-critical (`not-editable` in practice).

### 1.13 ui_nu → sub-MCU link, and where the band settings come from  ·  confidence: high

ui_nu speaks a **binary** framed link (same `opcode|0x80` framing idea as §2.7, but *not* ASCII-hex)
whose opcodes `0x52`/`0x5a` (wire `0xd2`/`0xda`) are matched in **gps_nu** at `0x40e0`–`0x4108` —
so this is the **ui_nu ↔ gps_nu** link, distinct from the DSP's ASCII-hex protocol.

**Builder `FUN_0xf1a0(subcmd, buf)` → 8 bytes, returns 8:**

| Byte | Contents |
|---|---|
| `0` | `0xd2` (= `0x52 \| 0x80`) |
| `1` | subcmd — `0xab` from `0x1024e` (send + await reply `0xda`, via `0x100e0`), `0xac` from `0x1027e` (fire-and-forget, via `0x1b890`) |
| `2`–`3` | u16 band bitfield (big-endian) |
| `4`–`5` | u16 Ka-segment bitmap + extra flags |
| `6` | flags: bit2 `config[0x06]`, bit1 `config[0xb5]`, bit0 `config[0xe1]` |
| `7` | XOR checksum of bytes 0-6 (`FUN_0x1117c(buf,7)`) — equivalent to §2.7's scheme, with the `opcode\|0x80` seed folded in as byte 0 |

**Where the Ka-segment bits come from** — `config[0xe0..0xe8]` (the 9-byte band group of §1.6, menu
cases c40–48), with **inverted sense**: the wire bit is set when the config byte is **zero**.

| Config | Wire bit (of the byte 4-5 u16) |
|---|---|
| `[0xe0]` | bit 8 |
| `[0xe2]` | bit 6 |
| `[0xe3]` | bit 5 |
| `[0xe4]` | bit 4 |
| `[0xe5]` | bit 3 |
| `[0xe6]` | bit 2 |
| `[0xe7]` | bit 1 |
| `[0xe8]` | bit 0 |

`[0xe1]` does **not** ride in this u16 — it is byte 6 bit 0. High bits 12/13/14 carry
`config[0xce]`, `[0xb6]`, `[0x115]`, matching the DSP mask's "bits 9-15 are not segments".

> Ordering caveat: `[0xe0]` maps to the **top** segment bit and `[0xe8]` to the bottom, i.e. reversed
> relative to offset order. Which menu label ("Ka 1" … "Ka 9") sits at which config offset is **not
> yet confirmed**, so do not assume `[0xe0]` is "Ka 1".

Byte 2-3 is built from `config[0x118]` (3-bit, bits 3-5), `[0x01]`, `[0x03]`, `[0x04]`, `[0x07]`,
`[0x08]`, `[0xcf]`, `[0xf5]`, `[0xf6]`, plus two constant-set bits (`adds r0,#0xc`).

A second, non-inverting packer at `0x1e2e0` serialises `config[0xdf]`, `[0xe5..0xea]` into a bit-packed
buffer — the NVM/EEPROM save path of §1.8, not a link message. Note it reaches `[0xe9]`/`[0xea]`, so
the band group extends past `0xe8`.

---

## 2. dsp_nu — DSP MCU (key 184, load base `0x0`)

Nuvoton Cortex-M4F. Initial SP `0x20003568`, reset `0x2a8`, 158-entry vector table (142 IRQs;
non-default IRQ104→`0x1431`, IRQ107→`0x14ed`, IRQ108→`0x1605`). This is the RF/band-filtering layer.
Splice back at container `0x2fa21`.

### 2.1 Serial debug console  ·  confidence: high

The DSP exposes a UART debug console. **Dispatch table @ `0x0dbcc`** (decoded = file offset), **30
entries**, layout `{u32 index, u32 name_ptr, u32 handler_ptr(odd=Thumb)}`, 12-byte stride, proven by
the parser at `0x2f78`–`0x2fa8` (base literal `0xdbcc`, stride ×12, `strncmp` on name@+4, loop bound
`cmp r6,#0x1e` = 30).

> **Correction to earlier notes:** the table base is **`0x0dbcc`**, not `0xdbe0`, and the field order
> is `{index, name_ptr, handler_ptr}` — the older `{name,handler,index}`/`0xdbe0` reading was
> off by one 4-byte field, mis-pairing every handler. Command name strings are at `0x1beb8`–`0x1bf3f`
> (idx0 name = empty string @`0x1bf40`).

| Cmd | Handler | Purpose |
|---|---|---|
| (idx0, "") | `0x2641` | default |
| PASSME | `0x2671` | — |
| @ | `0x2565` | — |
| V | `0x2c69` | version print (reads §2.5) |
| L16 / L64 | `0x298d` / `0x2a11` | — |
| G | `0x24e1` | — |
| A | `0x1fa5` | — |
| R | `0x276d` | — |
| PLL | `0x26bd` | program PLL synth (§2.4) |
| CHAN | `0x221d` | — |
| TU | `0x2bb9` | program tuner (§2.4) |
| BSEL | `0x2029` | **band select / mux** (§2.3) |
| TOL | `0x2149` | — |
| BW | `0x21c9` | bandwidth |
| B | `0x2b2d` | — |
| FFT | `0x22c1` | — |
| S / SS / SX | `0x2801` / `0x281d` / `0x2971` | sweep params (→ shared `0x288c`) |
| SK / SKAL / SKAH | `0x2839` / `0x2871` / `0x2855` | Ka sweep ref / low / high bounds |
| AL1 / AL2 / AL3 | `0x1edd` / `0x1eef` / `0x1f01` | — |
| D1 / D2 / D3 | `0x2319` / `0x232b` / `0x233d` | — |
| DP | `0x23e9` | — |

**Every console handler writes only SRAM/MMIO — no handler touches a flash program/erase path.** All
console tuning is **volatile** (lost at reset). Console runtime state lives at SRAM `0x20000004/8`
(band), `0x20000084` (tuner/PLL struct), `0x20000114/118` (PLL/TU cache), `0x20000944` (sweep working
buffer), `0x20000290` (parser state). Parser `FUN_0x2ea0` (fed from UART RX `0x2e7e`), arg parse
`FUN_0x408` (base-10) into scratch `0x20000338`, token compare `strncmp(name,buf,16)` `FUN_0x3c0`.

> Whether this UART console is bridged to the external CP210x port is a **hardware-routing question
> not answerable from the image** — it determines whether live band tuning is reachable without
> opening the unit.

### 2.2 Sweep-schedule (band/RF frequency) tables  ·  confidence: high

The band/sweep-frequency table is a set of **20-byte sweep-schedule records**. Nine primary flash
groups (14/16/28 records each) plus 7 special groups, selected via a pointer array.

**Record layout (20 B):**

| Off | Type | Field | Typical value |
|---|---|---|---|
| `+0x00` | u16 | mode id | `0x10`–`0x18` = Ka segments 1–9 |
| `+0x02` | u16 | enable_default | 0/1; `0xffff` sentinel, `0xfffe` mid-group |
| `+0x04` | u32 | rsvd | — |
| `+0x08` | u32 | p1 (pass/dwell) | `9000` or `10000` |
| `+0x0c` | u32 | p2 | `18000` |
| `+0x10` | u32 | **tuner_code** | e.g. `0xdeb4`–`0xdf34` (Ka) |

Groups end with a sentinel record `enable=0xffff, code=0, p1=p2=0xffffffff`.

| Group | Offset | Records |
|---|---|---|
| G1 | `0x0df44` | 14/16/28 |
| G2 | `0x0e05c` | — |
| G3 | `0x0e174` | — |
| G4 | `0x0e28c` | — |
| G5 | `0x0e3cc` | — |
| G6 | `0x0e50c` | — |
| G7 | `0x0e64c` | — (Ka segments) |
| G8 | `0x0e87c` | — (Ka segments) |
| G9 | `0x0eaac` | — (Ka segments) |
| special | `0xecdc`, `0xf024`, `0xf074`, `0xf0c4`, `0xf114`, `0xf204`, `0xf2cc` | — |

**Band/region → group pointer array @ `0x05a14`** (9 × u32):
`0x0df44, 0x0e3cc, 0x0e87c, 0x0e05c, 0x0e50c, 0x0eaac, 0x0e174, 0x0e28c, 0x0e64c`.

**Ka 9-segment codes** (mode ids `0x10`–`0x18`, in the 28-record groups G7/G8/G9):
`0xdeb4, 0xdec4, 0xded4, 0xdee4, 0xdef4, 0xdf04, 0xdf14, 0xdf24, 0xdf34` (57012…57140, step 16). The
mode id → segment mask bit is a clean `tbb` jump table (`0x552a`, and in `0x5788`).

**S/SS/SX/SK/SKAL/SKAH parameter structs** (60 B = two 20-B sub-records, up/down sweep):
SX `0x0f3a8`, SK `0x0f3e4`, SKAL `0x0f420`, SKAH `0x0f45c` (S/SS reuse group base `0x0df44`).
Distinguishing tuner codes at `+0x10`/`+0x24`: SK=`0xdd44`, **SKAL=`0xde44`**, **SKAH=`0xde54`** (the
wide, non-segmented Ka sweep bounds).

**Band-enable applier engines** (`code-patch`): `FUN_0x5788` (9-group path) and
`FUN_0x5416`/`0x5522` (28-record segment path) `memcpy` a selected group into RAM `0x20000944`
(stride `0x14`), then per record: if `0x10 <= mode <= 0x18`, `tbb`-dispatch and set
`enable[+2] = (mask & (1 << (mode-0x10)))`; other modes gated by hardcoded band-selector `if/else`.
The **runtime Ka-segment mask overrides** the flash `enable_default`. Pipeline continues via
`FUN_0x5c74` (loads sweep regs `0x20000878/8bc/900`) → `FUN_0x9f14` (start); master reconfigurator at
`0x88xx`–`0x89e6`.

### 2.3 BSEL band-mux handler `0x2029`  ·  confidence: high

Writes MMIO band-mux via RMW field-setter `FUN_0x10c6(base,mask,val)` on `0x40004000`/`0x40004080`,
plus direct stores to `0x400048a0` and `0x40004800`; caches band state to SRAM `0x20000004` (main)/
`0x20000008` (sec). `0x40004000` is Nuvoton GPIO port A. Register addresses are silicon
(`not-editable`); the RMW logic is `code-patch`.

### 2.4 Tuner & PLL programmers  ·  confidence: high

- **Tuner `FUN_0x4b58`**: `N = freq * 77672 / 1000` (64-bit `umull`/`udiv`; scale literal `0x12f68` =
  77672 at `0x4c50`), packed big-endian as 4 bytes + a 6-bit aux byte (band-conditional `+0x80`),
  written as a 5-byte I²C payload to device addr 7 via `FUN_0x516c`; init regs `0xe1→4`, `0x95→0x2b`
  via `FUN_0x53a0`. The **scale factor 77672 @`0x4c50` is a data-edit-able u32** (rescales *all*
  tuner codes globally); the packing/divide logic is code; the I²C programming targets hardware.
- **PLL `FUN_0x47e0`**: fractional-N — integer `r6 = floor(V*10/25/10000)`, fractional
  `r8 = (V*10 - r6*250000)*2/125`, packed `int<<13 | frac<<1` (masks `0xff001fff`, `0x1ffe`), written
  via `FUN_0xbb88`; the PLL handler pre-halves its arg. Divider math/bitfields are `code-patch`;
  synth is hardware.

### 2.5 dsp_nu version field  ·  confidence: high

u16 @ `0x400`: bits[0:10]=version (=150), bits[10:16]=sub (=0); printed by the `V` command. `data-edit`
(cosmetic).

### 2.6 Band coefficient table @ `0x0dd34`  ·  confidence: high / editable: data-edit

The DSP's real RF detection windows live in a **coefficient table**: **33 records × 16 bytes** at
decoded `dsp_nu` `0x0dd34`, `{u32 band_type, u32 freq_low_kHz, u32 freq_high_kHz, u32 ifconst}`.
Frequencies are stored **directly in kHz** (verified: `rec0 type=1 = X 10.499–10.551 GHz`,
`rec1 type=2 = K 24.049–24.251 GHz`). `band_type`: 1=X, 2=K, 3/6=Ka(low-mix), 4=Ka(high-mix),
7=K(alt), 8=spot/instant. The 20-byte sweep-schedule records' `+0x10` field ("tuner_code") is a
**pointer into this table**, and the PLL (`FUN_0x47e0`) is programmed straight from `freq_high` via a
25 MHz-reference fractional-N divider — **no hidden harmonic multiplier**, so these numbers *are* the
RF frequencies. **Editing `freq_low`/`freq_high` moves a band** — a clean length-preserving data-edit
(`tools/r7_bands.py`). Caveat: records are shared across modes (the X record is referenced by nearly
every group), so one edit affects every mode using it; `band_type`/`ifconst` are hardware-coupled,
leave them. Full guide: [BAND_FILTERING.md](BAND_FILTERING.md). (Older note: the K center ≈`24136` MHz
appears at `0x15ec0` too, but the authoritative editable data is this table.)

### 2.7 Serial frame protocol  ·  confidence: high

Distinct from the text console of §2.1, but **on the same UART**. Full write-up in
[DSP_PROTOCOL.md](DSP_PROTOCOL.md); codec in `tools/r7_ipc.py`.

Frame = `<opcode|0x80>` + a fixed-length payload of **uppercase ASCII-hex** characters. Bit 7 marks
a frame start and resynchronises the receiver (`0xd68c`); since hex payload is 7-bit, payload can
never be mistaken for a header. 2 chars per u8, 4 per u16, **big-endian**. Final 2 payload chars are
a checksum: `(opcode|0x80) XOR each preceding payload char` — XOR over the **ASCII characters**, seeded
with the wire byte so the opcode is covered (`0xc644`). Hex parse `0xdb76` accepts `0-9A-F` only;
lowercase yields `0xff` and rejects the frame.

**Opcode/length table @ `0xf498`** (6 × 8 B, `{u32 opcode, u32 payload_len}`):

| Opcode | Wire | Payload chars |
|---|---|---|
| `0x0f` | `0x8f` | 4 |
| **`0x10`** | **`0x90`** | **32 — radar configuration** |
| `0x11` | `0x91` | 18 |
| `0x32`/`0x33`/`0x70` | `0xb2`/`0xb3`/`0xf0` | 2 |

RX chain: ring-buffer pop `0xc41c` (head/tail @ `0x20000040`, `-1` = empty) → pump `0x2e6a`, which
feeds **every byte to both** the console parser `0x2ea0` **and** the framer `0xd68c`. The framer is
skipped only when SRAM `0x20000072 == 1` (console-only mode). Frame state at `0x20001524`:
`+0x00` state, `+0x2b` opcode, `+0x2c` expected length. Dispatch → `0xc780`.

> Consequence: **the debug console and this protocol share one physical UART.** Whether that UART
> reaches the external CP210x port is a single remaining hardware question, not two.

### 2.8 Opcode `0x10` field map — the band/segment path  ·  confidence: high

Parsed at `0xc894`–`0xcc0e` via `0xcea4` (u16, 4 chars) and `0xced8` (u8, 2 chars). Twelve fields:
`u16, u8×9, u16 band_bits, u16 ka_mask` = `4 + 18 + 4 + 4 = 30` data chars + 2 checksum = **32**,
independently reproducing the table's declared length.

- **`ka_mask` (field 12)** — bit *N* (0..8) → sweep record **mode id `0x10+N`**. The applier
  overwrites each record's flash `enable_default` with `(mask >> N) & 1` (`tbb` at `0x5522`), so the
  **runtime mask overrides the image defaults**. Bits 9-15 are not segments; bits 14/15 gate other
  sweep modes. Field 12 is **only parsed if `band_bits` bit0 or bit2 is set**.
- **`band_bits` (field 11)** — bit0+bit2 gate the Ka-segment path; bits 1/3/4/5 are sweep-builder
  args; bits 6/7 and 9|10 select special sweep groups. Bit→band-name assignment is **not resolved**.
- **Path selection**: `band_bits` bit0 **and** bit2 → `FUN_0x53c0` copies the **36-record** group from flash
  `0xecdc` into working buffer `0x20000944` and applies the mask; else `FUN_0x5788` (9-group path,
  no segment masking). Both are called from master reconfigurator `FUN_0x8908` (sole caller
  `0xcc06`), which takes 11 args — the mask is stack arg at callee `[sp,#0x44]`.

---

## 3. gps_nu — Sub/GPS MCU (key 183, load base `0x0`)

Nuvoton Cortex-M4F (smaller part — 64 IRQs, ~16 KB SRAM). Initial SP `0x20003d38`, reset `0x174`,
80-entry vector table (`0x0`–`0x140`), default handler `0x1b9`. Named IRQs: IRQ36→`0xa69` (UART0),
IRQ37→`0xb81` (UART1) — matches gps_nu's heavy UART0/UART1 use. Splice at container `0x4ba2a`.
`.data`/`.bss` init at reset; entropy ~6.0–6.6 (dense Thumb code; no large data tables).

**Role — GPS-receiver front-end + UART router**  ·  confidence: high

| Item | Offset | What it is |
|---|---|---|
| NMEA `RMC` id | `0x3a5c` | parses `$G_RMC` (position / velocity / time / date) |
| NMEA `GGA` id | `0x3bf8` | parses `$G_GGA` (fix quality, altitude, satellites) |
| `at$uart0=ui` | `0x9d60` | AT command: route UART0 to the **main MCU (UI)** |
| `at$uart0=gps` | `0x9d6c` | AT command: route UART0 to the **GPS module** |
| `HDT` | `0x9b05` | true-heading handling |

`gps_nu` reads the serial GPS module, parses NMEA sentences into a fix (lat/lon/speed/heading/time),
and **muxes UART0** between the GPS module, the main MCU, and the external port — which is how the
GPS stream and the update/debug serial share one physical line (the `at$uart0=…` commands switch it).
It is a **data provider**: it does *not* hold the camera database, the GPS auto-lockout state, or the
alert logic — those live in the **main MCU** (`ui_nu`) which consumes the fix `gps_nu` produces.

**Editability:** almost entirely **code-patch** (the NMEA parser, UART mux, and framing are Thumb
code) and **low user value** — it's GPS plumbing, not a feature surface. No large data tables to swap;
any behavior change (e.g. accepting a different GPS baud/sentence set) is an ARM-code edit. The GPS
*database* is the separate `GPSD:LRDB` section (§5), which is fully data-editable.

---

## 4. sound_dbnu — voice / alert audio (key 255)

File `0x055a33`, ~2 MB fixed slot. The **outer container encoding is trivially reversible**
(`decode_old_model(255, …)`, verified byte-exact), but the **internal voice-clip index/codec format
is not reverse-engineered** in this project. `not-editable` for authoring purposes. Presence is gated
by header flag bit0 (§0.1) and described by the SNDD record.

---

## 5. GPSD:LRDB — GPS / camera database (key 210)

File `0x255a46`, ~204 KB. Fully enumerated from all **13,050 real records**. Complete authoring guide:
[GPS_DATABASE.md](GPS_DATABASE.md).

### 5.1 Body & framing  ·  confidence: high

- **Body** at `0x255a46`, `0x33000` (208896) bytes = **13,056 slots × 16 B**, key-210
  transpose-encoded, 512-B aligned, **sorted latitude-descending** (55.1998 → 21.2942).
- **Section length u32** (plaintext) @ `0x255a42` = `208908` = body 208896 + 12.
- **Padding** = exactly 6 all-`0xFF` records (slots 13050–13055), aligning real data to 512 B.
- **Footer** @ `0x288a46`: `[4B key-210-encoded POI count → 13050][4B plaintext date u32 LE =
  20260702 YYYYMMDD]["LRDB"]["DRSWGDB"]`. **No checksum anywhere.**

### 5.2 Record schema (16 B, decoded)  ·  confidence: high (f2 = medium)

| Off | Type | Field | Meaning |
|---|---|---|---|
| `+0` | f32 LE | lat | decimal degrees (sorted descending) |
| `+4` | f32 LE | lon | decimal degrees |
| `+8` | u8 | **f0 = camera TYPE** | 1 = speed cam (7623), 2 = red-light cam (5427) |
| `+9` | u8 | **speed** | posted limit in local unit, multiple of 5; **0 for red-light** |
| `+10` | u8 | **f2 = install sub-flag** | 1 (9500) / 2 (3550); semantic not fully cracked |
| `+11` | u8 | **category = region/unit** | 1 = Canada/metric km/h (1506), 2 = USA/mph (11544) |
| `+12` | u16 LE | **heading** | approach bearing **1–360** (never 0); 360 = omni/any |
| `+14` | u16 LE | reserved | constant `0xFFFF` on all real records (terminator, **not** a checksum) |

**Cross-tabulation results (corrections to earlier docs):**

- **f0 is rigorously TYPE**: f0=2 → speed==0 for all 5427; f0=1 → speed>0 for 7620/7623 (3 anomalies).
- **speed** is the posted limit in the *local* unit (category decides km/h vs mph); storage is
  unit-agnostic.
- **category = region/unit tag**, not a generic "alert category": cat=1 ⟷ Canada/metric (speeds
  multiples of 10, incl the sole 120; lat peaks 43/45/53–55), cat=2 ⟷ USA/mph (incl Hawaii). No
  Mexico in this US `LRDB` build.
- **heading is 1–360, never 0** (docs previously said 0–360). 360 = omnidirectional; 90/180/270/360
  over-represented as coarse fallbacks.
- **Combined RLC+speed installations** = **two** records at identical coord+heading (one f0=1, one
  f0=2); 377 such exact-coordinate pairs. There is no single "combined" type value.
- **f2** (medium/low confidence — the only field not definitively cracked): binary 1/2,
  installation-level (uniform within a coordinate cluster), orthogonal to type & region, strongly
  regionally gradient (f2=2 share ~50–66% Mountain-West vs ~14% Northeast), correlates with
  omni-heading and exact-coord clustering. Leading hypothesis: fixed/single-approach (1) vs
  mobile/multi-approach/bidirectional (2). Resolving it requires disassembling the DB-alert consumer.

### 5.3 GPS-DB editable fields summary

Everything in the DB is `data-edit`; the only `not-editable` pieces are the `"LRDB"` / `"DRSWGDB"`
format tags (region-key selectors: `LRDB`=210 US, `DFDB`=194 NZ, `IRDB`=226 IL) and the reserved
`0xFFFF` terminator. Body `encode(decode) == orig` byte-exact. `r7_gpsdb.py` handles decode, edit,
re-sort, re-pad, POI-count, length field, and date automatically. The speed-display unit (km/h vs
mph) is a **runtime user setting** (`Speed Unit: km/h`/`mph`, ui_nu `0x1c74`/`0x1c94`).

---

## 6. STUI / STDS / STGP / STSD — parallel STM32 image set

A complete second firmware set (UI/DSP/GPS/voice-DB) for a **different STM32-based hardware target**,
carried inside the combined updater image. **Not executed by an R7** and must **never be flashed to
one**. `confidence: high` (except STSD medium).

### 6.1 Encoding & load base  ·  confidence: high

They use the **identical transpose+subtract transform and the SAME keys** as the R7's own MCU
sections (STUI=182, STDS=184, STGP=183, STSD=255) — the transform was never model-specific. The one
difference: they are linked at **STM32 flash base `0x08000000`** (not `0x0`). That wrong-base
assumption is why an earlier pass saw "no valid vector table." At base `0x08000000` all three code
images have valid 15/15 exception vectors and clean Thumb-2 reset handlers.

| Section | File offset | Size | Base | Vector SP / reset | Term |
|---|---|---|---|---|---|
| STUI (UI) | `0x288a65` | 200704 | `0x08000000` | `0x20002898` / `0x080081dd` | DRSWSTU |
| STDS (DSP) | `0x2b9a7a` | 122880 | `0x08000000` | `0x200036e8` / `0x080029a1` | DRSWSTD |
| STGP (GPS, **M4F**) | `0x2d7a8f` | 44032 | `0x08000000` | `0x20004d50` / `0x080029a5` | DRSWSTG |
| STSD (voice DB) | `0x2e26a4` | 2097140 | — | opaque (key 255) | (SD term) |

### 6.2 Relationship to the R7 images  ·  confidence: high

Same detector codebase (identical Ka/K/X band menus, Ka Segmentation, Gatso, MRCD/T UI strings;
identical DSP build dates Oct 29 2025 + versions 2.5.1/1.4.0; same `monSR78` tag; STDS carries the
same `SKAH/SKAL/BSEL/PLL` band console), just relinked for STM32 silicon — only 4–11% coincidental
byte overlap because pointers differ. STGP's reset handler uses VFP float ops (`vldr`/`vmul.f32`/
`vmov.f32`) → **Cortex-M4F with hardware FPU**, a different/newer silicon class than the R7's own
gps_nu. STSD is the same 2 MB slot as sound_dbnu; its internal audio format is uncracked.

> `r7_unpack.py` currently assigns `key=None` to STUI/STDS/STGP so `extract` writes them **raw**. They
> would decode with keys 182/184/183 (disassemble at base `0x08000000`; enable FPU for STGP) — but
> they are the sibling model's firmware and have **no effect on an R7**.

---

## 7. NMGF footer

See §0.4. Final 12 bytes at `0x4e26ab`: `['NMGF'][u32 0][u32 100]`. Merge-container end marker; not a
checksum. File ends at NMGF+12.

---

## 8. MCU / silicon reference (applies to ui_nu, dsp_nu, gps_nu)

All three R7 code MCUs are **Nuvoton NuMicro Cortex-M4F**, load base flash `0x0`, SRAM base
`0x20000000`, no VTOR relocation (vectors execute in place). `confidence: high`.

- **Fingerprint:** identical `SYS_UnlockReg` magic-knock in every reset handler — write
  `0x59, 0x16, 0x88` to `SYS_REGLCTL` @`0x40000100`, POR-disable key `0x5AA5` @`0x40000024`, then
  re-lock with `0`. FPU enabled via `CPACR` (`0xE000ED88`) `|= 0xF00000`.
- **Peripheral map (matches Nuvoton M480):** SYS `0x40000000`, CLK `0x40000200`, GPIO `0x40004000`
  (ports +`0x40`, bit-DOUT `0x40004800`), FMC `0x4000C000`, SDH0/1 `0x40040000/0x44000`, EBI
  `0x40050000`, CRC/Crypto `0x40058000`, SPI0-3 `0x40060000`–`0x63000`, UART0-5 `0x40070000`–`0x75000`.
  PPB: NVIC ISER `0xE000E100`, SysTick, SCB AIRCR `0xE000ED0C` (VECTKEY `0x05FA`).
- **App images do NOT self-program flash** — `FMC_ISPTRG`/`ISPCMD` are absent from all three;
  in-field reflashing is done by the Nuvoton **LDROM bootloader** consuming the container. Flash is
  bootloader-gated.
- Only HardFault has real logic; NMI/MemManage/BusFault/UsageFault/SVC/DebugMon/PendSV/SysTick and the
  default IRQ are `b .` trap stubs.
- Vector-table geometry: ui_nu & dsp_nu = 158 entries (142 IRQs); gps_nu = 80 (64 IRQs) → smaller M4F
  part. SRAM usage: ui/dsp reference `.data`/`.bss` up to ~`0x2001b900` (≥128 KB SRAM part); gps only
  to ~`0x20003d38` (~16 KB).

> Exact SKUs aren't pinned from the image (would need `SYS_PDID` @`0x40000000`, a runtime register).
> Family is M480-class for Main+DSP and a smaller M4F for GPS.

---

## Confidence & open questions

- **High confidence:** container framing, integrity-absence, ui_nu `.data`/`.bss` split, config-struct
  base & field enumeration, menu dispatcher, font family, graphics catalog, string zone, dsp console
  table & sweep-record format, GPS-DB schema (except f2), MCU family, ST* encoding/base, **the DSP
  serial frame protocol and the opcode `0x10` field map (§2.7/§2.8), and the ui_nu→gps_nu link
  message that carries the band settings (§1.13)**.
- **Medium / unknown:** GPS-DB `f2` semantic; dsp_nu K-band coefficient block structure; which
  marketing band name each `band_bits` bit denotes; which menu label ("Ka 1"…"Ka 9") sits at each
  `config[0xe0..0xe8]` offset; how the sub-MCU re-frames the band settings on to the DSP (gps_nu has
  no ASCII-hex encoder, so it is not a straight bridge); the ST* trailer model-byte *interpretation*
  — see §0.2.
- **The one hardware question:** whether the DSP UART reaches the external CP210x port. §2.7 shows
  the text console and the frame protocol share that single UART, so this now decides **both** at
  once. Not answerable from the image — it needs a probe on real hardware.
- **Not present in this image:** any factory-default settings table (defaults are in EEPROM /
  `FUN_0x1d29c` immediates); any in-file checksum; the voice-DB internal format.
