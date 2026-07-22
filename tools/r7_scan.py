#!/usr/bin/env python3
"""
Uniden R7 "Scan" main-display animation — pull / render / encode (round-trips 0-diff).

The scan animation (FUN_000058dc, driver FUN_00009268) is data-driven:
  - 30 tiles, 11x8 RGB565, contiguous in ui_nu flash at internal 0x29b6e (176 B each).
    6 color themes x 5 states (0=empty .. 4=bright head).
  - choreography framedata[20][8] (tile index per cell per frame) lives in the
    LZSS-compressed .data image (flash 0x2f7ac -> SRAM 0x20000000). Read-only here.

Each frame draws 8 cells (11x8) at screen (76,37); theme picks colorset 0 (even) or 5 (odd).

The tiles are the editable visual content. decode(ui_nu)->tiles->encode(ui_nu) is a
bijection, so re-encoding unchanged tiles reproduces the firmware byte-for-byte (0 diff).

Usage:
    python3 r7_scan.py pull   <firmware.bin> <out_dir>     # tiles.png + frames GIFs + framedata.txt
    python3 r7_scan.py encode <firmware.bin> <tiles.png> <out.bin>
    python3 r7_scan.py verify <firmware.bin>               # assert 0-diff round trip
"""
import sys, os, struct
from PIL import Image
from r7_unpack import decode_old_model, encode_old_model, parse

UI_KEY = 182
TILE_BASE = 0x29b6e        # ui_nu-internal flash offset of tile 0
TILE_W, TILE_H = 11, 8
TILE_BYTES = TILE_W * TILE_H * 2   # 176 (RGB565)
N_TILES = 30
DATA_LMA, DATA_LEN = 0x2f7ac, 0x514
FD_OFF = 0x298             # framedata offset within decompressed .data

def ui_span(buf):
    for f in parse(buf):
        if f['name'] == 'ui_nu':
            return f['offset'], f['length']
    raise SystemExit("ui_nu not found")

def decompress(src, off, out_len):        # FUN_00000488 (custom LZSS)
    dst = bytearray(); i = off
    while len(dst) < out_len:
        c = src[i]; i += 1
        L = c & 7
        if L == 0: L = src[i]; i += 1
        M = c >> 4
        if M == 0: M = src[i]; i += 1
        for _ in range(L - 1): dst.append(src[i]); i += 1
        if c & 8:
            o = src[i]; i += 1; s = len(dst) - o
            for k in range(M + 2): dst.append(dst[s + k])
        else:
            dst.extend(b'\x00' * M)
    return bytes(dst[:out_len])

def rgb565_to_rgb(v):
    return ((v >> 11 & 0x1f) << 3, (v >> 5 & 0x3f) << 2, (v & 0x1f) << 3)

def rgb_to_565(r, g, b):
    return ((r >> 3) << 11) | ((g >> 3) << 5) | (b >> 3)   # note: g uses 5 bits back via >>3<<2? see below

def tile_to_img(ui, addr):
    im = Image.new('RGB', (TILE_W, TILE_H))
    im.putdata([rgb565_to_rgb(ui[addr + p*2] | (ui[addr + p*2 + 1] << 8)) for p in range(TILE_W*TILE_H)])
    return im

def img_to_tile(im):
    out = bytearray()
    for (r, g, b) in im.convert('RGB').getdata():
        v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)   # exact inverse of rgb565_to_rgb
        out += struct.pack('<H', v)
    return bytes(out)

def load_ui(buf):
    off, length = ui_span(buf)
    # decode a bit beyond nominal length so the compressed .data tail is fully present
    return decode_old_model(UI_KEY, buf[off:off + max(length, 0x30000)]), off, length

def read_framedata(ui):
    data = decompress(ui, DATA_LMA, DATA_LEN)
    return [[data[FD_OFF + f*8 + c] for c in range(8)] for f in range(20)]

def read_tiles(ui):
    return [tile_to_img(ui, TILE_BASE + i*TILE_BYTES) for i in range(N_TILES)]

def sheet_from_tiles(tiles):
    sh = Image.new('RGB', (TILE_W, TILE_H * N_TILES))
    for i, t in enumerate(tiles):
        sh.paste(t, (0, i*TILE_H))
    return sh

def tiles_from_sheet(sh):
    return [sh.crop((0, i*TILE_H, TILE_W, (i+1)*TILE_H)) for i in range(N_TILES)]

def render_gif(tiles, fd, colorset, path, scale=6):
    frames = []
    for f in range(20):
        im = Image.new('RGB', (TILE_W*8, TILE_H))
        for c in range(8):
            im.paste(tiles[colorset*5 + fd[f][c]], (c*TILE_W, 0))
        frames.append(im.resize((TILE_W*8*scale, TILE_H*scale), Image.NEAREST))
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=90, loop=0)

def pull(fw, outdir):
    buf = open(fw, 'rb').read()
    ui, _, _ = load_ui(buf)
    tiles = read_tiles(ui); fd = read_framedata(ui)
    os.makedirs(outdir, exist_ok=True)
    sheet_from_tiles(tiles).save(os.path.join(outdir, 'tiles.png'))
    render_gif(tiles, fd, 0, os.path.join(outdir, 'scan_theme0.gif'))
    render_gif(tiles, fd, 5, os.path.join(outdir, 'scan_theme5.gif'))
    with open(os.path.join(outdir, 'framedata.txt'), 'w') as fh:
        for f in range(20):
            fh.write("frame %2d: %s\n" % (f, fd[f]))
    print(f"pulled {N_TILES} tiles + 20-frame choreography -> {outdir}/ (tiles.png, scan_theme0/5.gif, framedata.txt)")

def encode(fw, sheet_png, out):
    buf = open(fw, 'rb').read()
    off, length = ui_span(buf)
    ui = bytearray(decode_old_model(UI_KEY, buf[off:off + length]))
    tiles = tiles_from_sheet(Image.open(sheet_png))
    for i, t in enumerate(tiles):
        tb = img_to_tile(t)
        assert len(tb) == TILE_BYTES
        ui[TILE_BASE + i*TILE_BYTES: TILE_BASE + i*TILE_BYTES + TILE_BYTES] = tb
    enc = encode_old_model(UI_KEY, bytes(ui))
    assert len(enc) == length
    open(out, 'wb').write(buf[:off] + enc + buf[off+length:])
    print(f"encoded {N_TILES} tiles -> {out}")

def verify(fw):
    buf = open(fw, 'rb').read()
    ui, off, length = load_ui(buf)
    tiles = read_tiles(ui)
    # re-encode tiles unchanged back into a fresh ui_nu copy
    ui2 = bytearray(decode_old_model(UI_KEY, buf[off:off+length]))
    for i, t in enumerate(tiles):
        ui2[TILE_BASE + i*TILE_BYTES: TILE_BASE + i*TILE_BYTES + TILE_BYTES] = img_to_tile(t)
    rebuilt = buf[:off] + encode_old_model(UI_KEY, bytes(ui2)) + buf[off+length:]
    same = rebuilt == buf
    diffs = 0 if same else sum(1 for a, b in zip(rebuilt, buf) if a != b)
    print(f"round-trip pull->encode: {'0 DIFF ✓ (byte-identical firmware)' if same else f'{diffs} bytes differ ✗'}")
    return same

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    cmd = sys.argv[1]
    if cmd == 'pull':     pull(sys.argv[2], sys.argv[3])
    elif cmd == 'encode': encode(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == 'verify': sys.exit(0 if verify(sys.argv[2]) else 1)
    else: print(__doc__); sys.exit(1)
