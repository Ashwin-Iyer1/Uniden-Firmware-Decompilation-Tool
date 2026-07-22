#!/usr/bin/env python3
"""
Uniden R7 GPS / camera database editor  (LRDB, US "old" format).

Record = 16 bytes:  lat(float32 LE), lon(float32 LE),
                    f0(u8), speed(u8), f2(u8), category(u8), heading(u16 LE), 0xFFFF
The body is transpose+subtract-210 encoded, padded with 0xFF records to a 512-byte
boundary. Footer = encode(POI_count) + date(YYYYMMDD u32) + "LRDB".  No checksum.

The R7 requires records SORTED BY LATITUDE DESCENDING (it looks up nearby points by
latitude window) — so `build` always re-sorts. CSV row order does not matter.

Usage:
    python3 r7_gpsdb.py export <firmware.bin> <out.csv>
    python3 r7_gpsdb.py build  <in.csv> <template_firmware.bin> <out_firmware.bin> [YYYYMMDD]
    python3 r7_gpsdb.py add    <template_firmware.bin> <out_firmware.bin> <lat> <lon> \
                               [speed=0] [category=1] [heading=360] [YYYYMMDD]
"""
import sys, csv, struct, datetime
from r7_unpack import decode_old_model, encode_old_model, parse

KEY = 210  # US / LRDB

def locate_gpsdb(buf):
    """Return (body_off, body_len, len_field_off, tail_off) for the GPSD/LRDB section."""
    for f in parse(buf):
        if f['name'].startswith('GPSD') and f['term'] == 'LRDB':
            body_off = f['offset']
            body_len = f['length']
            len_field_off = body_off - 4          # u32 length field precedes body
            tail_off = body_off + body_len + 12 + 7  # skip footer(12) + "DRSWGDB"(7)
            return body_off, body_len, len_field_off, tail_off
    raise SystemExit("No LRDB GPS database found in this firmware.")

def export(fw, out_csv):
    buf = open(fw, 'rb').read()
    body_off, body_len, _, _ = locate_gpsdb(buf)
    body = decode_old_model(KEY, buf[body_off:body_off+body_len])
    n = body_len // 16
    rows = 0
    with open(out_csv, 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['lat', 'lon', 'type', 'speed', 'heading', 'f2', 'category'])
        for r in range(n):
            rec = body[r*16:r*16+16]
            if rec == b'\xff'*16:
                continue                          # padding
            lat, lon = struct.unpack_from('<ff', rec, 0)
            f0, speed, f2, cat = rec[8], rec[9], rec[10], rec[11]
            heading = struct.unpack_from('<H', rec, 12)[0]
            typ = 'speed' if f0 == 1 else 'redlight'   # f0: 1=speed cam, 2=red-light cam
            w.writerow([f'{lat:.6f}', f'{lon:.6f}', typ, speed, heading, f2, cat])
            rows += 1
    print(f"exported {rows} camera points -> {out_csv}")

def read_csv_points(in_csv):
    pts = []
    with open(in_csv, newline='') as fh:
        for row in csv.DictReader(fh):
            if 'type' in row and row['type']:                 # 'speed' | 'redlight'
                f0 = 1 if row['type'].strip().lower().startswith('speed') else 2
            else:
                f0 = int(row.get('f0', 2))
            pts.append((float(row['lat']), float(row['lon']),
                        f0, int(row.get('speed', 0)),
                        int(row.get('f2', 2)), int(row.get('category', 1)),
                        int(row.get('heading', 360))))
    return pts

def write_firmware(buf, points, out_fw, date=None):
    """points: list of (lat, lon, f0, speed, f2, cat, heading). Re-sorts by lat desc."""
    _body_off, _body_len, len_field_off, tail_off = locate_gpsdb(buf)
    points = sorted(points, key=lambda p: -p[0])   # latitude descending (required by device)
    recs = bytearray()
    for lat, lon, f0, speed, f2, cat, heading in points:
        recs += struct.pack('<ffBBBBHH', lat, lon, f0, speed, f2, cat, heading, 0xFFFF)
    n = len(points)
    new_body = bytes(recs)
    pad = (-len(new_body)) % 512
    new_body += b'\xff' * pad
    # assemble
    if date is None:
        date = int(datetime.date.today().strftime('%Y%m%d'))
    enc_body = encode_old_model(KEY, new_body)
    footer = encode_old_model(KEY, struct.pack('<I', n)) + struct.pack('<I', date) + b'LRDB'
    length_field = struct.pack('<I', len(new_body) + 12)
    out = bytes(buf[:len_field_off]) + length_field + enc_body + footer + b'DRSWGDB' + bytes(buf[tail_off:])
    open(out_fw, 'wb').write(out)
    print(f"built {n} points, body {len(new_body)} bytes (pad {pad}), date {date}")
    print(f"wrote {out_fw}  ({len(out)} bytes, was {len(buf)})")

def read_firmware_points(buf):
    body_off, body_len, _, _ = locate_gpsdb(buf)
    body = decode_old_model(KEY, buf[body_off:body_off+body_len])
    pts = []
    for r in range(body_len // 16):
        rec = body[r*16:r*16+16]
        if rec == b'\xff'*16:
            continue
        lat, lon = struct.unpack_from('<ff', rec, 0)
        pts.append((lat, lon, rec[8], rec[9], rec[10], rec[11],
                    struct.unpack_from('<H', rec, 12)[0]))
    return pts

def build(in_csv, template_fw, out_fw, date=None):
    buf = bytearray(open(template_fw, 'rb').read())
    write_firmware(buf, read_csv_points(in_csv), out_fw, date)

def add_point(template_fw, out_fw, lat, lon, speed=0, cat=1, heading=360, date=None):
    buf = bytearray(open(template_fw, 'rb').read())
    pts = read_firmware_points(buf)
    f0 = 1 if speed > 0 else 2        # speed limit => speed camera, else red-light camera
    pts.append((lat, lon, f0, speed, 2, cat, heading))
    print(f"adding {'SPEED' if f0==1 else 'RED-LIGHT'} camera lat={lat} lon={lon} "
          f"speed={speed} heading={heading} (total {len(pts)})")
    write_firmware(buf, pts, out_fw, date)

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__); sys.exit(1)
    cmd = sys.argv[1]
    if cmd == 'export':
        export(sys.argv[2], sys.argv[3])
    elif cmd == 'build':
        build(sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]) if len(sys.argv) > 5 else None)
    elif cmd == 'add':
        fw, out, lat, lon = sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5])
        speed = int(sys.argv[6]) if len(sys.argv) > 6 else 0
        cat = int(sys.argv[7]) if len(sys.argv) > 7 else 1
        heading = int(sys.argv[8]) if len(sys.argv) > 8 else 360
        date = int(sys.argv[9]) if len(sys.argv) > 9 else None
        add_point(fw, out, lat, lon, speed, cat, heading, date)
    else:
        print(__doc__); sys.exit(1)
