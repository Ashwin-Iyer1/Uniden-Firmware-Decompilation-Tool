# Uniden R7 Firmware Toolkit

Open tools for **decoding, editing, and re-packing Uniden R7 radar-detector firmware** — so you
can customize your *own* detector: edit menu/display text, swap the boot logo and other bitmaps,
build a custom GPS/red-light-camera database, and even edit the idle "Scan" animation.

Every tool round-trips **byte-for-byte** (decode → re-encode reproduces the original firmware
exactly), so any change you make is precisely and only your change.

> Reverse-engineered from firmware **`R7_v153.150.127`**. The *methods* are general to the Uniden
> R-series; the *specific offsets* baked into the tools are for that version (see
> [Firmware versions](#firmware-versions)).

---

## ⚠️ Read this first — safety, legality, warranty

- **You can brick your detector.** Flashing modified firmware is inherently risky. The R7 has a
  **Recovery Mode** that can reflash a good image (see [docs/FLASHING.md](docs/FLASHING.md)), which
  makes most mistakes recoverable — but there is **no warranty here**. Use at your own risk.
- **Keep a known-good backup** of your stock firmware before flashing anything.
- **This is for your own device.** Modifying firmware may void your warranty.
- **Radar detectors are not legal everywhere.** They are prohibited in some jurisdictions (e.g.
  Virginia and Washington D.C. in the USA, in commercial vehicles, and in various countries).
  Know your local laws. This project takes no position on where/how you use your detector.
- **Do not redistribute Uniden's firmware or extracted assets.** The firmware is Uniden's
  copyrighted property. This repo ships **only tools and documentation** — you supply your own
  firmware image (see [Getting your firmware](#getting-your-firmware)). The `.gitignore` is set up
  to keep firmware and extracted assets out of the repo.

This project is unaffiliated with and unendorsed by Uniden.

---

## What you can change

| Capability | Tool | Guide |
|---|---|---|
| **Menu / display text** (rename items, add owner name/email) | `r7_patch.py` | [docs/TEXT.md](docs/TEXT.md) |
| **Boot logo & bitmaps** (replace the "Uniden" splash) | `r7_gfx.py` | [docs/GRAPHICS.md](docs/GRAPHICS.md) |
| **GPS / camera database** (speed, red-light, custom points) | `r7_gpsdb.py` | [docs/GPS_DATABASE.md](docs/GPS_DATABASE.md) |
| **"Scan" idle animation** (the sweeping bar) | `r7_scan.py` | [docs/SCAN_ANIMATION.md](docs/SCAN_ANIMATION.md) |
| **Inspect / unpack the container** | `r7_unpack.py` | [docs/FORMAT.md](docs/FORMAT.md) |
| **DSP serial messages** (band enables, Ka-segment mask — runtime, no reflash) | `r7_ipc.py` | [docs/DSP_PROTOCOL.md](docs/DSP_PROTOCOL.md) |

Raw byte/patch edits of any section are possible via `r7_patch.py patch`.

---

## Requirements

- **Python 3.9+**
- **Pillow** (only for the graphics/scan tools): `pip install -r requirements.txt`
- A **micro-USB data cable** and the **Silicon Labs CP210x VCP driver** to talk to the detector
  ([Silicon Labs downloads](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers)).
- Optional, only if you want to re-run the reverse engineering: **Ghidra** + **capstone**
  (see [docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md)).

```sh
git clone <your-fork-url> && cd uniden-r7-toolkit
python3 -m pip install -r requirements.txt
```

## Getting your firmware

This repo does **not** include firmware. Obtain your own `.bin`:

- Download from [Official Uniden Software Site](https://www.uniden.info/download/index.cfm)

Keep the untouched original as your recovery image.

---

## Quick start

All commands are run from the repo root; pass your firmware path as the first argument.

```sh
# 1. See what's inside the container (sections, versions, keys)
python3 tools/r7_unpack.py parse  R7_v153.150.127_db260702.bin

# 2. Change on-screen text — e.g. put your name in the "Self Test" slot
python3 tools/r7_patch.py showstr R7_v153.150.127_db260702.bin ui_nu 0x2268
python3 tools/r7_patch.py setstr  R7_v153.150.127_db260702.bin ui_nu 0x2268 "YOUR NAME" out.bin

# 3. Replace the boot logo with a custom 176x60 image
python3 tools/r7_gfx.py render   R7_v153.150.127_db260702.bin 0x2d526 176 60 2bpp logo.png   # see current
python3 tools/r7_gfx.py replace  R7_v153.150.127_db260702.bin 0x2d526 176 60 2bpp mylogo.png out.bin

# 4. Add a camera to the GPS database (auto-sorted, resized, dated)
python3 tools/r7_gpsdb.py export R7_v153.150.127_db260702.bin cameras.csv
python3 tools/r7_gpsdb.py add    R7_v153.150.127_db260702.bin out.bin 32.9201 -97.1307 45   # speed cam

# 5. Pull the Scan animation and prove the round-trip is loss-less
python3 tools/r7_scan.py pull    R7_v153.150.127_db260702.bin scan_pull/
python3 tools/r7_scan.py verify  R7_v153.150.127_db260702.bin      # -> "0 DIFF"
```

Then **flash** the `out.bin` you produced — see [docs/FLASHING.md](docs/FLASHING.md) (and its
recovery section) **before** you do.

---

## How the firmware is structured (the short version)

The `.bin` is a container of named sections (`ui_nu` = Main MCU / UI, `dsp_nu` = DSP, `gps_nu` =
Sub/GPS, `sound_dbnu` = audio, `LRDB` = camera DB, plus R8/R4 `STxx` images). Each payload is
obfuscated with a **2-bit-plane transpose across every 4-byte group, then a per-section subtract
key** — a pure bijection, *not* encryption. Decoding the three code sections yields **ARM
Cortex-M** images. Full details, keys, and memory maps: **[docs/FORMAT.md](docs/FORMAT.md)**.

There is **no whole-image checksum** on the code sections, and the R7's bootloader Recovery Mode
can restore a bad flash — which is what makes safe experimentation practical.

## Firmware versions

The decode/encode math is version-independent, but tools that target a *feature* hard-code offsets
found in **`R7_v153.150.127`** (boot logo `0x2d526`, self-test string `0x2268`, scan tiles
`0x29b6e`, …). On a different firmware version these move. `r7_unpack.py parse` still works on any
R-series image; to re-locate feature offsets on another version, follow
[docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md). PRs adding a version→offsets table are
very welcome.

## Repository layout

```
tools/     the CLIs (r7_unpack, r7_patch, r7_gfx, r7_gpsdb, r7_scan)
docs/      detailed guides (format, setup, flashing, and one per capability)
examples/  clean templates (e.g. a GPS-database CSV)
```

## Contributing

Issues and PRs welcome — especially other firmware versions' offsets, additional R-series models,
and more decoded display/menu structures. See [docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md)
for the methodology and the Ghidra workflow used here.

## License & attribution

**GNU AGPL-3.0** (see [LICENSE](LICENSE)). This project derives from
[AngeloD2022/uniden-firmware-tool](https://github.com/AngeloD2022/uniden-firmware-tool) (AGPL-3.0)
— the container layout and the "old" Sound/GPS-DB transform originate there. New in this project:
the **code-section subtract keys**, the **ARM decoding**, the **graphics/blitter formats and boot
logo**, the **LZSS `.data` decompressor**, and the **Scan-animation** format and tooling.

Community reverse-engineering discussion lives at [rdforum.org](https://www.rdforum.org/).
