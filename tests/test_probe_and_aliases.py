"""Decoder-hypothesis controls and compatibility of renamed entry points."""
import contextlib
import importlib
import io
import runpy
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from rseries_probe import block_stats, decoding_probes, vector_candidate
from rseries_unpack import encode_old_model
from test_rseries import container


class ProbeTests(unittest.TestCase):
    def test_known_legacy_vector_is_found(self):
        vector = struct.pack('<16I', 0x20004000, 0x101, 0x111, 0x121, *([0] * 12))
        image = vector + bytes(range(256)) * 2
        result = decoding_probes(encode_old_model(182, image))
        self.assertTrue(any(c['transform'] == 'legacy-transpose-subtract' and c['key'] == 182
                            for c in result['vector_candidates']))

    def test_reject_vectors_without_thumb_or_sram(self):
        self.assertFalse(vector_candidate(bytes(64), 512))
        self.assertFalse(vector_candidate(struct.pack('<16I', 0x20004000, 0x100,
                                                      *([0] * 14)), 512))
        self.assertFalse(vector_candidate(struct.pack('<16I', 0x30004000, 0x101,
                                                      *([0x111] * 14)), 512))

    def test_periodic_xor_positive_control(self):
        vector = struct.pack('<16I', 0x20004000, 0x101, 0x111, 0x121, *([0] * 12))
        image = vector + bytes(2048)
        key = bytes(range(16))
        encoded = bytes(b ^ key[i % 16] for i, b in enumerate(image))
        result = decoding_probes(encoded)
        self.assertTrue(any(c['transform'] == 'raw-periodic-xor' and c['period'] == 16
                            and c['assumed_padding'] == 0 for c in result['vector_candidates']))

    def test_block_statistics_ignore_incomplete_tail(self):
        result = block_stats(b'ABCDABCDABCDxy', 4)
        self.assertEqual((result['blocks'], result['unique'], result['repeated_occurrences']), (3, 1, 2))
        self.assertEqual(block_stats(b'xy', 4)['most_common'], [])


class AliasTests(unittest.TestCase):
    def test_public_functions_are_identical(self):
        # Modules without optional Pillow dependency can be imported in CI.
        for name in ('unpack', 'patch', 'gpsdb', 'bands', 'sound', 'ipc', 'iplink', 'lzss', 'alertsim'):
            old = importlib.import_module('r7_' + name)
            new = importlib.import_module('rseries_' + name)
            functions = {key: value for key, value in vars(new).items()
                         if not key.startswith('_') and callable(value)}
            self.assertTrue(functions)
            for key, value in functions.items():
                self.assertIs(getattr(old, key), value)

    def test_unpack_alias_runs_same_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            firmware = Path(directory) / 'synthetic.bin'
            firmware.write_bytes(container())
            outputs = []
            for name in ('r7_unpack', 'rseries_unpack'):
                previous = sys.argv
                try:
                    sys.argv = [name + '.py', 'parse', str(firmware), '--json']
                    capture = io.StringIO()
                    with contextlib.redirect_stdout(capture):
                        runpy.run_module(name, run_name='__main__')
                    outputs.append(capture.getvalue())
                finally:
                    sys.argv = previous
            self.assertEqual(*outputs)


if __name__ == '__main__':
    unittest.main()
