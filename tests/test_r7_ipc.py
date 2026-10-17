"""Wire-format regressions anchored to dsp_nu 0xdb76 and 0xc644."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import r7_ipc


class DSPParserTests(unittest.TestCase):
    def test_literal_empty_command_checksum(self):
        # No data: checksum is the wire opcode 0xb2 encoded as uppercase hex.
        self.assertEqual(r7_ipc.parse_frame(b'\xb2B2'), (0x32, 'B2', True))

    def test_lowercase_checksum_is_rejected(self):
        with self.assertRaisesRegex(SystemExit, 'uppercase ASCII hex'):
            r7_ipc.parse_frame(b'\xb2b2')

    def test_invalid_payload_is_rejected_even_with_matching_xor(self):
        # 0x8f XOR '@' XOR '@' = 0x8f; a valid XOR cannot legitimize nonhex.
        for body in (b'@@', b'aa', b'\xff\xff', b'  '):
            with self.subTest(body=body):
                with self.assertRaisesRegex(SystemExit, 'uppercase ASCII hex'):
                    r7_ipc.parse_frame(b'\x8f' + body + b'8F')

    def test_valid_hex_bad_checksum_is_reported(self):
        self.assertEqual(r7_ipc.parse_frame(b'\xb2B3'), (0x32, 'B3', False))

    def test_payload_and_checksum_use_ascii_xor(self):
        # 0x8f XOR ASCII('A') XOR ASCII('0') = 0xfe.
        self.assertEqual(r7_ipc.parse_frame(b'\x8fA0FE'), (0x0f, 'A0FE', True))


if __name__ == '__main__':
    unittest.main()
