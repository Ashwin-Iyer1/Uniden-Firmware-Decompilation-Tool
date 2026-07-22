#!/usr/bin/env python3
"""
Uniden R7 firmware patcher — edit a decoded code section and reassemble a full
flashable firmware. In-place only (byte length preserved), so no offsets shift and
every other section stays byte-identical to stock.

Section names: ui_nu | dsp_nu | gps_nu

Usage:
    # replace a null-terminated string at a decoded-section offset (must fit its field)
    python3 r7_patch.py setstr <fw.bin> <section> <hex_offset> "<new text>" <out.bin>

    # apply raw byte patches from a file (lines: "<hex_offset> <hex_bytes>")
    python3 r7_patch.py patch  <fw.bin> <section> <patchfile> <out.bin>

    # show the string currently at an offset (and its editable field size)
    python3 r7_patch.py showstr <fw.bin> <section> <hex_offset>
"""
import sys
from r7_unpack import decode_old_model, encode_old_model, parse

def get_section(buf, name):
    for f in parse(buf):
        if f['name'] == name:
            return f['offset'], f['length'], f['key']
    raise SystemExit(f"section {name} not found")

def field_size(dec, off):
    """bytes available at off = string chars + trailing NUL padding before next data."""
    end = dec.index(0, off)
    p = end
    while p < len(dec) and dec[p] == 0:
        p += 1
    return p - off, end - off   # (field_total, current_str_len)

def reassemble(buf, name, dec):
    off, length, key = get_section(buf, name)
    enc = encode_old_model(key, dec)
    assert len(enc) == length, (len(enc), length)
    return buf[:off] + enc + buf[off+length:]

def setstr(fw, name, off, text, out):
    buf = open(fw, 'rb').read()
    s_off, length, key = get_section(buf, name)
    dec = bytearray(decode_old_model(key, buf[s_off:s_off+length]))
    total, cur = field_size(dec, off)
    new = text.encode('latin1')
    if len(new) + 1 > total:
        raise SystemExit(f"'{text}' needs {len(new)+1} bytes but field at 0x{off:x} is only {total} "
                         f"(current string '{dec[off:off+cur].decode('latin1')}' = {cur})")
    old = decode_old_model(key, buf[s_off:s_off+length])[off:off+cur].decode('latin1', 'replace')
    dec[off:off+total] = new + b'\x00' * (total - len(new))   # keep field size, NUL-fill
    open(out, 'wb').write(reassemble(buf, name, bytes(dec)))
    print(f"{name} @0x{off:x}: '{old}' -> '{text}'  (field {total}B)  wrote {out}")

def showstr(fw, name, off):
    buf = open(fw, 'rb').read()
    s_off, length, key = get_section(buf, name)
    dec = decode_old_model(key, buf[s_off:s_off+length])
    total, cur = field_size(dec, off)
    print(f"{name} @0x{off:x}: '{dec[off:off+cur].decode('latin1','replace')}'  "
          f"string={cur} chars, editable field={total} bytes (max {total-1} chars)")

def patch(fw, name, patchfile, out):
    buf = open(fw, 'rb').read()
    s_off, length, key = get_section(buf, name)
    dec = bytearray(decode_old_model(key, buf[s_off:s_off+length]))
    n = 0
    for line in open(patchfile):
        line = line.split('#')[0].strip()
        if not line:
            continue
        off_s, bytes_s = line.split()
        off = int(off_s, 16)
        b = bytes.fromhex(bytes_s)
        dec[off:off+len(b)] = b
        n += 1
        print(f"  patched 0x{off:x}: {b.hex()}")
    open(out, 'wb').write(reassemble(buf, name, bytes(dec)))
    print(f"applied {n} patches -> {out}")

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__); sys.exit(1)
    cmd = sys.argv[1]
    if cmd == 'setstr':
        setstr(sys.argv[2], sys.argv[3], int(sys.argv[4], 16), sys.argv[5], sys.argv[6])
    elif cmd == 'showstr':
        showstr(sys.argv[2], sys.argv[3], int(sys.argv[4], 16))
    elif cmd == 'patch':
        patch(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
    else:
        print(__doc__); sys.exit(1)
