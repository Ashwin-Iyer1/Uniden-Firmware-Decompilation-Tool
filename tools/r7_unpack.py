#!/usr/bin/env python3
"""
Uniden R-series firmware container tool: parse / decode / extract / re-encode.

Container layout and the "old" transform (2-bit-plane transpose across each
4-byte group, then subtract a per-section key mod 256) are derived from
AngeloD2022/uniden-firmware-tool (AGPL-3.0) plus this project's own work.

New here: the code sections (ui_nu / dsp_nu / gps_nu) use the SAME transpose as
Sound/GPS-DB -- upstream left them "not reverse engineered". Their subtract keys
were recovered by maximizing ARM Thumb-2 disassembly validity:

    ui_nu  -> 182 (0xB6)   dsp_nu -> 184 (0xB8)   gps_nu -> 183 (0xB7)

All three decode to ARM Cortex-M images, base 0x00000000, little-endian.
encode_old_model() is the verified byte-exact inverse (decode->encode == orig).

Usage:
    python3 r7_unpack.py parse   <firmware.bin>
    python3 r7_unpack.py extract <firmware.bin> [out_dir]   # decoded code sections
    python3 r7_unpack.py encode  <section.bin> <ui_nu|dsp_nu|gps_nu> <out.bin>
"""
import sys, os, struct, math, collections

SOUND_KEY = 255
GPSDB_KEYS = {'LRDB': 210, 'DFDB': 194, 'IRDB': 226}   # US / NZ / IL
CODE_KEYS  = {'ui_nu': 182, 'dsp_nu': 184, 'gps_nu': 183}

def entropy(b):
    if not b: return 0.0
    c = collections.Counter(b); n = len(b)
    return -sum((v/n)*math.log2(v/n) for v in c.values())

def alter_length(length):
    return ((length // 512) + 1) * 512 if length != 0 else 0

def decode_old_model(key, data, offset=0, length=None):
    """Transpose 2-bit planes across each 4-byte group, then subtract key."""
    if length is None:
        length = len(data) - offset
    length &= ~3
    buf = bytearray(length)
    for i in range(0, length, 4):
        d0 = data[i+offset]; d1 = data[i+1+offset]; d2 = data[i+2+offset]; d3 = data[i+3+offset]
        buf[i]   = ( d0 & 0x03      ) | ((d1 & 0x03) << 2) | ((d2 & 0x03) << 4) | ((d3 & 0x03) << 6)
        buf[i+1] = ((d0 & 0x0C) >> 2) | ( d1 & 0x0C      ) | ((d2 & 0x0C) << 2) | ((d3 & 0x0C) << 4)
        buf[i+2] = ((d0 & 0x30) >> 4) | ((d1 & 0x30) >> 2) | ( d2 & 0x30      ) | ((d3 & 0x30) << 2)
        buf[i+3] = ((d0 & 0xC0) >> 6) | ((d1 & 0xC0) >> 4) | ((d2 & 0xC0) >> 2) | ( d3 & 0xC0      )
        for k in range(4):
            buf[i+k] = (buf[i+k] - key) & 0xFF
    return bytes(buf)

def encode_old_model(key, data):
    """Inverse of decode_old_model: add key, then inverse transpose."""
    length = len(data) & ~3
    tmp = bytes((b + key) & 0xFF for b in data)
    out = bytearray(length)
    for i in range(0, length, 4):
        d = [0, 0, 0, 0]
        for j in range(4):          # reconstruct source byte d[j]
            for p in range(4):      # output byte p carries d[j]'s bit-pair j
                d[j] |= ((tmp[i+p] >> (2*j)) & 3) << (2*p)
        out[i:i+4] = bytes(d)
    return bytes(out)

def parse(buf):
    """Return list of dicts: name, offset, length, term, version, key."""
    files = []
    def u32(p): return struct.unpack_from('<I', buf, p)[0]

    first = u32(0)
    ui_nu_len  = alter_length(first & 0xFFFFFF)
    has_sound  = (first >> 24) & 1
    dsp_nu_len = alter_length(u32(4))
    gps_nu_len = alter_length(u32(8))
    pos = 12
    sound_len = 0
    if has_sound:
        sound_len = u32(pos + 8)
        pos += 12

    def take(length, name):
        nonlocal pos
        off = pos
        pos += length
        mv = struct.unpack_from('<h', buf, pos)[0]
        version = mv & 0x3FF
        term = buf[pos+2:pos+9].decode('latin1', 'replace')
        pos += 9
        files.append(dict(name=name, offset=off, length=length, term=term,
                          version=version, key=CODE_KEYS[name]))

    if ui_nu_len:  take(ui_nu_len,  'ui_nu')
    if dsp_nu_len: take(dsp_nu_len, 'dsp_nu')
    if gps_nu_len: take(gps_nu_len, 'gps_nu')
    if sound_len:
        off = pos
        pos += sound_len          # payload (sound_len-12) + 12B version trailer
        term = buf[pos:pos+7].decode('latin1', 'replace'); pos += 7
        files.append(dict(name='sound_dbnu', offset=off, length=sound_len-12,
                          term=term, version=0, key=SOUND_KEY))

    while pos < len(buf) - 12:
        tag = buf[pos:pos+4].decode('latin1', 'replace')
        clen = u32(pos+8); cur = pos + 12
        if tag in ('GPSD', 'GASD'):
            body = cur; end = cur + (clen - 12)
            ident = buf[end+8:end+12].decode('latin1', 'replace')
            files.append(dict(name=f'{tag}:{ident}', offset=body, length=clen-12,
                              term=ident, version=0, key=GPSDB_KEYS.get(ident, 0)))
            pos = end + 12 + (2 if tag == 'GASD' else 0) + 7
        elif tag in ('BLES','KEYS','LSRS','STUI','STDS','STGP','N2UI','N2DS','N3DS','N2GP','N3GP'):
            mod = 1024 if tag == 'BLES' else 512
            length = (clen // mod + 1) * mod
            off = cur; pos = cur + length
            term = buf[pos+2:pos+9].decode('latin1', 'replace'); pos += 9
            files.append(dict(name=tag, offset=off, length=length, term=term, version=0, key=None))
        elif tag in ('STSD', 'SUSD'):
            off = cur; pos = cur + (clen - 12) + (2 if tag == 'SUSD' else 0) + 7
            files.append(dict(name=tag, offset=off, length=clen-12, term='', version=0, key=SOUND_KEY))
        elif tag == 'NMGF':
            files.append(dict(name='NMGF(footer)', offset=pos, length=12, term='', version=u32(pos+8), key=None))
            break
        else:
            step = (clen if tag[2:4] == 'SD' else alter_length(clen)) + 9
            pos = cur + step - 12
    return files

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    cmd = sys.argv[1]
    if cmd == 'encode':
        data = open(sys.argv[2], 'rb').read()
        key = CODE_KEYS[sys.argv[3]]
        open(sys.argv[4], 'wb').write(encode_old_model(key, data))
        print(f"encoded {len(data)} bytes with key {key} -> {sys.argv[4]}")
        return
    buf = open(sys.argv[2], 'rb').read()
    files = parse(buf)
    if cmd == 'parse':
        print(f"file: {sys.argv[2]}  size={len(buf)} (0x{len(buf):x})\n")
        print(f"{'section':16s} {'offset':>10s} {'length':>10s} {'term':10s} {'ver':>4s} {'key':>4s}  entropy")
        for f in files:
            e = entropy(buf[f['offset']:f['offset']+f['length']])
            k = '' if f['key'] is None else str(f['key'])
            print(f"{f['name']:16s} 0x{f['offset']:08x} {f['length']:10d} {f['term']:10s} {f['version']:4d} {k:>4s}  {e:.3f}")
    elif cmd == 'extract':
        out = sys.argv[3] if len(sys.argv) > 3 else 'decoded'
        os.makedirs(out, exist_ok=True)
        for f in files:
            payload = buf[f['offset']:f['offset']+f['length']]
            key = f['key']
            name = f['name']
            if key is not None and name in CODE_KEYS:
                payload = decode_old_model(key, payload)
                fn = f"{name}.bin"
            elif key is not None and key != 0:
                payload = decode_old_model(key, payload)
                fn = f"{name.replace(':','_')}.dec.bin"
            else:
                fn = f"{name.replace(':','_')}.raw.bin"
            open(os.path.join(out, fn), 'wb').write(payload)
            print(f"  wrote {out}/{fn}  ({len(payload)} bytes)")

if __name__ == '__main__':
    main()
