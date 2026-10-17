"""Guarded R7 settings edits, with synthetic code and optional private firmware.

The synthetic image contains only nine independently specified instructions;
no vendor firmware or decompiled implementation is included in this fixture.
"""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import r7_settings as settings
from rseries_unpack import encode_old_model, parse


UI_SIZE = 195072
STOCK_SITES = {
    'auto_mute_delay_ms': (
        (0x16af2, bytes.fromhex('40 f6 b8 30')),
        (0x16b14, bytes.fromhex('40 f6 b8 31')),
        (0x16b22, bytes.fromhex('40 f6 b8 30')),
    ),
    'default_theme': ((0x1d05e, b'\x05\x20'), (0x1d458, b'\x06\x20')),
    'default_mute_volume': ((0x1d0a6, b'\x02\x20'), (0x1d488, b'\x02\x20')),
    'default_mute_level': ((0x1d21a, b'\x08\x20'), (0x1d608, b'\x08\x20')),
}
STOCK_VALUES = {
    'auto_mute_delay_ms': [3000, 3000, 3000],
    'default_theme': [5, 6],
    'default_mute_volume': [2, 2],
    'default_mute_level': [8, 8],
}


def synthetic_ui():
    data = bytearray(bytes(range(256)) * (UI_SIZE // 256))
    for sites in STOCK_SITES.values():
        for offset, instruction in sites:
            data[offset:offset + len(instruction)] = instruction
    return bytes(data)


def container(ui, model=7, version=153):
    # The container rounds each declared length up to the next 512-byte block.
    body = bytearray(struct.pack('<III', 194776, 500, 500))
    for payload, ver, tag in (
        (encode_old_model(182, ui), version, b'DRSWMAI'),
        (bytes(range(256)) * 2, 150, b'DRSWDSP'),
        (bytes(reversed(range(256))) * 2, 127, b'DRSWSUB'),
    ):
        body += payload + struct.pack('<H', model << 10 | ver) + tag
    database = bytes(range(32))
    body += b'GPSD' + struct.pack('<II', 12, len(database) + 12)
    body += database + encode_old_model(210, struct.pack('<I', 2))
    body += struct.pack('<I', 20260702) + b'LRDBDRSWGDB'
    body += b'NMGF' + struct.pack('<II', 0, 109)
    return bytes(body)


def decoded_values(data):
    """Read ARM immediate fields without depending on the editor's decoder."""
    result = {}
    for name, sites in STOCK_SITES.items():
        values = []
        for offset, original in sites:
            if len(original) == 2:
                values.append(data[offset])
            else:
                first, second = struct.unpack_from('<HH', data, offset)
                values.append(((first & 0xf) << 12) | ((first & 0x400) << 1)
                              | ((second & 0x7000) >> 4) | (second & 0xff))
        result[name] = values
    return result


class SyntheticSettingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ui = synthetic_ui()
        cls.firmware = container(cls.ui)

    def setUp(self):
        # Only this synthetic fixture substitutes the supported identity.
        replacement = hashlib.sha256(self.ui).hexdigest()
        self.identity_patch = patch.object(settings, 'UI_SHA256', replacement)
        self.identity_patch.start()
        self.addCleanup(self.identity_patch.stop)

    def cli(self, *arguments):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            with contextlib.redirect_stderr(io.StringIO()) as err:
                settings.main(list(arguments))
        return out.getvalue(), err.getvalue()

    def test_stock_identity_and_distinct_theme_initializers(self):
        self.assertEqual(settings.validate_ui(self.ui), STOCK_VALUES)
        section, decoded = settings.read_ui(self.firmware)
        self.assertEqual((section['name'], section['version'], section['key']),
                         ('ui_nu', 153, 182))
        self.assertEqual(decoded, self.ui)

    def test_noop_preserves_every_byte(self):
        changed, report = settings.patch_ui(self.ui, {})
        self.assertEqual(changed, self.ui)
        json.dumps(report)
        result, report = settings.patch_firmware(self.firmware, {})
        self.assertEqual(result, self.firmware)
        json.dumps(report)

    def test_all_settings_change_and_only_instruction_immediates_change(self):
        changes = {'auto_mute_delay_ms': 1500, 'default_theme': 3,
                   'default_mute_volume': 5, 'default_mute_level': 4}
        result, report = settings.patch_ui(self.ui, changes)
        expected = bytearray(self.ui)
        for offset, _ in STOCK_SITES['auto_mute_delay_ms']:
            # Independently assembled MOVW r0/r1, #1500.
            expected[offset:offset + 4] = (bytes.fromhex('40 f2 dc 51')
                                          if offset == 0x16b14
                                          else bytes.fromhex('40 f2 dc 50'))
        for name in ('default_theme', 'default_mute_volume', 'default_mute_level'):
            for offset, _ in STOCK_SITES[name]:
                expected[offset] = changes[name]
        self.assertEqual(result, bytes(expected))
        self.assertEqual(decoded_values(result), {
            name: [value] * len(STOCK_SITES[name]) for name, value in changes.items()})
        self.assertEqual(settings.validate_ui(result), decoded_values(result))
        self.assertEqual(report['before'], STOCK_VALUES)
        self.assertEqual(report['after'], decoded_values(result))
        self.assertEqual(report['changed_ui_bytes'],
                         sum(old != new for old, new in zip(self.ui, result)))
        self.assertEqual(report['input_ui_sha256'], hashlib.sha256(self.ui).hexdigest())
        self.assertEqual(report['output_ui_sha256'], hashlib.sha256(result).hexdigest())
        self.assertFalse(report['hardware_verified'])
        json.dumps(report)

    def test_supported_modifications_can_be_edited_again(self):
        first, _ = settings.patch_ui(self.ui, {'auto_mute_delay_ms': 100,
                                             'default_theme': 0})
        second, _ = settings.patch_ui(first, {'auto_mute_delay_ms': 30000,
                                             'default_mute_volume': 7})
        self.assertEqual(decoded_values(second), {
            'auto_mute_delay_ms': [30000] * 3, 'default_theme': [0, 0],
            'default_mute_volume': [7, 7], 'default_mute_level': [8, 8]})
        third, _ = settings.patch_ui(second, {})
        self.assertEqual(third, second)

    def test_each_supported_range_including_movw_bit_boundaries(self):
        for name, values in (
            ('auto_mute_delay_ms', (100, 255, 256, 2047, 2048, 4095, 4096, 30000)),
            ('default_theme', range(8)), ('default_mute_volume', range(8)),
            ('default_mute_level', range(9)),
        ):
            for value in values:
                with self.subTest(name=name, value=value):
                    result, _ = settings.patch_ui(self.ui, {name: value})
                    self.assertEqual(decoded_values(result)[name],
                                     [value] * len(STOCK_SITES[name]))
                    settings.validate_ui(result)

    def test_rejects_invalid_values_without_mutating_input(self):
        for name, low, high in (('auto_mute_delay_ms', 100, 30000),
                                ('default_theme', 0, 7),
                                ('default_mute_volume', 0, 7),
                                ('default_mute_level', 0, 8)):
            for value in (low - 1, high + 1, True, False, 1.0, '2', None):
                with self.subTest(name=name, value=value):
                    source = bytearray(self.ui)
                    with self.assertRaises((ValueError, TypeError)):
                        settings.patch_ui(source, {name: value})
                    self.assertEqual(source, self.ui)
        with self.assertRaises((ValueError, KeyError)):
            settings.patch_ui(self.ui, {'unknown_setting': 1})

    def test_rejects_unrelated_code_data_or_opcode_changes(self):
        # Includes unedited code/data, MOVS register, and both MOVW opcodes.
        for offset in (0, 0x100, UI_SIZE - 1, 0x1d05f, 0x16af3, 0x16b17):
            with self.subTest(offset=hex(offset)):
                corrupt = bytearray(self.ui)
                corrupt[offset] ^= 1
                with self.assertRaises(ValueError):
                    settings.validate_ui(bytes(corrupt))
                with self.assertRaises(ValueError):
                    settings.patch_ui(bytes(corrupt), {'default_theme': 1})

    def test_rejects_inconsistent_paired_or_tripled_instructions(self):
        for name in STOCK_SITES:
            with self.subTest(name=name):
                modified, _ = settings.patch_ui(self.ui, {name: 1000 if name == 'auto_mute_delay_ms' else 1})
                inconsistent = bytearray(self.ui)
                offset, original = STOCK_SITES[name][0]
                inconsistent[offset:offset + len(original)] = modified[offset:offset + len(original)]
                with self.assertRaises(ValueError):
                    settings.validate_ui(bytes(inconsistent))

    def test_rejects_out_of_range_instructions_even_with_matching_pairs(self):
        for name in ('default_theme', 'default_mute_volume', 'default_mute_level'):
            modified = bytearray(self.ui)
            for offset, _ in STOCK_SITES[name]:
                modified[offset] = 255
            with self.subTest(name=name), self.assertRaises(ValueError):
                settings.validate_ui(bytes(modified))

    def test_rejects_truncated_or_resized_ui(self):
        for data in (b'', self.ui[:0x16af3], self.ui[:-1], self.ui + b'\0'):
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                settings.validate_ui(data)

    def test_container_patch_preserves_every_other_byte(self):
        result, report = settings.patch_firmware(self.firmware, {'auto_mute_delay_ms': 1000})
        section, modified = settings.read_ui(result)
        start, end = section['offset'], section['offset'] + section['length']
        self.assertEqual(len(result), len(self.firmware))
        self.assertEqual(result[:start], self.firmware[:start])
        self.assertEqual(result[end:], self.firmware[end:])
        self.assertEqual(parse(result), parse(self.firmware))
        self.assertEqual(decoded_values(modified)['auto_mute_delay_ms'], [1000] * 3)
        # The transpose only modifies four-byte blocks containing edited instructions.
        allowed = set()
        for offset, original in STOCK_SITES['auto_mute_delay_ms']:
            for index in range(offset, offset + len(original)):
                allowed.update(range(start + (index & ~3), start + (index & ~3) + 4))
        self.assertTrue({i for i, (old, new) in enumerate(zip(self.firmware, result))
                         if old != new}.issubset(allowed))
        self.assertEqual(report['input_sha256'], hashlib.sha256(self.firmware).hexdigest())
        self.assertEqual(report['output_sha256'], hashlib.sha256(result).hexdigest())
        self.assertEqual(report['changed_container_bytes'],
                         sum(old != new for old, new in zip(self.firmware, result)))
        self.assertTrue(report['other_sections_identical'])
        json.dumps(report)

    def test_rejects_wrong_model_version_and_container_truncation(self):
        invalid = [container(self.ui, model=model) for model in (24, 28)]
        invalid += [container(self.ui, version=152)]
        invalid += [self.firmware[:end] for end in (0, 11, 100, UI_SIZE, len(self.firmware) - 1)]
        for data in invalid:
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                settings.patch_firmware(data, {'default_theme': 1})

    def test_rejects_changed_declared_length_with_unchanged_payload(self):
        for declared in (194560, 194775, 194777, 195071):
            corrupted = bytearray(self.firmware)
            struct.pack_into('<I', corrupted, 0, declared)
            # Every case has the same padded length and decoded UI hash.
            self.assertEqual(parse(corrupted)[0]['length'], UI_SIZE)
            with self.subTest(declared=declared), self.assertRaises(ValueError):
                settings.patch_firmware(bytes(corrupted), {'default_theme': 1})

    def test_inspect_and_plan_leave_input_unchanged_and_do_not_create_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'source.bin'
            source.write_bytes(self.firmware)
            self.cli('inspect', str(source))
            self.cli('plan', str(source), '--set', 'auto_mute_delay_ms=1500')
            self.assertEqual(source.read_bytes(), self.firmware)
            self.assertEqual(list(Path(tmp).iterdir()), [source])

    def test_apply_is_explicit_and_refuses_existing_files_or_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, output = root / 'source.bin', root / 'output.bin'
            source.write_bytes(self.firmware)
            args = ('apply', str(source), '--set', 'default_theme=1', '--output', str(output))
            self.cli(*args)
            expected, _ = settings.patch_firmware(self.firmware, {'default_theme': 1})
            self.assertEqual(output.read_bytes(), expected)
            with self.assertRaises(SystemExit) as error:
                self.cli(*args)
            self.assertEqual(error.exception.code, 2)
            self.assertEqual(output.read_bytes(), expected)
            output.unlink()
            output.symlink_to(source)
            with self.assertRaises(SystemExit) as error:
                self.cli(*args)
            self.assertEqual(error.exception.code, 2)
            self.assertEqual(source.read_bytes(), self.firmware)
            output.unlink()
            absent = root / 'absent.bin'
            output.symlink_to(absent)
            with self.assertRaises(SystemExit):
                self.cli(*args)
            self.assertFalse(absent.exists())

    def test_cli_rejects_malformed_and_duplicate_assignments_without_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / 'source.bin', Path(tmp) / 'output.bin'
            source.write_bytes(self.firmware)
            for assignments in (['default_theme'], ['default_theme=1.5'],
                                ['default_theme=true'], ['unknown=1'],
                                ['default_theme=1', 'default_theme=2']):
                args = ['apply', str(source), '--output', str(output)]
                for item in assignments:
                    args += ['--set', item]
                with self.subTest(assignments=assignments), self.assertRaises(SystemExit) as error:
                    self.cli(*args)
                self.assertEqual(error.exception.code, 2)
                self.assertFalse(output.exists())


@unittest.skipUnless(os.environ.get('R7_FIRMWARE'), 'set R7_FIRMWARE for the private stock-image check')
class StockSettingsTests(unittest.TestCase):
    def test_real_identity_roundtrip_and_guard(self):
        original = Path(os.environ['R7_FIRMWARE']).read_bytes()
        _, ui = settings.read_ui(original)
        self.assertEqual(hashlib.sha256(ui).hexdigest(), settings.UI_SHA256)
        self.assertEqual(settings.validate_ui(ui), STOCK_VALUES)
        noop, _ = settings.patch_firmware(original, {})
        self.assertEqual(noop, original)
        modified, _ = settings.patch_firmware(original, {'auto_mute_delay_ms': 1500,
                                                        'default_theme': 1})
        section, changed = settings.read_ui(modified)
        start, end = section['offset'], section['offset'] + section['length']
        self.assertEqual(modified[:start], original[:start])
        self.assertEqual(modified[end:], original[end:])
        self.assertEqual(decoded_values(changed)['auto_mute_delay_ms'], [1500] * 3)
        self.assertEqual(decoded_values(changed)['default_theme'], [1, 1])
        settings.validate_ui(changed)
        corrupt = bytearray(changed)
        corrupt[0x1000] ^= 1
        with self.assertRaises(ValueError):
            settings.validate_ui(bytes(corrupt))


if __name__ == '__main__':
    unittest.main()
