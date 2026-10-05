# Uniden R-series Firmware Toolkit

Tools for inspecting **Uniden R7, R4W and R8W** firmware updates. The toolkit
extracts their components, reports model and version metadata, and reproduces
an unchanged update byte-for-byte. It also decodes and edits the documented R7
images and validates the ESP32-C3 wireless images in R4W/R8W updates.

## Model support

| Operation | R7 | R4W v127.128.123 | R8W v142.113.127 |
|---|---|---|---|
| Container inspection and raw extraction | Supported | Supported | Supported |
| Unchanged extraction/repack | Supported | Verified on stock image | Verified on stock image |
| Main / DSP / GPS decoding | Legacy transform supported | Unresolved | Unresolved |
| Wireless ESP image extraction and checksum validation | No BLES fixture supplied | Verified | Verified |
| Camera database editing | Legacy DB formats | AES format; no decoder | AES format; no decoder |
| Text, graphics, scan and band edits | Documented R7 version only | Unsupported | Unsupported |
| Verified hidden diagnostics / key combinations | See R7-specific guides | None established | None established |

**R-series tool names describe the toolkit, not universal editing support.**
The editors reject R4W/R8W before modifying output. R7 keys and feature offsets
must not be applied to wireless models. Start with [R4W/R8W support](docs/R4W_R8W.md)
and [firmware findings](docs/FIRMWARE_FINDINGS.md) for those models.

## Quick start: R7, R4W or R8W

Python 3.9+ is sufficient for these commands; firmware is supplied by you.

```sh
git clone https://github.com/klinquist/Uniden-Firmware-Decompilation-Tool.git
cd Uniden-Firmware-Decompilation-Tool
python3 tools/rseries.py inspect /path/to/R8W_v142.113.127_db260702.bin
python3 tools/rseries.py inspect /path/to/R4W_v127.128.123_db260702.bin --json
python3 tools/rseries.py extract /path/to/R8W_v142.113.127_db260702.bin decoded/r8w
python3 tools/rseries.py repack decoded/r8w /tmp/r8w-reproduced.bin
```

Use an empty extraction directory and a new output filename. Repacking verifies
all original bytes against the source SHA256; it rejects modified pieces.
Supported decodings and wireless segments are exported separately for analysis.
Download your stock image from the [official Uniden software site](https://www.uniden.info/download/index.cfm)
and retain the untouched original. Firmware and extracted assets are excluded
from this repository.

## Tools and guides

Canonical commands use `rseries_*.py`. Existing `r7_*.py` commands and public
imports remain compatibility aliases with the same model restrictions.

| Capability | Tool | Applicability / guide |
|---|---|---|
| Inspect, extract and reproduce updates | `rseries.py` | R7 / R4W / R8W: [format](docs/FORMAT.md), [wireless models](docs/R4W_R8W.md) |
| Parse containers / legacy transforms | `rseries_unpack.py` | Container: all three; decoding: supported legacy sections |
| Compare block patterns and decoding hypotheses | `rseries_probe.py` | All three: [findings](docs/FIRMWARE_FINDINGS.md) |
| Menu / display text | `rseries_patch.py` | R7: [text](docs/TEXT.md) |
| Boot logo and bitmaps | `rseries_gfx.py` | R7: [graphics](docs/GRAPHICS.md) |
| Camera database | `rseries_gpsdb.py` | R7 legacy DB: [GPS database](docs/GPS_DATABASE.md) |
| Idle scan animation | `rseries_scan.py` | R7: [scan animation](docs/SCAN_ANIMATION.md) |
| Band frequency windows | `rseries_bands.py` | R7: [band filtering](docs/BAND_FILTERING.md) |
| Voice / alert audio | `rseries_sound.py` | R7: [sound](docs/SOUND.md) |
| DSP serial frame codec | `rseries_ipc.py` | R7 protocol: [DSP messages](docs/DSP_PROTOCOL.md) |
| UI/GPS link codec | `rseries_iplink.py` | R7 analysis; W-model protocol unverified |
| Camera alert simulation | `rseries_alertsim.py` | R7 GPS matcher; W-model behavior unverified |
| `.data` compression | `rseries_lzss.py` | R7 LZSS; W-model codec unverified |

Each engineering guide identifies its model scope. [Firmware map](docs/FIRMWARE_MAP.md)
and [what you can change](docs/WHAT_YOU_CAN_CHANGE.md) describe the decoded R7
image; the [wireless-model map](docs/R4W_R8W.md#verified-component-map) supplies
separate R4W/R8W offsets. [Setup](docs/SETUP.md), [flashing](docs/FLASHING.md) and
[reverse engineering](docs/REVERSE_ENGINEERING.md) retain the established R7
procedures; those procedures do not establish a custom W-model flashing workflow.

## R7 editing example

The documented editing offsets come from `R7_v153.150.127`. They may move in
other versions. Graphics and scan tools require Pillow (`pip install -r requirements.txt`).

```sh
python3 tools/rseries_patch.py showstr R7_v153.150.127_db260702.bin ui_nu 0x2268
python3 tools/rseries_patch.py setstr R7_v153.150.127_db260702.bin ui_nu 0x2268 "YOUR NAME" out.bin
python3 tools/rseries_scan.py verify R7_v153.150.127_db260702.bin
```

Read the model-specific guides before editing or flashing.

## Validation and contributing

```sh
python3 -m unittest discover -s tests -v
# Optional: exact stock R4W/R8W integration checks, with files outside the repo.
UNIDEN_FIRMWARE_DIR=/path/to/firmware python3 -m unittest discover -s tests -v
```

CI uses synthetic fixtures and does not redistribute firmware. Contributions
should state model, version and evidence; distinguish validated decoders from
hypotheses. See [firmware findings](docs/FIRMWARE_FINDINGS.md) for the completed
offline checks and their limits.

## Repository layout

```text
tools/     R-series CLI tools and legacy r7_* compatibility entry points
docs/      shared format, separate R4W/R8W support, research, R7-specific guides
tests/     synthetic regression tests and optional local stock-image checks
examples/  clean templates (e.g. a GPS-database CSV)
```

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

## License & attribution

**GNU AGPL-3.0** (see [LICENSE](LICENSE)). This project derives from
[AngeloD2022/uniden-firmware-tool](https://github.com/AngeloD2022/uniden-firmware-tool) (AGPL-3.0)
— the container layout and the "old" Sound/GPS-DB transform originate there. New in this project:
the **code-section subtract keys**, the **ARM decoding**, the **graphics/blitter formats and boot
logo**, the **LZSS `.data` decompressor**, and the **Scan-animation** format and tooling.

Community reverse-engineering discussion lives at [rdforum.org](https://www.rdforum.org/).
