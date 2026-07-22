# Editing the "Scan" idle animation

When Main Display is set to **Scan**, the R7 shows a small sweeping bar. It is **not** procedural —
it's a **data-driven tile animation**, which is what makes it editable with a clean round-trip.

## How it works

- Renderer `FUN_000058dc(frame)` draws **8 cells per frame**, each an **11×8 RGB565 tile**, at
  screen (76, 37). Driver `FUN_00009268` advances a **20-frame** counter.
- **Tiles:** 30 of them, contiguous **uncompressed** in `ui_nu` flash at internal `0x29b6e`
  (176 bytes each). They are **6 color themes × 5 states** (state 0 = empty … 4 = bright head).
  The active theme picks colorset 0 (even) or 5 (odd).
- **Choreography:** `framedata[20][8]` (which tile-state each cell shows each frame) lives in the
  LZSS-compressed `.data`. Stock pattern = a bright dot with a fading `1→2→3` trail sweeping
  left→right (frames 0–10) then right→left (frames 11–19).

The **tiles** are the editable visual content; the choreography is left untouched by the tool.

## Tool: `r7_scan.py`

```
python3 tools/r7_scan.py pull   <fw> <out_dir>      # tiles.png + scan_theme0/5.gif + framedata.txt
python3 tools/r7_scan.py encode <fw> <tiles.png> <out.bin>
python3 tools/r7_scan.py verify <fw>                # asserts a 0-diff round trip
```

## Pull, edit, re-encode

```sh
# 1. Pull the current animation (30 tiles as a vertical strip, plus rendered GIFs)
python3 tools/r7_scan.py pull R7_v153.150.127_db260702.bin scan_pull/

# 2. Edit scan_pull/tiles.png — it's a 11 x (8*30) image, one 11x8 tile per row (0..29).
#    Rows 0–4 = theme-0 states (empty→head), rows 25–29 = theme-5 states, etc.
#    Recolor the "head" tiles, repaint the trail, whatever you like — keep each tile 11x8.

# 3. Re-encode into a flashable firmware
python3 tools/r7_scan.py encode R7_v153.150.127_db260702.bin scan_pull/tiles.png R7_scan.bin
```

## The 0-diff guarantee

Tiles are uncompressed RGB565 and the ui_nu transpose is bijective, so `pull` → `encode` of the
**unchanged** tiles reproduces the firmware **byte-for-byte**:

```sh
python3 tools/r7_scan.py verify R7_v153.150.127_db260702.bin
# -> round-trip pull->encode: 0 DIFF ✓ (byte-identical firmware)
```

That means any change you make to `tiles.png` is exactly and only your change — nothing else in the
image moves. (The compressed choreography in `.data` is not modified.)

## Notes & limits

- The tile RGB565 → PNG → RGB565 conversion is exact (5/6/5-bit expansion and re-quantization
  round-trip losslessly), which is why `verify` reports **0 DIFF**.
- Changing the **motion** (the sweep pattern) rather than the **look** means editing the compressed
  choreography table — that requires re-implementing the LZSS packer (the decompressor is
  understood; see [FORMAT.md](FORMAT.md) §3) or hooking the renderer. Recoloring/redrawing the
  tiles gives you a lot without touching the choreography.
- Offsets (`0x29b6e`, the `.data` layout) are for `R7_v153.150.127`.
