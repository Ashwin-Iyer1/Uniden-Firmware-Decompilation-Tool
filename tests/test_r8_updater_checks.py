"""Output integrity checks; Unicorn is an optional analysis dependency."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
try:
    from r8_macos_updater_checks import write_report
except ModuleNotFoundError as error:
    if error.name != 'unicorn':
        raise
    write_report = None


@unittest.skipIf(write_report is None, 'install Unicorn to test the optional updater checker')
class ReportOutputTests(unittest.TestCase):
    def test_new_report_round_trips(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'report.json'
            report = {'method': 'offline', 'passed_cases': 13}
            write_report(output, report)
            self.assertEqual(json.loads(output.read_text()), report)

    def test_existing_file_and_input_aliases_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source.bin'
            original = b'original input bytes'
            source.write_bytes(original)
            symlink = root / 'symlink.json'
            symlink.symlink_to(source)
            hardlink = root / 'hardlink.json'
            import os
            os.link(source, hardlink)
            for output in (source, symlink, hardlink):
                with self.subTest(output=output.name):
                    with self.assertRaises(FileExistsError):
                        write_report(output, {'unexpected': 'replacement'})
                    self.assertEqual(source.read_bytes(), original)

    def test_dangling_symlink_cannot_create_its_target(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / 'must-not-be-created'
            output = root / 'report.json'
            output.symlink_to(target)
            with self.assertRaises(FileExistsError):
                write_report(output, {})
            self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
