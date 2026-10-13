import importlib.util
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

TOOL = Path(__file__).resolve().parents[1]/'tools/r8_ble.py'
spec = importlib.util.spec_from_file_location('r8_ble', TOOL)
ble = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ble
spec.loader.exec_module(ble)


def fixture(length=128):
    payload = bytearray(length)
    vectors = [ble.RAM_END-8, ble.BASE+65, ble.BASE+69, ble.BASE+73]+[0]*12
    struct.pack_into('<16I', payload, 0, *vectors)
    padding = b'\xff'*((length//1024+1)*1024-length)
    return b'BLES'+struct.pack('<II',0,length)+payload+padding+struct.pack('<H',113)+b'DRSWBLE'


class BleTests(unittest.TestCase):
    def test_payload_extent_and_exact_multiple_padding(self):
        for length in [128,1024]:
            with self.subTest(length=length):
                component = ble.select_component(fixture(length))
                self.assertEqual(component.payload_length,length)
                self.assertEqual(component.stored_length,(length//1024+1)*1024)
                self.assertEqual(component.reset_vector,ble.BASE+65)

    def test_false_tag_before_valid_component(self):
        raw = b'BLES'+b'\xff'*40+fixture()
        self.assertEqual(ble.select_component(raw).header_offset,44)

    def test_truncated_length_trailer_padding_and_vectors(self):
        cases = [fixture()[:-1]]
        for offset,value in [(8,0xffffffff),(12,0x20000000),(16,ble.BASE+64),
                             (20,ble.BASE+0x1001)]:
            raw=bytearray(fixture());struct.pack_into('<I',raw,offset,value);cases.append(raw)
        raw=bytearray(fixture());raw[12+128]=0;cases.append(raw)
        raw=bytearray(fixture());raw[-1]=0;cases.append(raw)
        for raw in cases:
            with self.subTest(raw_length=len(raw)):
                with self.assertRaises(ValueError):ble.select_component(raw)

    def test_ambiguous_components_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'found 2'):
            ble.select_component(fixture()+fixture())

    def test_extract_is_exact_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'firmware.bin';output=Path(folder)/'ble.bin'
            raw=fixture();source.write_bytes(raw)
            command=[sys.executable,str(TOOL),'extract',str(source),'--output',str(output)]
            subprocess.run(command,check=True,capture_output=True)
            self.assertEqual(output.read_bytes(),raw[12:12+128])
            retry=subprocess.run(command,capture_output=True)
            self.assertNotEqual(retry.returncode,0)
            self.assertEqual(source.read_bytes(),raw)
            alias=subprocess.run(command[:-1]+[str(source)],capture_output=True)
            self.assertNotEqual(alias.returncode,0)
            self.assertEqual(source.read_bytes(),raw)


if __name__ == '__main__':unittest.main()
