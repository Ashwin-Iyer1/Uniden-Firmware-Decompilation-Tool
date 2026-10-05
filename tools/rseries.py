#!/usr/bin/env python3
"""Inspect, extract and reproduce R-series update containers (R7, R4W, R8W).

Opaque code is preserved verbatim. Repacking verifies an unchanged extraction;
it does not create a modified or flash-tested firmware image.
"""
import argparse
import hashlib
import json
import re
import struct
from pathlib import Path

from rseries_unpack import FirmwareFormatError, decode_old_model, encode_old_model, parse


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def esp_image_info(data):
    """Validate ESP image segments, XOR checksum and optional appended SHA256.

    Layout: Espressif esptool firmware-image-format documentation. Addresses
    come directly from segment headers; no load-address guesses are needed.
    """
    if len(data) < 24 or data[0] != 0xe9 or not 1 <= data[1] <= 16:
        raise FirmwareFormatError('invalid ESP image header')
    chip_id = struct.unpack_from('<H', data, 12)[0]
    segments = []
    pos = 24
    checksum = 0xef
    for i in range(data[1]):
        if pos + 8 > len(data):
            raise FirmwareFormatError('truncated ESP segment header')
        address, length = struct.unpack_from('<II', data, pos)
        pos += 8
        if length > len(data) - pos:
            raise FirmwareFormatError('truncated ESP segment payload')
        payload = data[pos:pos + length]
        for value in payload:
            checksum ^= value
        segments.append(dict(index=i, load_address=address, offset=pos,
                             length=length, sha256=sha256(payload)))
        pos += length
    checksum_offset = pos | 15
    if checksum_offset >= len(data) or any(data[pos:checksum_offset]):
        raise FirmwareFormatError('invalid ESP checksum padding')
    if data[checksum_offset] != checksum:
        raise FirmwareFormatError('ESP checksum mismatch')
    image_size = checksum_offset + 1
    if data[23] not in (0, 1):
        raise FirmwareFormatError('invalid ESP appended-hash flag')
    if data[23]:
        if data[image_size:image_size + 32] != hashlib.sha256(data[:image_size]).digest():
            raise FirmwareFormatError('ESP appended SHA256 mismatch')
        image_size += 32
    result = dict(chip_id=chip_id, chip='ESP32-C3' if chip_id == 5 else f'unknown-{chip_id}',
                  entry_point=struct.unpack_from('<I', data, 4)[0],
                  image_size=image_size, checksum=checksum, checksum_valid=True,
                  hash_appended=bool(data[23]), segments=segments)
    # ESP-IDF esp_app_desc_t starts at the first segment, when present.
    first = segments[0]
    off = first['offset']
    if first['length'] >= 256 and data[off:off + 4] == b'\x32\x54\xcd\xab':
        def string(relative, length):
            return data[off + relative:off + relative + length].split(b'\0', 1)[0].decode('ascii', 'replace')
        result['app'] = dict(version=string(16, 32), project_name=string(48, 32),
                             build_time=string(80, 16), build_date=string(96, 16),
                             idf_version=string(112, 32),
                             elf_sha256=data[off + 144:off + 176].hex())
    return result


def inspect_image(buf):
    sections = parse(buf)
    for f in sections:
        payload = buf[f['offset']:f['offset'] + f['length']]
        f['sha256'] = sha256(payload)
        if f['encoding'] == 'esp-image':
            f['esp'] = esp_image_info(payload)
    return dict(schema=1, model=sections[0]['model'], size=len(buf),
                sha256=sha256(buf), sections=sections)


def extract_image(buf, out_dir):
    """Save every original byte, plus separately named supported decodings."""
    out_dir = Path(out_dir)
    if out_dir.exists() and any(out_dir.iterdir()):
        raise FirmwareFormatError('extraction directory must be empty')
    manifest = inspect_image(buf)
    out_dir.mkdir(parents=True, exist_ok=True)
    pieces = []
    pos = 0

    def save(start, end, name):
        payload = buf[start:end]
        filename = f'{len(pieces):02d}-{name}.raw.bin'
        (out_dir / filename).write_bytes(payload)
        pieces.append(dict(file=filename, offset=start, length=len(payload), sha256=sha256(payload)))

    for f in manifest['sections']:
        off, length = f['offset'], f['length']
        name = re.sub(r'[^A-Za-z0-9_-]', '_', f['name'])
        if off > pos:
            save(pos, off, 'framing')
        save(off, off + length, name)
        f['raw_file'] = pieces[-1]['file']
        payload = buf[off:off + length]
        if f['key'] is not None:
            decoded = decode_old_model(f['key'], payload)
            if encode_old_model(f['key'], decoded) != payload:
                raise FirmwareFormatError(f'{f["name"]} decode round-trip failed')
            f['decoded_file'] = f'{name}.dec.bin'
            (out_dir / f['decoded_file']).write_bytes(decoded)
        if 'esp' in f:
            for segment in f['esp']['segments']:
                filename = f'{name}-segment-{segment["index"]:02d}-0x{segment["load_address"]:08x}.bin'
                start = segment['offset']
                (out_dir / filename).write_bytes(payload[start:start + segment['length']])
                segment['file'] = filename
        pos = off + length
    if pos < len(buf):
        save(pos, len(buf), 'framing')
    manifest['pieces'] = pieces
    (out_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def repack_image(out_dir):
    """Reproduce an unchanged image; reject altered pieces or invalid framing."""
    out_dir = Path(out_dir).resolve()
    manifest = json.loads((out_dir / 'manifest.json').read_text())
    if manifest.get('schema') != 1:
        raise FirmwareFormatError('unsupported extraction manifest schema')
    result = bytearray()
    for piece in manifest['pieces']:
        path = (out_dir / piece['file']).resolve()
        if path.parent != out_dir:
            raise FirmwareFormatError('manifest piece must be a file inside the extraction directory')
        payload = path.read_bytes()
        if piece['offset'] != len(result) or piece['length'] != len(payload):
            raise FirmwareFormatError('non-contiguous or resized extraction piece')
        if sha256(payload) != piece['sha256']:
            raise FirmwareFormatError(f'changed extraction piece: {piece["file"]}')
        result.extend(payload)
    result = bytes(result)
    if len(result) != manifest['size'] or sha256(result) != manifest['sha256']:
        raise FirmwareFormatError('repacked image differs from original SHA256')
    inspect_image(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    inspect = sub.add_parser('inspect')
    inspect.add_argument('firmware', type=Path)
    inspect.add_argument('--json', action='store_true')
    extract = sub.add_parser('extract')
    extract.add_argument('firmware', type=Path)
    extract.add_argument('out_dir', type=Path)
    repack = sub.add_parser('repack', help='reproduce the unchanged original; verify hashes')
    repack.add_argument('out_dir', type=Path)
    repack.add_argument('output', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'repack':
            result = repack_image(args.out_dir)
            with args.output.open('xb') as fh:
                fh.write(result)
            print(f'reproduced {len(result)} bytes; SHA256 {sha256(result)} -> {args.output}')
            return
        buf = args.firmware.read_bytes()
        if args.command == 'extract':
            manifest = extract_image(buf, args.out_dir)
            print(f'extracted {manifest["model"]}: {len(manifest["sections"])} sections -> {args.out_dir}')
            print('Opaque payloads preserved; manifest and validated ESP segments included.')
            return
        result = inspect_image(buf)
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print(f'{result["model"]}: {result["size"]} bytes; SHA256 {result["sha256"]}')
            print(f'{"section":16s} {"offset":>10s} {"length":>10s} {"version":>10s}  encoding')
            for f in result['sections']:
                print(f'{f["name"]:16s} 0x{f["offset"]:08x} {f["length"]:10d} {f["version"]:10d}  {f["encoding"]}')
                if 'poi_count' in f:
                    print(f'  {f["poi_count"]} POIs; country={f["country"]}')
                if 'esp' in f:
                    esp = f['esp']
                    print(f'  {esp["chip"]}; entry=0x{esp["entry_point"]:08x}; {len(esp["segments"])} segments; checksum OK')
                    if 'app' in esp:
                        print(f'  ESP-IDF {esp["app"]["idf_version"]}; built {esp["app"]["build_date"]} {esp["app"]["build_time"]}')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(2, f'error: {exc}\n')


if __name__ == '__main__':
    main()
