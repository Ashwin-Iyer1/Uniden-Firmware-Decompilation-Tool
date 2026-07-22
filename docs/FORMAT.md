# Firmware container format

Reference for the Uniden R7 firmware `.bin` (reverse-engineered from `R7_v153.150.127_db260702.bin`,
5,121,719 bytes). One combined image serves several models — the R7 uses the `*_nu` sections; the
R8/R4 use the `ST**` (STM32) images that are also present.

## 1. The payload transform ("old" encoding)

Every section *payload* is obfuscated the same way (the container framing — tags, lengths, the
GPS-DB footer — is plaintext). It is a **pure bijection, not encryption**:

For each 4-byte group, transpose the four 2-bit planes across the four bytes, then subtract a
per-section **key** byte (mod 256):

```
out[i]   = (d0&0x03)     | (d1&0x03)<<2 | (d2&0x03)<<4 | (d3&0x03)<<6
out[i+1] = (d0&0x0C)>>2  | (d1&0x0C)    | (d2&0x0C)<<2 | (d3&0x0C)<<4
out[i+2] = (d0&0x30)>>4  | (d1&0x30)>>2 | (d2&0x30)    | (d3&0x30)<<2
out[i+3] = (d0&0xC0)>>6  | (d1&0xC0)>>4 | (d2&0xC0)>>2 | (d3&0xC0)
out[k]  -= key                       # mod 256, for k = i..i+3
```

Because it is bijective, `encode(decode(x)) == x` exactly — see `r7_unpack.py`
(`decode_old_model` / `encode_old_model`), verified byte-exact on all code sections.

### Keys

| Section | Key |
|---|---|
| Sound | 255 |
| GPS DB — US (`LRDB`) / NZ (`DFDB`) / IL (`IRDB`) | 210 / 194 / 226 |
| **ui_nu** (Main) | **182** |
| **dsp_nu** (DSP) | **184** |
| **gps_nu** (Sub) | **183** |

The Sound/GPS keys are from the upstream tool; the three **code-section keys were recovered here**
by maximizing ARM Thumb-2 disassembly validity.

## 2. Container layout

```
python3 tools/r7_unpack.py parse <fw.bin>
```

| Section | Offset | Length | Contents | Key |
|---|---|---|---|---|
| header | 0x0 | 24 B | section lengths + flags | plain |
| **ui_nu** (DRSWMAI) | 0x000018 | 195072 | Main MCU — UI, menus, display, graphics | 182 |
| **dsp_nu** (DRSWDSP) | 0x02fa21 | 114688 | DSP — RF sweep, detection, band logic | 184 |
| **gps_nu** (DRSWSUB) | 0x04ba2a | 40960 | Sub/GPS MCU | 183 |
| sound_dbnu (DRSWSDB) | 0x055a33 | ~2 MB | voice / alert audio | 255 |
| GPSD:LRDB | 0x255a46 | ~204 KB | camera database | 210 |
| STUI / STDS / STGP / STSD | 0x288a65+ | — | R8/R4 STM32 images (unused by R7) | — |
| NMGF | 0x4e26a4 | — | footer / merge marker | plain |

Header: `u32 first` where `first & 0xFFFFFF` = ui_nu length (rounded up to 512), `(first>>24)&1` =
"sound present"; then `u32 dsp_nu_len`, `u32 gps_nu_len`; a 12-byte `SNDD` record holds the sound
length. Each `*_nu` payload ends with a 9-byte trailer: `u16 (model<<10 | version)` + `"DRSWxxx"`.
The `u16` decodes model **7 = R7** and the version (e.g. 153/150/127 → `v153.150.127`).

## 3. The code sections are ARM Cortex-M

Decoding ui_nu/dsp_nu/gps_nu yields **ARM Cortex-M, Thumb-2, little-endian, load base `0x0`**.

| Image | Initial SP | Reset | Notes |
|---|---|---|---|
| ui_nu  | 0x20001ef8 | 0x2ac | vector table + `"In Hard Fault Handler"` |
| dsp_nu | 0x20003568 | 0x2a8 | |
| gps_nu | 0x20003d38 | 0x174 | |

Load `decoded/*.bin` in Ghidra as **ARM:LE:32:Cortex:default**, image base `0x0`. Extract them with
`python3 tools/r7_unpack.py extract <fw.bin> decoded/`.

`.data` is **LZSS-compressed** in flash and unpacked at boot by a custom decompressor
(`FUN_00000488`; copy-descriptor table at ui_nu `0x2f78c`). Note: because of the compressed `.data`
tail, ui_nu's real content extends slightly past its declared length field — decode a bit beyond
nominal when reading it (the tools handle this).

## 4. ui_nu display / graphics system

- Display is **176 × 60**. Three bitmap formats (from the blitters): **1-bpp** (`FUN_00005690`,
  row = ⌈w/8⌉ B), **2-bpp** (`FUN_000056dc`, row = ⌈w/4⌉ B, 4 shades, colorized by the blitter),
  **16-bpp RGB565** (`FUN_00009d9c`, one `u16` per pixel, MSB-first pixel packing for 1/2-bpp).
- **Boot logo** ("Uniden"): 176×60 2-bpp at ui_nu-internal `0x2d526`, drawn by `FUN_00006dd4`.
- **Scan animation**: 30 tiles (11×8 RGB565) at `0x29b6e`; choreography `framedata[20][8]` in the
  compressed `.data`. See [SCAN_ANIMATION.md](SCAN_ANIMATION.md).
- **Menu / mode / display text** are plain null-terminated strings drawn via a font. See
  [TEXT.md](TEXT.md).

## 5. dsp_nu — the RF/detection side

The DSP exposes a **serial debug command console** (dispatch table at `0xdbe0`, entries
`{name_ptr, handler_ptr, index}`). Notable commands: `BSEL` (band select) writes mux register
`0x40004000`; `SKAH`/`SKAL` set the Ka sweep high/low bounds; `BW`/`TU`/`PLL` set tuner bandwidth /
tuner / PLL. Core helpers: `FUN_00004b58` programs the tuner, `FUN_000047e0` the PLL,
`FUN_000010c6` sets mux register fields. This is the layer that controls **band filtering**; editing
it is code work, not a data edit (see [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md)).

## 6. GPS / camera database (`LRDB`)

16-byte records, transpose-encoded with key 210, POI count stored (encoded) in the footer, **no
checksum**, body padded with `0xFF` records to a 512-byte boundary. Records must be **sorted by
latitude, descending** (the device scans by latitude window). Full schema: [GPS_DATABASE.md](GPS_DATABASE.md).
