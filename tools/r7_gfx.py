#!/usr/bin/env python3
"""
Uniden R7 graphics tool — render / replace display bitmaps in ui_nu.

Display is 176x60. Three pixel formats (from the blitters):
  1bpp  (FUN_00005690)  1 bit/pixel,  row stride = ceil(w/8) bytes
  2bpp  (FUN_000056dc)  2 bits/pixel, row stride = ceil(w/4) bytes  (4 shades)
  565   (FUN_00009d9c)  16 bit/pixel little-endian RGB565

Asset addresses are ui_nu DECODED offsets. Replacing keeps byte length identical.

Usage:
  python3 r7_gfx.py render  <fw.bin> <hex_off> <w> <h> <1bpp|2bpp|565> <out.png>
  python3 r7_gfx.py replace <fw.bin> <hex_off> <w> <h> <1bpp|2bpp|565> <in.png> <out.bin>
"""
import sys
from PIL import Image
from r7_unpack import decode_old_model, encode_old_model, parse

UI_KEY = 182
RAMP = [0, 90, 180, 255]   # 2bpp shade -> gray

def ui_region(buf):
    for f in parse(buf):
        if f['name'] == 'ui_nu':
            return f['offset'], f['length']
    raise SystemExit("ui_nu not found")

def asset_len(w, h, fmt):
    if fmt == '1bpp': return ((w + 7)//8) * h
    if fmt == '2bpp': return ((w + 3)//4) * h
    if fmt == '565':  return w * h * 2
    raise SystemExit("format must be 1bpp|2bpp|565")

def decode_img(data, w, h, fmt):
    img = Image.new('RGB', (w, h))
    px = []
    if fmt == '565':
        for i in range(0, w*h*2, 2):
            v = data[i] | (data[i+1] << 8)
            px.append((((v>>11)&0x1f)<<3, ((v>>5)&0x3f)<<2, (v&0x1f)<<3))
    else:
        bits = 1 if fmt == '1bpp' else 2
        stride = (w+7)//8 if fmt == '1bpp' else (w+3)//4
        mask = (1<<bits) - 1
        ppb = 8 // bits                      # pixels per byte
        for row in range(h):
            for col in range(w):
                byte = data[row*stride + col//ppb]
                shift = (ppb - 1 - (col % ppb)) * bits   # MSB-first (leftmost = high bits)
                val = (byte >> shift) & mask
                g = 255*val if fmt == '1bpp' else RAMP[val]
                px.append((g, g, g))
    img.putdata(px[:w*h])
    return img

def encode_img(img, w, h, fmt):
    img = img.convert('RGB').resize((w, h))
    px = list(img.getdata())
    if fmt == '565':
        out = bytearray()
        for r, g, b in px:
            v = ((r>>3)<<11) | ((g>>2)<<5) | (b>>3)
            out += bytes((v & 0xff, (v>>8) & 0xff))
        return bytes(out)
    bits = 1 if fmt == '1bpp' else 2
    stride = (w+7)//8 if fmt == '1bpp' else (w+3)//4
    ppb = 8 // bits
    out = bytearray(stride*h)
    for row in range(h):
        for col in range(w):
            r, g, b = px[row*w+col]
            lum = (r+g+b)//3
            val = (1 if lum >= 128 else 0) if fmt == '1bpp' else min(3, lum*4//256)
            shift = (ppb - 1 - (col % ppb)) * bits    # MSB-first (matches device)
            out[row*stride + col//ppb] |= val << shift
    return bytes(out)

def render(fw, off, w, h, fmt, out_png):
    buf = open(fw, 'rb').read()
    uo, ul = ui_region(buf)
    ui = decode_old_model(UI_KEY, buf[uo:uo+ul])
    n = asset_len(w, h, fmt)
    img = decode_img(ui[off:off+n], w, h, fmt)
    img.resize((w*4, h*4), Image.NEAREST).save(out_png)
    print(f"rendered {fmt} {w}x{h} @0x{off:x} ({n} bytes) -> {out_png}")

def replace(fw, off, w, h, fmt, in_png, out_bin):
    buf = open(fw, 'rb').read()
    uo, ul = ui_region(buf)
    ui = bytearray(decode_old_model(UI_KEY, buf[uo:uo+ul]))
    new = encode_img(Image.open(in_png), w, h, fmt)
    assert len(new) == asset_len(w, h, fmt)
    ui[off:off+len(new)] = new
    enc = encode_old_model(UI_KEY, bytes(ui))
    assert len(enc) == ul
    open(out_bin, 'wb').write(buf[:uo] + enc + buf[uo+ul:])
    print(f"replaced {fmt} {w}x{h} @0x{off:x} ({len(new)} bytes) -> {out_bin}")

if __name__ == '__main__':
    a = sys.argv
    if len(a) < 7:
        print(__doc__); sys.exit(1)
    if a[1] == 'render':
        render(a[2], int(a[3], 16), int(a[4]), int(a[5]), a[6], a[7])
    elif a[1] == 'replace':
        replace(a[2], int(a[3], 16), int(a[4]), int(a[5]), a[6], a[7], a[8])
    else:
        print(__doc__); sys.exit(1)
