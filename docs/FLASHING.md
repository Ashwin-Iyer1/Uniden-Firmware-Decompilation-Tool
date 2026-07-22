# Flashing & recovery

> **Flashing modified firmware can brick your detector.** Read this whole page first. The single
> most important rule: **keep an untouched copy of your stock firmware.**

## Before you flash anything

1. **Back up stock firmware.** Copy your original `.bin` somewhere safe. This is your recovery image.
2. **Prove the whole chain works with an official update first.** Run the Uniden Updater's normal
   update once, so you know your cable, driver, and software all work — and you have a known-good
   baseline to fall back to.
3. **Sanity-check your modified file** before it ever touches the device:
   ```sh
   python3 tools/r7_unpack.py parse yourmod.bin      # all sections must still parse
   ```
   For a GPS-only or graphics-only edit, every *other* section should be byte-identical to stock —
   the per-capability guides show how to confirm that.

## Flashing

Two paths depending on what you changed:

- **GPS / camera database** (data only): use the Uniden Updater's **"Download Files"** function
  (left side) to load a database file — this is the lower-risk, database-only path.
- **Firmware** (text, graphics, scan animation — anything in `ui_nu`): flashed via the Updater's
  main update / **Recovery Mode** path, pointing it at your local `.bin` in place of the official
  extracted image.

> **Not yet fully documented here:** the exact click-path to make the official Updater flash a
> *local custom* image varies by Updater version. This is the same substitution the community uses
> for custom firmware. If your Updater doesn't obviously let you choose the file, stop and ask on
> [rdforum.org](https://www.rdforum.org/) rather than forcing it. Contributions documenting the
> current procedure are welcome.

Port reference: macOS `/dev/cu.SLAB_USBtoUART`, Windows `COMx`, Linux `/dev/ttyUSB0`.

## Recovery Mode (your safety net)

The R7 has a **built-in Recovery Mode** that can reflash firmware from a local file **even if a
previous flash failed** — so a bad flash is generally *recoverable*, not a permanent brick.

General procedure (confirm details for your Updater version):
1. Download/extract the official firmware.
2. Put the detector into recovery mode (the Updater has a **recovery-mode button**).
3. Start the download; if it fails, retry — if it fails again, unplug/replug so the tool
   re-detects the device, then retry.

Recovery restores the device to the flashed image (and typically resets settings), so re-flash your
**stock** `.bin` (or a fresh official image) to get back to known-good.

## Integrity notes

- The **GPS database has no checksum**, so a well-formed edited database is structurally valid.
- No whole-image checksum was found on the **code sections** either; integrity during transfer is
  handled by the update protocol. A minimal, in-place edit (text/graphics) is the safest kind —
  it changes only the bytes you intend and leaves every other section identical to stock.
- Still: **there are no guarantees.** Change one thing at a time, keep backups, and know your
  recovery path before you press flash.
