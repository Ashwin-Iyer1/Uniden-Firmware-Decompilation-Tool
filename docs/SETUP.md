# Setup

> **Model scope:** Container inspection and raw extraction support R7, R4W and R8W.
> The legacy decoding keys, ARM offsets and editing procedures below were established
> for R7. See [R4W/R8W support](R4W_R8W.md) for the wireless models and current limits.

## Offline inspection: R7, R4W and R8W

Python 3.9+ is sufficient; no driver or detector connection is needed.

```sh
python3 tools/rseries.py inspect /path/to/R4W_v127.128.123_db260702.bin
python3 tools/rseries.py extract /path/to/R8W_v142.113.127_db260702.bin decoded/r8w
python3 tools/rseries_probe.py /path/to/R8W_v142.113.127_db260702.bin
```

See [R4W/R8W support](R4W_R8W.md) for the extraction manifest and verified
wireless image layout. [Firmware findings](FIRMWARE_FINDINGS.md) records the
completed offline checks and current decoding limits.

## R7 editing requirements

1. **Python 3.9+**.
2. **Pillow** (graphics/scan tools only):
   ```sh
   python3 -m pip install -r requirements.txt
   ```
3. Your own firmware `.bin` (see the main README, firmware download link).

That's it. Every tool is a plain CLI you run from the repo root, e.g.
`python3 tools/rseries_unpack.py parse yourfirmware.bin`.

## R7 connection setup (for flashing)

- A quality **micro-USB data cable** (not charge-only).
- The **Silicon Labs CP210x VCP driver**
  ([download](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers)) — macOS, Windows,
  and Linux. On macOS the detector then appears as `/dev/cu.SLAB_USBtoUART`; on Windows as a `COM`
  port; on Linux as `/dev/ttyUSB*`.
- The **Uniden Updater** application (from uniden.info) for the actual flash — see
  [FLASHING.md](FLASHING.md).

## Optional: re-running the reverse engineering

Only needed if you want to re-derive offsets (e.g. for a different firmware version) or explore the
code yourself:

- **Ghidra** (`brew install ghidra` on macOS pulls JDK 21; or download from the NSA GitHub). Launch
  with `ghidraRun`.
- **capstone** for quick disassembly from Python: `pip install capstone`.

See [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md) for the workflow, headless scripts, and how to
locate feature offsets on a new firmware version.
