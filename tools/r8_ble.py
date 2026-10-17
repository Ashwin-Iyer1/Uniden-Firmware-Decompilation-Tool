#!/usr/bin/env python3
"""Inspect/extract a plaintext R8 BLES payload without decoding opaque controllers.

The interpretation is restricted to the observed DA14585 RAM layout. A tag alone
is not evidence of a valid component: length, trailer and vectors must agree.
"""
import argparse
from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import struct

BASE = 0x07FC0000
RAM_END = 0x07FD0000
TRAILER = b'DRSWBLE'


@dataclass(frozen=True)
class Component:
    header_offset: int
    payload_offset: int
    payload_length: int
    stored_length: int
    version: int
    initial_sp: int
    reset_vector: int
    image_base: int = BASE


def find_components(data):
    """Return structurally validated candidates; do not silently choose ambiguity."""
    components = []
    position = 0
    while True:
        header = data.find(b'BLES', position)
        if header < 0:
            break
        position = header + 4
        if header + 12 > len(data):
            continue
        length = struct.unpack_from('<I', data, header+8)[0]
        offset = header+12
        stored = (length//1024+1)*1024
        end = offset+stored
        if length < 64 or length > RAM_END-BASE or end+9 > len(data):
            continue
        if data[end+2:end+9] != TRAILER:
            continue
        sp, reset = struct.unpack_from('<II', data, offset)
        if sp % 8 or not BASE < sp <= RAM_END:
            continue
        if not reset & 1 or not BASE <= (reset & ~1) < BASE+length:
            continue
        # Core exception vectors may be zero (reserved); nonzero handlers must
        # be Thumb addresses in the declared payload, rather than padding.
        vectors = struct.unpack_from('<16I', data, offset)
        if any(v and (not v & 1 or not BASE <= (v & ~1) < BASE+length)
               for v in vectors[2:]):
            continue
        if data[offset+length:end] != b'\xff'*(stored-length):
            continue
        version = struct.unpack_from('<H', data, end)[0] & 0x3ff
        components.append(Component(header, offset, length, stored, version, sp, reset))
    return components


def select_component(data):
    components = find_components(data)
    if len(components) != 1:
        raise ValueError(f'Expected one validated BLES component; found {len(components)}')
    return components[0]


def inspect(data):
    component = select_component(data)
    payload = data[component.payload_offset:component.payload_offset+component.payload_length]
    return {
        'input_sha256': hashlib.sha256(data).hexdigest(),
        'component': asdict(component),
        'payload_sha256': hashlib.sha256(payload).hexdigest(),
        'validation': ['BLES header and bounded declared length', '1024-byte stored extent',
                       'DRSWBLE trailer', 'FF padding', 'DA14585 RAM stack pointer',
                       'Thumb reset and core exception vectors inside declared payload'],
        'limitations': ['Static layout validation does not prove runtime behavior or integrity checks.',
                        'This does not decode main/DSP/GPS controller images or the AEUS database.',
                        'Other BLE chip layouts are unsupported, not guessed.'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['inspect', 'extract'])
    parser.add_argument('firmware', type=Path)
    parser.add_argument('--output', type=Path, help='New output file for the unpadded payload')
    args = parser.parse_args()
    if args.operation == 'extract' and args.output is None:
        parser.error('extract requires --output')
    if args.operation == 'inspect' and args.output is not None:
        parser.error('--output is only accepted for extract')
    try:
        data = args.firmware.read_bytes()
        report = inspect(data)
        if args.operation == 'extract':
            component = select_component(data)
            # Exclusive creation protects source/previous output, including
            # aliases and symlinks, without a separate existence-check race.
            with args.output.open('xb') as handle:
                handle.write(data[component.payload_offset:component.payload_offset+component.payload_length])
        print(json.dumps(report, indent=2))
    except (OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
