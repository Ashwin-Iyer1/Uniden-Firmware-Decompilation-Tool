"""Golden SUB frames derived from ui_nu's builder and Ka menu branches.

These are synthetic protocol fixtures, not hardware captures. Their expected
bytes are written explicitly rather than generated from CONFIG_MAP or paired
encoder/decoder output. Source evidence: docs/FIRMWARE_MAP.md section 1.13 and
docs/REA_FINDINGS.md (ui_nu SHA-256 16a8c58e25766909faaa114beb22d87e2dd5108c3a176a2587fccb901218d79f).
"""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import r7_iplink as iplink


ALL_OFF = bytes.fromhex("D2 AB 00 0E 40 00 06 31")
ALL_ON = bytes.fromhex("D2 AB 00 0E 41 7F 07 4E")

# All non-Ka config bytes are zero in these fixtures. Each tuple names a
# segment, its UI config offset, its sole-On frame, and its sole-Off frame.
# The remaining eight Ka segments have the opposite state in each frame.
KA_CASES = (
    (1, 0xE0, "D2 AB 00 0E 41 00 06 30", "D2 AB 00 0E 40 7F 07 4F"),
    (2, 0xE1, "D2 AB 00 0E 40 00 07 30", "D2 AB 00 0E 41 7F 06 4F"),
    (3, 0xE2, "D2 AB 00 0E 40 40 06 71", "D2 AB 00 0E 41 3F 07 0E"),
    (4, 0xE3, "D2 AB 00 0E 40 20 06 11", "D2 AB 00 0E 41 5F 07 6E"),
    (5, 0xE4, "D2 AB 00 0E 40 10 06 21", "D2 AB 00 0E 41 6F 07 5E"),
    (6, 0xE5, "D2 AB 00 0E 40 08 06 39", "D2 AB 00 0E 41 77 07 46"),
    (7, 0xE6, "D2 AB 00 0E 40 04 06 35", "D2 AB 00 0E 41 7B 07 4A"),
    (8, 0xE7, "D2 AB 00 0E 40 02 06 33", "D2 AB 00 0E 41 7D 07 4C"),
    (9, 0xE8, "D2 AB 00 0E 40 01 06 30", "D2 AB 00 0E 41 7E 07 4F"),
)


class KaMenuPolarityTests(unittest.TestCase):
    def test_all_on_all_off_and_selected_segments(self):
        cases = (
            (set(), ALL_OFF),
            (set(range(1, 10)), ALL_ON),
            ({1, 3, 5}, bytes.fromhex("D2 AB 00 0E 41 50 06 60")),
        )
        for enabled, expected in cases:
            with self.subTest(enabled=sorted(enabled)):
                self.assertEqual(iplink.config_from_ka(enabled), expected)
                decoded = iplink.decode_config(expected)
                self.assertTrue(decoded["csum_ok"])
                self.assertEqual(decoded["ka_segments_swept"], sorted(enabled))

    def test_each_segment_on_against_literal_frame(self):
        for segment, offset, only_on_hex, _ in KA_CASES:
            with self.subTest(segment=segment):
                expected = bytes.fromhex(only_on_hex)
                self.assertEqual(iplink.config_from_ka({segment}), expected)
                # The dispatcher calls renderer(segment, 1) for cfg==0;
                # the renderer selects " On", and the builder emits bit 1.
                raw_config = {address: 1 for address in range(0xE0, 0xE9)}
                raw_config[offset] = 0
                self.assertEqual(iplink.build_config(raw_config), expected)
                decoded = iplink.decode_config(expected)
                self.assertTrue(decoded["csum_ok"])
                self.assertEqual(decoded["ka_segments_swept"], [segment])
                self.assertEqual(decoded["fields"][f"ka_seg{segment}"], {"wire": 1, "cfg": 0})

    def test_each_segment_off_against_literal_frame(self):
        for segment, offset, _, only_off_hex in KA_CASES:
            with self.subTest(segment=segment):
                expected = bytes.fromhex(only_off_hex)
                enabled = set(range(1, 10)) - {segment}
                self.assertEqual(iplink.config_from_ka(enabled), expected)
                # Both dispatcher and builder compare with zero. All nonzero
                # config bytes take the Off path, not only canonical value 1.
                for off_value in (1, 2, 255):
                    with self.subTest(off_value=off_value):
                        self.assertEqual(iplink.build_config({offset: off_value}), expected)
                decoded = iplink.decode_config(expected)
                self.assertTrue(decoded["csum_ok"])
                self.assertEqual(decoded["ka_segments_swept"], sorted(enabled))
                self.assertEqual(decoded["fields"][f"ka_seg{segment}"], {"wire": 0, "cfg": 1})

    def test_three_bit_field_preserves_numerical_values(self):
        # f1ae..f1b4 implement (cfg[0x118] << 3) & 0x38. Its menu meaning
        # remains unidentified; this verifies only the observed numeric field.
        cases = ((0, 0x00), (1, 0x08), (2, 0x10), (3, 0x18),
                 (4, 0x20), (5, 0x28), (6, 0x30), (7, 0x38),
                 (8, 0x00), (255, 0x38))
        for config_value, expected_byte in cases:
            with self.subTest(config_value=config_value):
                self.assertEqual(iplink.build_config({0x118: config_value})[2], expected_byte)

    def test_existing_non_ka_mapping_is_preserved(self):
        config = {address: 1 for address in (
            0x01, 0x03, 0x04, 0x07, 0x08, 0xCF, 0xF6, 0xF5,
            0x115, 0xB6, 0xCE, 0x06, 0xB5,
            0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8,
        )}
        config[0x118] = 7
        self.assertEqual(iplink.build_config(config), bytes.fromhex("D2 AB 3F 7D 30 00 00 0B"))


if __name__ == "__main__":
    unittest.main()
