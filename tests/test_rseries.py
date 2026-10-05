"""Synthetic fixtures only; optional stock images remain outside the repository."""
import hashlib
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from rseries_unpack import FirmwareFormatError, decode_old_model, encode_old_model, parse
from rseries import esp_image_info, extract_image, inspect_image, repack_image


def esp_image(with_hash=False):
    header = bytearray(24)
    header[0:2] = b'\xe9\x01'
    struct.pack_into('<I', header, 4, 0x403803fe)
    struct.pack_into('<H', header, 12, 5)
    header[23] = int(with_hash)
    payload = bytearray(256)
    payload[:4] = b'\x32\x54\xcd\xab'
    payload[16:19] = b'1.0'
    payload[48:52] = b'main'
    payload[80:88] = b'18:29:01'
    payload[96:107] = b'Feb  5 2026'
    payload[112:118] = b'v5.0.8'
    image = bytes(header) + struct.pack('<II', 0x3c0f0020, len(payload)) + payload
    checksum = 0xef
    for value in payload:
        checksum ^= value
    image += b'\0' * (15 - len(image) % 16) + bytes([checksum])
    if with_hash:
        image += hashlib.sha256(image).digest()
    return image


def container(model=28, database='AEUS', extra_sound=False):
    # Three declared 100-byte code images, each stored in a 512-byte block.
    header = struct.pack('<III', 100 | (int(extra_sound) << 24), 100, 100)
    if extra_sound:
        header += b'SNDD' + struct.pack('<II', 12, 16)
    body = bytearray(header)
    for ver, tag in zip((142, 113, 127), (b'DRSWMAI', b'DRSWDSP', b'DRSWSUB')):
        body += bytes(range(256)) * 2 + struct.pack('<H', model << 10 | ver) + tag
    if extra_sound:
        body += encode_old_model(225, b'\xc0\xff\xff\xff')
        body += encode_old_model(225, struct.pack('<I', 107)) + b'\0' * 8 + b'DRSWSDB'
    db_data = bytes(range(32))
    count = struct.pack('<I', 2)
    if database == 'LRDB':
        db_data = encode_old_model(210, db_data)
        count = encode_old_model(210, count)
    body += b'GPSD' + struct.pack('<II', 12, len(db_data) + 12) + db_data
    body += count + struct.pack('<I', 20260702) + database.encode() + b'DRSWGDB'
    body += b'STSD' + struct.pack('<II', 12, 16) + b'\0' * 4
    body += encode_old_model(225, struct.pack('<I', 107)) + b'\0' * 8 + b'DRSWSTS'
    for tag in (b'LSRS', b'N2DS', b'BLES'):
        payload = esp_image() if tag == b'BLES' else b'\x55' * 32
        mod = 1024 if tag == b'BLES' else 512
        size = (len(payload) // mod + 1) * mod
        body += tag + struct.pack('<II', 12, len(payload))
        body += payload + b'\xff' * (size - len(payload))
        body += struct.pack('<H', (0 if tag == b'BLES' else model) << 10 | 124) + b'DRSW' + tag[:3]
    body += b'NMGF' + struct.pack('<II', 0, 109)
    return bytes(body)


class ContainerTests(unittest.TestCase):
    def test_wireless_models_do_not_get_r7_keys(self):
        for model, name in ((24, 'R4W'), (28, 'R8W')):
            sections = parse(container(model))
            self.assertEqual(sections[0]['model'], name)
            self.assertEqual([s['offset'] for s in sections[:3]], [12, 533, 1054])
            self.assertEqual([s['version'] for s in sections[:3]], [142, 113, 127])
            self.assertTrue(all(s['key'] is None for s in sections[:3]))
            self.assertEqual(sections[3]['poi_count'], 2)
            self.assertEqual(sections[3]['encoding'], 'aes128')
            self.assertEqual(sections[4]['version'], 107)
            self.assertEqual(sections[5]['version'], 124)
            self.assertEqual(sections[-1]['version'], 109)

    def test_r7_legacy_keys_and_sound(self):
        buf = container(7, 'LRDB', extra_sound=True)
        sections = parse(buf, require_model=7)
        self.assertEqual([s['key'] for s in sections[:3]], [182, 184, 183])
        sound = sections[3]
        self.assertEqual((sound['name'], sound['key'], sound['version']), ('sound_dbnu', 225, 107))
        self.assertEqual(sections[4]['key'], 210)
        self.assertEqual(sections[4]['poi_count'], 2)
        for key in (182, 183, 184, 210, 225):
            data = bytes(range(256)) * 2
            self.assertEqual(encode_old_model(key, decode_old_model(key, data)), data)

    def test_r7_editors_reject_other_models(self):
        import rseries_patch
        import rseries_bands
        for model in (24, 28):
            for call in (lambda b: parse(b, require_model=7),
                         lambda b: rseries_patch.get_section(b, 'ui_nu'), rseries_bands.get_dsp):
                with self.assertRaisesRegex(FirmwareFormatError, 'requires R7'):
                    call(container(model))

    def test_truncation_at_every_byte(self):
        buf = container()
        for end in range(len(buf)):
            with self.subTest(end=end), self.assertRaises(FirmwareFormatError):
                parse(buf[:end])

    def test_invalid_tag_lengths_model_and_footer(self):
        buf = container()
        corruptions = []
        for offset, value in ((524, b'BADTAG!'), (533 + 512, b'\xff\xff'),
                              (12 + 3 * 521, b'NOPE'), (len(buf), b'extra')):
            corruptions.append(buf[:offset] + value + buf[offset + len(value):])
        huge = bytearray(buf)
        struct.pack_into('<I', huge, 4, 0xffffffff)
        corruptions.append(huge)
        for changed in corruptions:
            with self.assertRaises(FirmwareFormatError):
                parse(changed)

    def test_repack_preserves_all_framing_and_payloads(self):
        for model in (7, 24, 28):
            buf = container(model, 'LRDB' if model == 7 else 'AEUS')
            with tempfile.TemporaryDirectory() as tmp:
                manifest = extract_image(buf, tmp)
                self.assertEqual(repack_image(tmp), buf)
                self.assertEqual(sum(p['length'] for p in manifest['pieces']), len(buf))
                self.assertEqual(len(next(s for s in manifest['sections'] if s['name'] == 'BLES')['esp']['segments']), 1)
                self.assertEqual('decoded_file' in manifest['sections'][0], model == 7)

    def test_repack_rejects_changed_or_missing_piece_and_path_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = extract_image(container(), tmp)
            path = Path(tmp) / manifest['pieces'][0]['file']
            original = path.read_bytes()
            path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
            with self.assertRaisesRegex(FirmwareFormatError, 'changed extraction piece'):
                repack_image(tmp)
            path.unlink()
            with self.assertRaises(OSError):
                repack_image(tmp)
            path.write_bytes(original)
            manifest['pieces'][0]['file'] = '../outside.bin'
            (Path(tmp) / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(FirmwareFormatError, 'inside the extraction directory'):
                repack_image(tmp)

    def test_extract_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            extract_image(container(), tmp)
            with self.assertRaisesRegex(FirmwareFormatError, 'must be empty'):
                extract_image(container(), tmp)


class EspTests(unittest.TestCase):
    def test_esp_descriptor_checksum_and_optional_digest(self):
        for with_hash in (False, True):
            data = esp_image(with_hash)
            result = esp_image_info(data)
            self.assertEqual(result['chip'], 'ESP32-C3')
            self.assertEqual(result['image_size'], len(data))
            self.assertEqual(result['entry_point'], 0x403803fe)
            self.assertEqual(result['app']['idf_version'], 'v5.0.8')
            self.assertEqual(result['app']['build_date'], 'Feb  5 2026')
            self.assertEqual(result['hash_appended'], with_hash)

    def test_corrupt_checksum_digest_lengths_and_padding(self):
        data = esp_image()
        bad_length = bytearray(data)
        struct.pack_into('<I', bad_length, 28, 0xffffffff)
        bad_padding = bytearray(data)
        bad_padding[-2] = 1
        for corrupt in (data[:-1], data[:-1] + bytes([data[-1] ^ 1]),
                        esp_image(True)[:-1] + b'\x00', bad_length, bad_padding):
            with self.assertRaises(FirmwareFormatError):
                esp_image_info(corrupt)


@unittest.skipUnless(os.environ.get('UNIDEN_FIRMWARE_DIR'), 'set UNIDEN_FIRMWARE_DIR for local stock-image checks')
class StockImageTests(unittest.TestCase):
    def test_stock_images_and_byte_exact_repack(self):
        root = Path(os.environ['UNIDEN_FIRMWARE_DIR'])
        fixtures = [
            ('R8W_v142.113.127_db260702.bin', 'R8W', 4158628,
             '116584d1e688e4b7d7a448288c72d29fc93557382685cbaca0e32980a6ed7314',
             [142, 113, 127], 107, 0x2db88f),
            ('R4W_v127.128.123_db260702.bin', 'R4W', 4093092,
             'e7d6063a6241fe4bace7d766ba2357f4924648082ca518b9fa4332e9b648dbb3',
             [127, 128, 123], 108, 0x2cb88f),
        ]
        for filename, model, size, digest, versions, sound_version, esp_offset in fixtures:
            buf = (root / filename).read_bytes()
            self.assertEqual(hashlib.sha256(buf).hexdigest(), digest)
            info = inspect_image(buf)
            self.assertEqual((info['model'], info['size']), (model, size))
            self.assertEqual([s['version'] for s in info['sections'][:3]], versions)
            db = next(s for s in info['sections'] if s['name'] == 'GPSD:AEUS')
            self.assertEqual((db['poi_count'], db['version']), (13050, 20260702))
            sound = next(s for s in info['sections'] if s['name'] == 'STSD')
            self.assertEqual(sound['version'], sound_version)
            ble = next(s for s in info['sections'] if s['name'] == 'BLES')
            self.assertEqual((ble['offset'], ble['version']), (esp_offset, 124))
            self.assertEqual(len(ble['esp']['segments']), 6)
            self.assertEqual(ble['esp']['entry_point'], 0x403803fe)
            with tempfile.TemporaryDirectory() as tmp:
                extract_image(buf, tmp)
                self.assertEqual(repack_image(tmp), buf)


if __name__ == '__main__':
    unittest.main()
