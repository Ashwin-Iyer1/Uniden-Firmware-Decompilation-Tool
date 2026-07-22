# Setup

## Using the tools (all you need for editing)

1. **Python 3.9+**.
2. **Pillow** (graphics/scan tools only):
   ```sh
   python3 -m pip install -r requirements.txt
   ```
3. Your own firmware `.bin` (see the main README, *Getting your firmware*).

That's it. Every tool is a plain CLI you run from the repo root, e.g.
`python3 tools/r7_unpack.py parse yourfirmware.bin`.

## Talking to the detector (for flashing)

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
