# What you can change (and what you can't)

A practical map of **everything** in the Uniden R7 firmware, classified by *how* you'd change it and
*which tool* does the job. Findings are for **`R7_v153.150.127`** (offsets move on other versions;
the *contents* don't). For the exhaustive byte map see [FIRMWARE_MAP.md](FIRMWARE_MAP.md).

## The four kinds of change

| Class | What it means | Tool | Risk |
|---|---|---|---|
| **data-edit** | Swap bytes in a stored table/asset/string; length-preserving; re-encode + splice. | `r7_patch` · `r7_gfx` · `r7_scan` · `r7_gpsdb` · `r7_bands` · `r7_sound` · `r7_lzss` | Low |
| **code-patch** | Change ARM Thumb-2 instructions or code-referenced pointer tables/immediates. | Ghidra + `r7_patch.py patch` | High |
| **runtime-config** | A user menu setting stored in the device's EEPROM, **not** in the `.bin`. | On-device menu | None (no flashing) |
| **not-editable** | Silicon-fixed, bootloader-gated, or an uncracked format — no safe path. | — | — |

There is **no in-file checksum** on any section or the whole image ([FIRMWARE_MAP.md](FIRMWARE_MAP.md)
§0.5), so a length-preserving data-edit changes only the bytes you intend and every other section
stays byte-identical to stock. The R7's **Recovery Mode** makes a bad flash recoverable — but always
keep a stock `.bin`. See [FLASHING.md](FLASHING.md).

---

## SAFE vs RISKY vs NOT POSSIBLE

**SAFE — in-place data-edits (byte length preserved, round-trip verified, no checksum to break):**

- On-screen **text**: menu items, mode/band labels, laser gun names, owner name/email — [TEXT.md](TEXT.md)
- **Graphics**: boot logo, icons, signal bars, backgrounds, fonts — [GRAPHICS.md](GRAPHICS.md)
- **Scan idle animation** tiles (the look) — [SCAN_ANIMATION.md](SCAN_ANIMATION.md)
- **GPS / camera database**: add/remove/modify camera & POI points — [GPS_DATABASE.md](GPS_DATABASE.md)
- **Voice / alert audio**: replace clips (8-bit PCM) — [SOUND.md](SOUND.md)
- **DSP band frequencies** — move X/K/Ka detection windows via the coefficient table — `r7_bands.py` (expert)

**RISKY — code-patches (real firmware dev; can brick if wrong, Recovery Mode is your net):**

- Factory-default settings, menu structure, display-mode renderers, font metrics
- DSP band-mux logic, tuner/PLL math, adding a new Ka segment, K-band center
- Boot/vector/clock code

**NOT POSSIBLE (from firmware editing) — do it in the menu, or it isn't cracked:**

- Any current **user setting** (theme, band on/off, Ka segments, filters, quotas): change it in the
  **on-device menu** — it lives in EEPROM, not the `.bin`. Editing firmware won't move it.
- **Settings defaults as a table** — there is none; defaults are code immediates (a code-patch).
- **Silicon** (MMIO registers, memory map, MCU flashing) and the **ST\* STM32 images** (a different
  device — never flash them to an R7).

---

## Full classification

### On-screen text  →  data-edit  ·  `r7_patch.py`  ·  SAFE

Menu items, mode/band/color labels, alert strings, unit strings, the 17 laser-gun-ID names, Ka
segment freq labels, and the owner name/email slots are all plain NUL-terminated strings in `ui_nu`.
Edit in place with `r7_patch.py setstr`. **Cap = field size − 1 char** (the tool reserves the NUL and
refuses overflow). Preserve any `%`-format specifier (`%2d`, `%3d`, `%x`, …) — it's load-bearing.
Full how-to and offset anchors: **[TEXT.md](TEXT.md)**.

> Growing a string *past* its field would need relocating it and rewriting the ARM literal pointer(s)
> that reference it — that becomes a **code-patch** and is not tooled.

### Graphics — logo, icons, bars, backgrounds  →  data-edit  ·  `r7_gfx.py`  ·  SAFE

The 176×60 display's bitmaps (1-bpp / 2-bpp / RGB565) round-trip byte-exact. Swap any asset in place
with `r7_gfx.py replace <fw> <off> <w> <h> <fmt> <png> <out>`. Catalog of 120 assets + offsets in
[FIRMWARE_MAP.md](FIRMWARE_MAP.md) §1.10. Highlights: boot logo `0x2d526` (176×60 2-bpp), signal bars
`0x2534a + i·0x804` (114×9 565), band badges, alert icons. Full how-to: **[GRAPHICS.md](GRAPHICS.md)**.

### Fonts (glyph shapes)  →  data-edit  ·  `r7_gfx.py`-style / manual  ·  SAFE

Six 1-bpp fonts at `0x2ba8a`–`0x2d526` (main proportional 16×24 @`0x2c024`, four digit fonts, two
small fonts — [FIRMWARE_MAP.md](FIRMWARE_MAP.md) §1.9). Swap glyph bitmaps **in place** (keep each
record's byte length) to restyle the on-screen font. The main-font advance-width lookup hardcodes
stride 49 / base `0x2c024`. No dedicated font tool ships yet, but the region is length-preserving and
round-trips under key 182.

> Changing a font's **box size, char range, or spacing** means patching hardcoded immediates in its
> draw routine — that's a **code-patch**.

### Scan idle animation  →  tiles + motion are data-edit  ·  `r7_scan.py`, `r7_lzss.py`  ·  SAFE

The "Scan" main-display animation is **data-driven**, not procedural. The **30 tiles** (11×8 RGB565 @
`0x29b6e`, 8 themes × 5 states with tile reuse) are uncompressed → edit the *look* with `r7_scan.py`
(0-diff verified). Full how-to: **[SCAN_ANIMATION.md](SCAN_ANIMATION.md)**.

Changing the **motion** means editing `framedata[20][8]` (per-cell tile-state 0–4) inside the
**LZSS-compressed `.data` block1** (flash `0x2f7ac`, [FIRMWARE_MAP.md](FIRMWARE_MAP.md) §1.4). The
compressor now exists — **`tools/r7_lzss.py`** (verified round-trip; output fits the `~0x128` B of
`0xFF` headroom after the stock stream). So re-choreographing is **data-edit** now: decompress block1,
edit the framedata bytes, re-`compress`, splice `.data` back into `ui_nu`. It's a lower-level flow
than tile editing (no single turnkey command yet), but it's no longer blocked.

### GPS / camera database  →  data-edit  ·  `r7_gpsdb.py`  ·  SAFE (lowest-risk flash)

Add, remove, or modify speed cameras, red-light cameras, and custom alert points. 16-byte records,
key 210, no checksum, auto re-sorted by latitude. Full schema & workflows:
**[GPS_DATABASE.md](GPS_DATABASE.md)** and [FIRMWARE_MAP.md](FIRMWARE_MAP.md) §5. Field notes:
`f0`=type (1 speed / 2 red-light), `speed`=posted limit (0 for red-light), `category`=region/unit
(1 Canada-km/h, 2 USA-mph), `heading`=1–360 (360=any, never 0), `f2`=directional match mode
(1 = one-way / ±30° of heading, 2 = two-way / ±30° of heading or its reverse — cracked from the
`gps_nu` matcher). Combined RLC+speed sites are **two** records at the same coord.
Flashed via the Updater's lower-risk "Download Files" path.

### Band filtering (the DSP side)  →  frequencies data-edit; logic code-patch  ·  `r7_bands.py`  ·  RISKY (expert)

Band filtering lives in `dsp_nu`. There are **two** halves:

- **data-edit (frequencies):** the RF detection windows are a **coefficient table** (33×16 B @
  `0x0dd34`) with `freq_low`/`freq_high` stored **directly in kHz** — X, K, Ka each have records.
  **`tools/r7_bands.py setfreq`** moves a band's window (re-encodes key 184, round-trip-verified),
  and `dump` lists the table. Full guide: **[BAND_FILTERING.md](BAND_FILTERING.md)**,
  [FIRMWARE_MAP.md](FIRMWARE_MAP.md) §2.6. *Caveat: records are shared across modes, so one edit
  affects every mode that uses that band.* (The 20-byte sweep-schedule records @ §2.2 point into this
  table; `band_type`/`ifconst` are hardware-coupled — don't touch them.)
- **code-patch (logic):** the BSEL band-mux handler, the tuner/PLL programmers' math, the band-enable
  applier engines (`FUN_0x5788`/`0x5416`), adding a **new** Ka segment beyond the 9 (needs the `tbb`
  tables + mask + record-count constants widened), or gating which band-selector applies a record.
- **runtime / volatile:** the DSP serial console commands (`BSEL/TU/PLL/SK/SKAL/SKAH/BW/S/SS/SX`)
  write only RAM/MMIO — **nothing is persisted**, so they're live bench knobs, not a way to save
  changes. Permanent changes must edit the flash tables above.
- **runtime / protocol:** the DSP also accepts a framed **radar-configuration message** (opcode
  `0x10`) on that same UART, whose `ka_mask` field sets all nine Ka segments at once and whose
  `band_bits` field drives the band enables — see [DSP_PROTOCOL.md](DSP_PROTOCOL.md), tool
  `tools/r7_ipc.py`. Also volatile. **Whether that UART is reachable from outside the case is
  unproven** — the console and this protocol share one port, so both hinge on the same question.

> Turning existing Ka segments on/off is already a **user menu setting** ("Ka Segmentation", 9-bit
> mask) — the runtime mask **overrides** the flash `enable_default`. So to *force* a segment off in
> firmware you must patch the mask source/mode-id (code-patch), not just the table.
>
> That mask is now fully traced: it is `ka_mask` (field 12 of DSP message `0x10`), bit *N* → sweep
> record mode id `0x10+N`, and on the ui side it is packed from `config[0xe0..0xe8]` with inverted
> sense (FIRMWARE_MAP §1.13/§2.8). Note the DSP ignores `ka_mask` entirely unless `band_bits` bits 0
> **and** 2 are set.

### Settings & their defaults  →  values are runtime-config; defaults are code-patch

- **Current setting values** (color theme `+0xb7`, main display mode `+0xd1`, band toggles,
  filters, quotas, Ka segments, all ~202 fields of the config struct at SRAM `0x200008ec`) are
  **runtime-config** — the user sets them in the on-device menu and they persist to **external
  EEPROM**, not to this `.bin`. Editing firmware does not change them.
- **Power-on / factory-reset defaults** are **not** stored as a table anywhere in the image. They are
  written by factory-init `FUN_0x1d29c` as instruction immediates (`movs #imm; strb …`). Changing a
  default = patching those immediates = **code-patch**.
- **Menu structure** (137-case dispatcher `FUN_0x13e3c`, the case→config-byte map) is code —
  adding/removing/re-pointing a screen is a **code-patch**.

### Boot, vectors, clocks, MCU  →  code-patch / not-editable  ·  RISKY→impossible

- Reset/unlock/clock init, interrupt vector tables, exception handlers, named ISRs: **code-patch**,
  boot/integrity-critical — a wrong SP/reset/clock value hangs the MCU before `main`. Low user value.
- The MMIO peripheral map, memory map, and the fact that flashing is done by the Nuvoton **LDROM
  bootloader** (the app images don't self-program flash): **not-editable** (silicon/bootloader-gated).

### Voice / alert audio  →  extract-only (for now)  ·  `r7_sound.py`

`sound_dbnu` decodes (key **225**, not 255) to a **Nuvoton ISD3800 ChipCorder flash image** — a
`0xCX` memory header + a **250-entry voice-prompt directory** + **4-bit ADPCM** clips (decoded in
the R7's dedicated ISD3800 chip, not in firmware). `r7_sound.py` lists the 250 clips and extracts
raw `.adpcm` + a **best-effort** WAV (silence/timing correct, tone still noisy — the ISD3800's ADPCM
predictor is proprietary). **Editing** needs an ISD3800 encoder (Nuvoton's ISD-VPE tool), or one
confirmed clip→word anchor to finish the codec — a WAV cannot be injected as raw bytes. Full
write-up: **[SOUND.md](SOUND.md)**. (`STSD` is the STM32 sibling's bank — leave it alone.)

### The ST\* STM32 images  →  not-editable *for an R7*  ·  DO NOT FLASH

`STUI/STDS/STGP/STSD` are a complete firmware set for a **different STM32 device** carried in the same
combined `.bin` (base `0x08000000`, STGP has an FPU). They are dead weight to an R7. They decode with
the same keys, but editing or flashing them into an R7 has **zero effect at best and a
silicon/base-address mismatch at worst**. Leave them alone. See [FIRMWARE_MAP.md](FIRMWARE_MAP.md) §6.

---

## Quick "how do I change X?" index

| I want to change… | Class | Where / tool |
|---|---|---|
| A menu label, mode name, band string | data-edit | [TEXT.md](TEXT.md) |
| Owner name / email on a menu | data-edit | [TEXT.md](TEXT.md) (`Alert Display #1/#2`, `Self Test`) |
| Owner name / email on the boot splash | data-edit | [GRAPHICS.md](GRAPHICS.md) (logo is a bitmap) |
| Boot logo, an icon, a signal bar | data-edit | [GRAPHICS.md](GRAPHICS.md) |
| The on-screen font's look | data-edit | fonts `0x2ba8a`–`0x2d526` ([FIRMWARE_MAP.md](FIRMWARE_MAP.md) §1.9) |
| Scan animation colors/tiles | data-edit | [SCAN_ANIMATION.md](SCAN_ANIMATION.md) |
| Scan animation *motion* | data-edit | `r7_lzss.py` re-packs `.data` framedata |
| Add/remove cameras or POIs | data-edit | [GPS_DATABASE.md](GPS_DATABASE.md) |
| Move an X/K/Ka detection frequency | data-edit (expert) | `r7_bands.py` ([BAND_FILTERING.md](BAND_FILTERING.md)) |
| Turn an existing Ka segment on/off | runtime-config | on-device "Ka Segmentation" menu |
| A current setting (theme, filters, quota) | runtime-config | on-device menu (EEPROM, not the `.bin`) |
| A power-on/factory default | code-patch | `FUN_0x1d29c` immediates |
| Band-mux / detection logic, new segment | code-patch | dsp_nu ([FIRMWARE_MAP.md](FIRMWARE_MAP.md) §2) |
| Replace a voice / alert clip | data-edit | `r7_sound.py` ([SOUND.md](SOUND.md)) |
| Anything in the ST\* sections | not-editable | different device — do not flash |

Before flashing anything, read **[FLASHING.md](FLASHING.md)** and keep a stock `.bin`. Change one
thing at a time and confirm only the bytes you intended moved.

> Offsets and function addresses here are specific to `R7_v153.150.127`; on another version, contents
> are identical but positions move.
