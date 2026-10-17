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

These keys are verified for R7 only. R4W/R8W code remains opaque;
container parsing and raw extraction are supported for those models.
encode_old_model() is the verified byte-exact inverse (decode->encode == orig).

Usage:
    python3 rseries_unpack.py parse   <firmware.bin>
    python3 rseries_unpack.py extract <firmware.bin> [out_dir]   # decoded code sections
    python3 rseries_unpack.py encode  <section.bin> <ui_nu|dsp_nu|gps_nu> <out.bin>
"""
import sys, os, struct, math, collections
from pathlib import Path

SOUND_KEY = 225  # R7 ISD3800 payload and sound version footers (see rseries_sound.py)
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

MODEL_NAMES = {7: 'R7', 24: 'R4W', 28: 'R8W'}

class FirmwareFormatError(ValueError):
    """Invalid or unsupported container framing."""


def parse(buf, require_model=None):
    """Parse sections without guessing a decoder for an unknown model.

    Existing name/offset/length/term/version/key fields remain compatible with
    the R7 tools. Additional fields describe the model, framing and encoding.
    """
    files = []

    def need(off, length):
        if off < 0 or length < 0 or off + length > len(buf):
            raise FirmwareFormatError(f'truncated section at 0x{off:x}: need {length} bytes')

    def u32(off):
        need(off, 4)
        return struct.unpack_from('<I', buf, off)[0]

    def text(off, length):
        need(off, length)
        try:
            return bytes(buf[off:off + length]).decode('ascii')
        except UnicodeDecodeError as exc:
            raise FirmwareFormatError(f'invalid tag at 0x{off:x}') from exc

    def expect(off, tag):
        if text(off, len(tag)) != tag:
            raise FirmwareFormatError(f'expected {tag} at 0x{off:x}')

    def version(off):
        need(off, 2)
        mv = struct.unpack_from('<H', buf, off)[0]
        return mv >> 10, mv & 0x3ff

    def append(name, off, length, term, ver, key=None, encoding='opaque', **extra):
        need(off, length)
        files.append(dict(name=name, offset=off, length=length, term=term,
                          version=ver, key=key, encoding=encoding, **extra))

    first = u32(0)
    lengths = [first & 0xffffff, u32(4), u32(8)]
    pos = 12
    sound_len = 0
    if (first >> 24) & 1:
        expect(pos, 'SNDD')
        sound_len = u32(pos + 8)
        pos += 12
    model = None
    for name, declared, term in zip(CODE_KEYS, lengths, ('DRSWMAI', 'DRSWDSP', 'DRSWSUB')):
        if not declared:
            continue
        length = alter_length(declared)
        off = pos
        pos += length
        section_model, ver = version(pos)
        expect(pos + 2, term)
        if model is None:
            model = section_model
            if require_model is not None and model != require_model:
                raise FirmwareFormatError(
                    f'this editor requires {MODEL_NAMES.get(require_model, require_model)}; '
                    f'input is {MODEL_NAMES.get(model, model)}. Use rseries.py for inspection.')
        elif section_model != model:
            raise FirmwareFormatError(f'inconsistent model in {name} trailer')
        key = CODE_KEYS[name] if model == 7 else None
        append(name, off, length, term, ver, key,
               'transpose' if key is not None else 'opaque',
               declared_length=declared, model_id=model,
               model=MODEL_NAMES.get(model, f'unknown-{model}'))
        pos += 9
    if model is None:
        raise FirmwareFormatError('no main/DSP/GPS code sections; not a combined firmware image')
    if sound_len:
        if sound_len < 12:
            raise FirmwareFormatError('sound length is smaller than its footer')
        off = pos
        length = sound_len - 12
        need(off + length, 12)
        ver = int.from_bytes(decode_old_model(SOUND_KEY, buf[off + length:off + length + 4]), 'little') & 0x3ff
        pos += sound_len
        expect(pos, 'DRSWSDB')
        append('sound_dbnu', off, length, 'DRSWSDB', ver, SOUND_KEY, 'transpose',
               declared_length=sound_len, model_id=model)
        pos += 7
    while pos < len(buf):
        tag = text(pos, 4)
        declared = u32(pos + 8)
        cur = pos + 12
        if tag == 'NMGF':
            need(pos, 12)
            if cur != len(buf):
                raise FirmwareFormatError('unexpected bytes after NMGF footer')
            append('NMGF(footer)', pos, 12, '', declared, encoding='plaintext', model_id=model)
            pos = cur
        elif tag in ('GPSD', 'GASD'):
            if declared < 12:
                raise FirmwareFormatError(f'{tag} length is smaller than its footer')
            length = declared - 12
            end = cur + length
            ident = text(end + 8, 4)
            key = GPSDB_KEYS.get(ident)
            if ident not in GPSDB_KEYS and ident not in ('AEUS', 'AENZ', 'AEIL', 'AEEU'):
                raise FirmwareFormatError(f'unknown GPS database format {ident}')
            raw_count = bytes(buf[end:end + 4])
            count = int.from_bytes(decode_old_model(key, raw_count) if key is not None else raw_count, 'little')
            date = u32(end + 4)
            term = 'DRSWGDB' if tag == 'GPSD' else 'DRSWGAE'
            pos = end + 12 + (2 if tag == 'GASD' else 0)
            expect(pos, term)
            append(f'{tag}:{ident}', cur, length, ident, date, key,
                   'transpose' if key is not None else 'aes128',
                   declared_length=declared, poi_count=count, country={'LRDB': 'US', 'DFDB': 'NZ', 'IRDB': 'IL'}.get(ident, ident[-2:]), model_id=model)
            pos += 7
        elif tag in ('BLES', 'KEYS', 'LSRS', 'STUI', 'STDS', 'STGP', 'N2UI', 'N2DS', 'N3DS', 'N2GP', 'N3GP'):
            mod = 1024 if tag == 'BLES' else 512
            length = (declared // mod + 1) * mod
            end = cur + length
            component_model, ver = version(end)
            term = f'DRSW{tag[:3]}'
            expect(end + 2, term)
            encoding = 'esp-image' if tag == 'BLES' and buf[cur:cur + 1] == b'\xe9' else 'opaque'
            append(tag, cur, length, term, ver, encoding=encoding,
                   declared_length=declared, model_id=component_model)
            pos = end + 9
        elif tag in ('STSD', 'SUSD'):
            if declared < 12:
                raise FirmwareFormatError(f'{tag} length is smaller than its footer')
            length = declared - 12
            end = cur + length
            need(end, 12)
            # The footer's first word uses the legacy transform. This does not
            # establish the encoding or codec of the sound payload itself.
            ver = int.from_bytes(decode_old_model(SOUND_KEY, buf[end:end + 4]), 'little') & 0x3ff
            term = f'DRSW{tag[:3]}'
            pos = end + 12 + (2 if tag == 'SUSD' else 0)
            expect(pos, term)
            key = None  # STSD/SUSD payload codec and key are not established
            append(tag, cur, length, term, ver, key,
                   'transpose' if key is not None else 'opaque',
                   declared_length=declared, model_id=model)
            pos += 7
        else:
            raise FirmwareFormatError(f'unsupported section {tag!r} at 0x{pos:x}')
    if model in (24, 28) and files[-1]['name'] != 'NMGF(footer)':
        raise FirmwareFormatError('missing NMGF footer for wireless-model container')
    return files


def main(argv=None):
    import argparse
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    inspect = sub.add_parser('parse', help='inspect model, sections, versions and encodings')
    inspect.add_argument('firmware')
    inspect.add_argument('--json', action='store_true')
    extract = sub.add_parser('extract', help='extract supported decodings; preserve opaque payloads')
    extract.add_argument('firmware')
    extract.add_argument('out_dir', nargs='?', default='decoded')
    extract.add_argument('--raw', action='store_true', help='skip legacy decodings')
    encode = sub.add_parser('encode', help='encode a standalone R7 code payload')
    encode.add_argument('section_file')
    encode.add_argument('section', choices=CODE_KEYS)
    encode.add_argument('output')
    args = parser.parse_args(argv)
    try:
        if args.command == 'encode':
            data = Path(args.section_file).read_bytes()
            if len(data) % 4:
                raise FirmwareFormatError('encoding requires a multiple of four bytes')
            encoded = encode_old_model(CODE_KEYS[args.section], data)
            with open(args.output, 'wb') as fh:
                fh.write(encoded)
            print(f'encoded {len(data)} bytes -> {args.output}')
            return
        buf = Path(args.firmware).read_bytes()
        files = parse(buf)
        if args.command == 'parse':
            if args.json:
                print(json.dumps(files, indent=2))
            else:
                print(f'file: {args.firmware}  model={files[0]["model"]}  size={len(buf)}')
                print(f'{"section":16s} {"offset":>10s} {"length":>10s} {"version":>10s}  encoding')
                for f in files:
                    print(f'{f["name"]:16s} 0x{f["offset"]:08x} {f["length"]:10d} {f["version"]:10d}  {f["encoding"]}')
        else:
            os.makedirs(args.out_dir, exist_ok=True)
            for f in files:
                payload = buf[f['offset']:f['offset'] + f['length']]
                decoded = f['key'] is not None and not args.raw
                if decoded:
                    payload = decode_old_model(f['key'], payload)
                suffix = '.bin' if decoded and f['name'] in CODE_KEYS else ('.dec.bin' if decoded else '.raw.bin')
                filename = f['name'].replace(':', '_') + suffix
                path = os.path.join(args.out_dir, filename)
                with open(path, 'wb') as fh:
                    fh.write(payload)
                print(f'wrote {path} ({len(payload)} bytes; {f["encoding"]})')
    except (OSError, ValueError) as exc:
        parser.exit(2, f'error: {exc}\n')


if __name__ == '__main__':
    main()
