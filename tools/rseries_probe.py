#!/usr/bin/env python3
"""Read-only block statistics and conservative Cortex-M decoding probes.

Reports observations, not a cipher identification or a verified decoder.
No firmware output is produced. See docs/FIRMWARE_FINDINGS.md.
"""
import argparse
import collections
import json
import struct
from pathlib import Path

from rseries_unpack import decode_old_model, entropy, parse


def block_stats(data, width):
    blocks = [data[i:i + width] for i in range(0, len(data) - width + 1, width)]
    counts = collections.Counter(blocks)
    return dict(width=width, blocks=len(blocks), unique=len(counts),
                repeated_occurrences=sum(n - 1 for n in counts.values()),
                most_common=[dict(hex=b.hex(), count=n) for b, n in counts.most_common(3)])


def vector_candidate(data, image_length):
    """Necessary checks under conventional SRAM/flash assumptions, not proof.

    Targets Cortex-M with SRAM at 0x20000000 and code at 0 or 0x08000000.
    Images using a different address map will not be recognized by this probe.
    """
    if len(data) < 64:
        return False
    words = struct.unpack('<16I', data[:64])
    if not 0x20000000 < words[0] <= 0x20080000 or words[0] % 8:
        return False

    def handler(value):
        return value & 1 and any(base <= (value & ~1) < base + image_length
                                 for base in (0, 0x08000000))
    return (bool(handler(words[1])) and
            all(value in (0, 0xffffffff) or handler(value) for value in words[2:]) and
            sum(bool(handler(value)) for value in words[1:]) >= 3)


def decoding_probes(data):
    """Check legacy keys and padding-derived periodic XOR/subtract hypotheses."""
    candidates = []
    prefix = data[:64]
    for key in range(256):
        decoded = decode_old_model(key, prefix)
        if vector_candidate(decoded, len(data)):
            candidates.append(dict(transform='legacy-transpose-subtract', key=key,
                                   vector_hex=decoded.hex()))
    # The dominant aligned block might encode uniform padding. That is only a
    # hypothesis: it might instead be instructions or a structured data record.
    attempts = 256
    for source, payload in (('raw', data), ('transpose', decode_old_model(0, data))):
        for width in (8, 16):
            stats = block_stats(payload, width)
            if not stats['most_common']:
                continue
            block = bytes.fromhex(stats['most_common'][0]['hex'])
            for fill in (0, 255):
                for method in ('xor', 'subtract'):
                    key = bytes((b ^ fill) if method == 'xor' else (b - fill) % 256
                                for b in block)
                    transformed = bytes((b ^ key[i % width]) if method == 'xor'
                                        else (b - key[i % width]) % 256
                                        for i, b in enumerate(payload[:64]))
                    attempts += 1
                    if vector_candidate(transformed, len(data)):
                        candidates.append(dict(transform=f'{source}-periodic-{method}',
                                               period=width, assumed_padding=fill,
                                               key_hex=key.hex(), vector_hex=transformed.hex()))
    return dict(attempts=attempts, vector_candidates=candidates,
                caveat='Candidate vectors do not establish decoded code; no candidate does not rule out other transforms or memory maps.')


def inspect_probes(buf):
    sections = []
    parsed = parse(buf)
    for section in parsed:
        if section['name'] not in ('ui_nu', 'dsp_nu', 'gps_nu', 'N2DS'):
            continue
        payload = buf[section['offset']:section['offset'] + section['length']]
        sections.append(dict(name=section['name'], model=parsed[0]['model'],
                             length=len(payload), entropy=entropy(payload),
                             blocks=[block_stats(payload, n) for n in (4, 8, 16, 32)],
                             probes=decoding_probes(payload)))
    return dict(sections=sections)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('firmware', type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect_probes(args.firmware.read_bytes()), indent=2))


if __name__ == '__main__':
    main()
