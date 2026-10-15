"""CLI regressions from DSP sweep selection at 0x8998 and 0x57a6..0x5a08."""
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import r7_ipc


class DSPKaGatingTests(unittest.TestCase):
    def config_output(self, bands=None):
        args = ["--ka", "1,9"]
        if bands is not None:
            args += ["--bands", hex(bands)]
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            r7_ipc.cmd_config(args)
        return out.getvalue(), err.getvalue()

    def test_bit0_alone_uses_standard_segment_table(self):
        # Regression: the old CLI incorrectly warned that bit2 was mandatory.
        _, err = self.config_output(0x0001)
        self.assertEqual(err, "")
        self.assertEqual(r7_ipc.ka_mask_status(0x0001),
                         (True, True, "28-record Ka segment table"))

    def test_narrow_ka_selection_takes_priority_in_standard_builder(self):
        # At 0x57ac, 0x57dc and 0x5806, bit1 is tested before bit0.
        for bands in (0x0003, 0x000b, 0x0013, 0x001b):
            with self.subTest(bands=bands):
                _, err = self.config_output(bands)
                self.assertIn("16-record narrow Ka table with no segment records", err)

    def test_combined_builder_bypasses_narrow_ka_priority(self):
        for bands in (0x0005, 0x0007):
            with self.subTest(bands=bands):
                _, err = self.config_output(bands)
                self.assertEqual(err, "")
                self.assertEqual(r7_ipc.ka_mask_status(bands),
                                 (True, True, "36-record combined K/Ka segment table"))

    def test_parsed_but_unapplied_is_distinguished_from_unparsed(self):
        _, no_read = self.config_output(0x0000)
        _, read_only = self.config_output(0x0004)
        self.assertIn("mask is not parsed", no_read)
        self.assertIn("bit0 is clear; no Ka segment masking", read_only)
        self.assertEqual(r7_ipc.ka_mask_status(0x0000)[:2], (False, False))
        self.assertEqual(r7_ipc.ka_mask_status(0x0004)[:2], (True, False))

    def test_k_table_selection_does_not_disable_ka_segments(self):
        # Bits3/4 select among e64c/eaac/e87c, all with 28 records.
        for bands in (0x0009, 0x0011, 0x0019):
            with self.subTest(bands=bands):
                _, err = self.config_output(bands)
                self.assertEqual(err, "")

    def test_decode_reports_literal_bit0_frame_as_applied(self):
        # Literal frame: first ten fields zero, bands=0001, mask=0101.
        # XOR(0x90, ASCII data) is 0x91.
        raw = b"\x90" + b"0" * 22 + b"0100010191"
        out = StringIO()
        with redirect_stdout(out):
            r7_ipc.cmd_decode(raw.hex())
        self.assertIn("checksum    91  OK", out.getvalue())
        self.assertIn("Ka mask: applied to segment records", out.getvalue())
        self.assertIn("28-record Ka segment table", out.getvalue())

    def test_historical_default_is_preserved(self):
        out, err = self.config_output()
        self.assertEqual(err, "")
        self.assertIn("band_bits           : 0x0005", out)

    def test_non_symmetric_words_are_low_byte_first(self):
        # Golden DSP 0xcea4 decoding: "3412" is 0x1234, not 0x3412.
        raw = b"\x90" + b"34120102030405060708090104800199"
        _, payload, ok = r7_ipc.parse_frame(raw)
        self.assertTrue(ok)
        fields = {n: v for n, _, v, _ in r7_ipc.split_fields(payload[:-2], r7_ipc.CONFIG_FIELDS)}
        self.assertEqual(fields["f1_u16"], 0x1234)
        self.assertEqual(fields["band_bits"], 0x0401)
        self.assertEqual(fields["ka_mask"], 0x0180)
        values = [(2, 0x1234)] + [(1, n) for n in range(1, 10)] + [(2, 0x0401), (2, 0x0180)]
        self.assertEqual(r7_ipc.build(0x10, values), raw)

    def test_ui_builder_compatible_example(self):
        # ui_nu 0xd61c: cfg[f]=1,d=0,b1=0 -> first field=0x23;
        # dd/de/df=7,112/113/114=8,c9=1 and global flag !=1 -> f8=0x41;
        # cfg[6]=0,7=8=1, call arg=0 -> f9=0; helper15018 returns0 -> f10=0.
        # ce=1,b2=b5=115=b=c=11a=1,b6=cf=0 -> bands=1.
        # Only e0/e7=0; e9=1,b3=0,b4=1 -> Ka mask=0x0081.
        values = [(2, 0x23)] + [(1, n) for n in (7, 7, 7, 8, 8, 8, 0x41, 0, 0)]
        values += [(2, 1), (2, 0x81)]
        self.assertEqual(r7_ipc.build(0x10, values), b"\x90" + b"23000707070808084100000100810093")


if __name__ == "__main__":
    unittest.main()
