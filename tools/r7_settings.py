#!/usr/bin/env python3
"""Guarded R7 v153 UI code patches for auto mute and reset defaults.

inspect prints the current settings; plan previews changes; apply writes a new
container. No device access. See docs/R7_SETTINGS.md for evidence and limitations.
Only the known UI image, optionally changed at this tool's coupled sites, passes
validation. There is deliberately no force flag or caller-supplied hash override.
"""
import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import struct

from rseries_unpack import decode_old_model, encode_old_model, parse


UI_SHA256 = '16a8c58e25766909faaa114beb22d87e2dd5108c3a176a2587fccb901218d79f'
UI_LENGTH = 195072
UI_DECLARED_LENGTH = 194776
THEMES = ('Blue', 'Amber', 'Green', 'Pink', 'Gray', 'Red', 'White', 'Violet')


@dataclass(frozen=True)
class Site:
    offset: int
    kind: str
    register: int
    original: bytes

    def encode(self, value):
        if self.kind == 'movs':
            return struct.pack('<H', 0x2000 | self.register << 8 | value)
        # Thumb-2 MOVW: imm4:i:imm3:imm8, with fixed opcode and destination.
        first = 0xf240 | ((value >> 12) & 15) | (((value >> 11) & 1) << 10)
        second = ((value >> 8) & 7) << 12 | self.register << 8 | (value & 255)
        return struct.pack('<HH', first, second)

    def decode(self, data):
        raw = data[self.offset:self.offset + len(self.original)]
        if len(raw) != len(self.original):
            raise ValueError(f'truncated instruction at 0x{self.offset:x}')
        if self.kind == 'movs':
            value = raw[0]
        else:
            first, second = struct.unpack('<HH', raw)
            value = (first & 15) << 12 | ((first >> 10) & 1) << 11
            value |= ((second >> 12) & 7) << 8 | (second & 255)
        if self.encode(value) != raw:
            raise ValueError(f'unexpected instruction at 0x{self.offset:x}')
        return value


@dataclass(frozen=True)
class Setting:
    minimum: int
    maximum: int
    sites: tuple
    description: str


SETTINGS = {
    'auto_mute_delay_ms': Setting(100, 30000, (
        Site(0x16af2, 'movw', 0, bytes.fromhex('40 f6 b8 30')),
        Site(0x16b14, 'movw', 1, bytes.fromhex('40 f6 b8 31')),
        Site(0x16b22, 'movw', 0, bytes.fromhex('40 f6 b8 30')),
    ), 'Nominal milliseconds until auto mute; updates comparison and both saturation values.'),
    'default_theme': Setting(0, 7, (
        Site(0x1d05e, 'movs', 0, bytes.fromhex('05 20')),
        Site(0x1d458, 'movs', 0, bytes.fromhex('06 20')),
    ), 'Theme index: ' + ', '.join(f'{i}={name}' for i, name in enumerate(THEMES)) + '.'),
    'default_mute_volume': Setting(0, 7, (
        Site(0x1d0a6, 'movs', 0, bytes.fromhex('02 20')),
        Site(0x1d488, 'movs', 0, bytes.fromhex('02 20')),
    ), 'Auto Mute Vol default in both reset and invalid-storage initialization.'),
    'default_mute_level': Setting(0, 8, (
        Site(0x1d21a, 'movs', 0, bytes.fromhex('08 20')),
        Site(0x1d608, 'movs', 0, bytes.fromhex('08 20')),
    ), 'Auto Mute Lv default in both initializers; 0 disables, 1..8 are signal-level gates.'),
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def validate_ui(decoded):
    """Return per-site values after verifying every other UI byte against stock."""
    if len(decoded) != UI_LENGTH:
        raise ValueError(f'unsupported UI length: expected {UI_LENGTH} bytes')
    normalized = bytearray(decoded)
    values = {}
    for name, setting in SETTINGS.items():
        current = [site.decode(decoded) for site in setting.sites]
        if any(not setting.minimum <= v <= setting.maximum for v in current):
            raise ValueError(f'{name} has an out-of-range instruction value')
        # Stock intentionally has different themes for reset (Red) and invalid
        # NVM (White). New profiles set both together. No partial patch accepted.
        stock_theme = name == 'default_theme' and current == [5, 6]
        if len(set(current)) != 1 and not stock_theme:
            raise ValueError(f'{name} has inconsistent coupled instruction values')
        values[name] = current
        for site in setting.sites:
            normalized[site.offset:site.offset + len(site.original)] = site.original
    if sha256(normalized) != UI_SHA256:
        raise ValueError('unsupported or independently modified UI: normalized SHA256 does not match R7 v153')
    return values


def read_ui(container):
    sections = parse(container, require_model=7)
    ui = [s for s in sections if s['name'] == 'ui_nu']
    if len(ui) != 1 or ui[0]['version'] != 153:
        raise ValueError('requires one R7 ui_nu section with version 153')
    section = ui[0]
    if (section['length'] != UI_LENGTH or section['key'] != 182
            or section['declared_length'] != UI_DECLARED_LENGTH):
        raise ValueError('unsupported R7 UI section layout')
    start = section['offset']
    decoded = decode_old_model(section['key'], container[start:start + section['length']])
    validate_ui(decoded)
    return section, decoded


def patch_ui(decoded, changes):
    """Validate a profile and patch complete coupled instruction groups only."""
    before = validate_ui(decoded)
    for name, value in changes.items():
        if name not in SETTINGS:
            raise ValueError(f'unknown setting: {name}')
        setting = SETTINGS[name]
        if type(value) is not int or not setting.minimum <= value <= setting.maximum:
            raise ValueError(f'{name} requires an integer from {setting.minimum} to {setting.maximum}')
    output = bytearray(decoded)
    instructions = []
    for name, value in changes.items():
        for site in SETTINGS[name].sites:
            replacement = site.encode(value)
            old = decoded[site.offset:site.offset + len(replacement)]
            if old != replacement:
                output[site.offset:site.offset + len(replacement)] = replacement
                instructions.append({'setting': name, 'ui_offset': f'0x{site.offset:x}',
                                     'before': old.hex(), 'after': replacement.hex()})
    output = bytes(output)
    after = validate_ui(output)
    report = {'reference_ui_sha256': UI_SHA256,
              'input_ui_sha256': sha256(decoded), 'output_ui_sha256': sha256(output),
              'before': before, 'after': after, 'instructions': instructions,
              'changed_ui_bytes': sum(a != b for a, b in zip(decoded, output)),
              'hardware_verified': False}
    return output, report


def patch_firmware(container, changes):
    section, decoded = read_ui(container)
    patched, report = patch_ui(decoded, changes)
    encoded = encode_old_model(section['key'], patched)
    if len(encoded) != section['length'] or decode_old_model(section['key'], encoded) != patched:
        raise ValueError('UI re-encoding verification failed')
    start = section['offset']
    end = start + section['length']
    output = container[:start] + encoded + container[end:]
    # Verify the complete output through the same parser and identity gate.
    _, verified = read_ui(output)
    if verified != patched or len(output) != len(container):
        raise ValueError('container verification failed')
    if output[:start] != container[:start] or output[end:] != container[end:]:
        raise ValueError('bytes outside UI changed')
    report.update(input_sha256=sha256(container), output_sha256=sha256(output),
                  changed_container_bytes=sum(a != b for a, b in zip(container, output)),
                  ui_container_offset=start, other_sections_identical=True)
    return output, report


def parse_changes(assignments):
    changes = {}
    for assignment in assignments:
        name, separator, raw = assignment.partition('=')
        if not separator or name in changes:
            raise ValueError('each --set must be a unique NAME=INTEGER assignment')
        try:
            changes[name] = int(raw, 10)
        except ValueError as exc:
            raise ValueError(f'invalid integer for {name}: {raw!r}') from exc
    return changes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('inspect', 'plan', 'apply'):
        command = commands.add_parser(name)
        command.add_argument('firmware', type=Path)
        if name != 'inspect':
            command.add_argument('--set', action='append', required=True, metavar='NAME=INTEGER')
        if name == 'apply':
            command.add_argument('--output', '-o', required=True, type=Path,
                                 help='new file; existing files and symlinks are refused')
    args = parser.parse_args(argv)
    try:
        original = args.firmware.read_bytes()
        changes = {} if args.command == 'inspect' else parse_changes(args.set)
        output, report = patch_firmware(original, changes)
        if args.command == 'inspect':
            report['settings'] = {
                name: {'minimum': s.minimum, 'maximum': s.maximum,
                       'description': s.description,
                       'value_order': (['active saturation', 'threshold', 'new saturation']
                                       if name == 'auto_mute_delay_ms'
                                       else ['factory reset', 'invalid storage'])}
                for name, s in SETTINGS.items()}
        if args.command == 'apply':
            # Exclusive creation also refuses symlinks and input/output aliases.
            with args.output.open('xb') as stream:
                stream.write(output)
            report['output'] = str(args.output)
        report['operation'] = args.command
        print(json.dumps(report, indent=2))
    except (OSError, ValueError) as exc:
        parser.exit(2, f'error: {exc}\n')


if __name__ == '__main__':
    main()
