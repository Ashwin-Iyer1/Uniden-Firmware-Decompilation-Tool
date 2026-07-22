#!/usr/bin/env python3
"""
Uniden R7 GPS camera-alert SIMULATOR — replicates the gps_nu firmware matcher.

This mirrors the on-device consumer logic reverse-engineered from the GPS sub-MCU
(`gps_nu`, key 183). It lets you predict, off-device, whether a given camera record
would fire an alert for a given GPS fix (position + travel heading) — and in
particular it exercises the now-cracked meaning of record field **f2 (offset +10)**.

Firmware provenance (all addresses are gps_nu decoded/file offsets):
  * DB lives in EXTERNAL SPI FLASH (controller @0x40061000): u16 record-count at
    flash 0x0000, 16-byte records at flash 0x1000 (read primitive FUN_0x5dd0,
    cmd 0x03 + 24-bit address). A record is staged into RAM 0x20000720.
  * Per-record matcher = FUN_0x153c. Latitude bisection over the lat-sorted DB
    feeds it a nearby-latitude window (caller 0x1986).
  * f2 (rec+0x0a) = DIRECTIONAL MATCH MODE  (cracked here, FUN_0x153c 0x16e6..0x17a8):
        0 -> omnidirectional (heading ignored; display bearing = bearing-to-camera).
             The DB never stores 0; the fw coerces f2:=0 at runtime iff heading>360.
        1 -> UNIDIRECTIONAL: alert only if |travel_heading - rec.heading| <= 30 deg.
        2 -> BIDIRECTIONAL: alert if within 30 deg of rec.heading OR its reverse
             (rec.heading+180); on a reverse match the displayed heading is flipped.
  * category (rec+0x0b) = UNIT/REGION, used by distance-threshold fn FUN_0x8b2c:
        1 -> metric  (speed field is km/h; thresholds 60/80 km/h)
        2 -> imperial (speed field is mph; thresholds 35/50 mph, and speed is
             converted to km/h via *1.60934 when staged for display).
  * heading (rec+0x0c, u16) = approach bearing in degrees 1..360 (0x168 wraps).
  * f0 (rec+0x08) = 1 speed cam / 2 red-light cam (gated by user enables).

Distance thresholds (FUN_0x8b2c, metres): red-light -> 300; speed cam by unit+speed:
  metric  : <=60 ->600, <=80 ->760, else 900 ; imperial: <=35 ->600, <=50 ->760, else 900.
(The firmware's angular tolerance is a fixed 30 deg; the base distance is further
scaled by a user sensitivity setting 0..4 that we expose as --sens, default = max.)

Usage:
  python3 r7_alertsim.py stats  <firmware.bin>
  python3 r7_alertsim.py alerts <firmware.bin> <lat> <lon> <heading_deg> [--sens N] [--limit N]
  python3 r7_alertsim.py explain-f2 <firmware.bin>   # decode f2 as directionality + verify
"""
import sys, struct, math, collections
sys.path.insert(0, __import__('os').path.dirname(__file__))
from r7_unpack import decode_old_model, parse

KEY = 210  # US / LRDB

def load_records(fw):
    buf = open(fw, 'rb').read()
    bo = bl = None
    for f in parse(buf):
        if f['name'].startswith('GPSD') and f['term'] == 'LRDB':
            bo, bl = f['offset'], f['length']
    if bo is None:
        raise SystemExit("No LRDB GPS database found.")
    body = decode_old_model(KEY, buf[bo:bo+bl])
    recs = []
    for r in range(bl // 16):
        rec = body[r*16:r*16+16]
        if rec == b'\xff'*16:
            continue
        lat, lon = struct.unpack_from('<ff', rec, 0)
        f0, speed, f2, cat = rec[8], rec[9], rec[10], rec[11]
        heading = struct.unpack_from('<H', rec, 12)[0]
        recs.append(dict(lat=lat, lon=lon, f0=f0, speed=speed, f2=f2,
                         category=cat, heading=heading))
    return recs

def ang_diff(a, b):
    """Smallest absolute angular difference in degrees, folded to [0,180]."""
    d = abs((a - b) % 360)
    return d if d <= 180 else 360 - d

# ---- firmware-faithful directional gate: FUN_0x153c 0x16e6..0x17a8 -----------
def directional_pass(travel_heading, rec_heading, f2, tol=30):
    if rec_heading > 360:          # runtime coercion in fw
        f2 = 0
    if f2 == 0:                    # omnidirectional
        return True, travel_heading
    if f2 == 1:                    # unidirectional
        return (ang_diff(travel_heading, rec_heading) <= tol), rec_heading
    if f2 == 2:                    # bidirectional
        if ang_diff(travel_heading, rec_heading) <= tol:
            return True, rec_heading
        rev = (rec_heading + 180) % 360
        if ang_diff(travel_heading, rev) <= tol:
            return True, rev       # fw flips displayed heading to the reverse
        return False, rec_heading
    return True, rec_heading       # unknown f2 -> permissive

# ---- distance threshold: FUN_0x8b2c ----------------------------------------
def distance_threshold_m(f0, speed, category, sens=4):
    if f0 == 2:                    # red-light camera
        return 300
    # speed camera
    if category == 1:              # metric (km/h)
        base = 600 if speed <= 60 else (760 if speed <= 80 else 900)
    else:                          # imperial (mph)
        base = 600 if speed <= 35 else (760 if speed <= 50 else 900)
    # sensitivity 0..4 scales the base alert distance (0 = nearest only)
    return int(base * (sens + 1) / 5)

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2-lat1); dl = math.radians(lon2-lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(a))

def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2-lon1)
    y = math.sin(dl)*math.cos(p2)
    x = math.cos(p1)*math.sin(p2) - math.sin(p1)*math.cos(p2)*math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360

DIRLABEL = {0: 'omni', 1: 'uni(1-way)', 2: 'bi(2-way)'}
UNIT = {1: 'metric-km/h', 2: 'imperial-mph'}

def cmd_stats(fw):
    recs = load_records(fw)
    f2c = collections.Counter(r['f2'] for r in recs)
    print(f"records: {len(recs)}")
    for f2 in sorted(f2c):
        sub = [r for r in recs if r['f2'] == f2]
        omni = sum(1 for r in sub if r['heading'] == 360)
        print(f"  f2={f2} [{DIRLABEL.get(f2,'?')}]: {len(sub):5d}  "
              f"heading==360: {omni} ({100*omni/len(sub):.1f}%)  "
              f"cat1/cat2: {sum(1 for r in sub if r['category']==1)}/"
              f"{sum(1 for r in sub if r['category']==2)}")

def cmd_alerts(fw, lat, lon, heading, sens=4, limit=20):
    recs = load_records(fw)
    hits = []
    for r in recs:
        # coarse latitude window first (fw uses ~0.036 deg lat bisection window)
        if abs(r['lat'] - lat) > 0.05:
            continue
        d = haversine_m(lat, lon, r['lat'], r['lon'])
        thr = distance_threshold_m(r['f0'], r['speed'], r['category'], sens)
        if d > thr:
            continue
        ok, disp_head = directional_pass(heading, r['heading'], r['f2'])
        if not ok:
            continue
        hits.append((d, r, disp_head))
    hits.sort(key=lambda x: x[0])
    print(f"fix ({lat:.5f},{lon:.5f}) heading {heading}deg sens {sens}: "
          f"{len(hits)} camera(s) would alert")
    for d, r, dh in hits[:limit]:
        typ = 'speed' if r['f0'] == 1 else 'redlight'
        print(f"  {d:6.0f} m  {typ:8s}  speed={r['speed']:3d} {UNIT.get(r['category'],'?'):12s} "
              f"f2={r['f2']}[{DIRLABEL.get(r['f2'],'?')}] rec.head={r['heading']:3d} disp={dh:3.0f}")

def cmd_explain_f2(fw):
    recs = load_records(fw)
    print("f2 (record offset +10) = DIRECTIONAL MATCH MODE (from gps_nu FUN_0x153c):")
    print("  f2=1 unidirectional (alert within +-30deg of stored heading)")
    print("  f2=2 bidirectional  (alert within +-30deg of stored heading OR its reverse)")
    print("  f2=0 omnidirectional (runtime fallback when heading>360)\n")
    # verification: a bidirectional camera must alert from BOTH approaches, a
    # unidirectional one only from its own approach.
    tests = 0
    for r in recs:
        if r['heading'] in (0, 360):
            continue
        fwd = r['heading']; rev = (r['heading'] + 180) % 360
        u_fwd, _ = directional_pass(fwd, r['heading'], 1)
        u_rev, _ = directional_pass(rev, r['heading'], 1)
        b_fwd, _ = directional_pass(fwd, r['heading'], 2)
        b_rev, _ = directional_pass(rev, r['heading'], 2)
        assert u_fwd and not u_rev, "f2=1 must pass forward only"
        assert b_fwd and b_rev,     "f2=2 must pass both ways"
        tests += 1
        if tests >= 5000:
            break
    print(f"self-check OK on {tests} records: f2=1 alerts one-way, f2=2 alerts both ways.")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    cmd, fw = sys.argv[1], sys.argv[2]
    if cmd == 'stats':
        cmd_stats(fw)
    elif cmd == 'explain-f2':
        cmd_explain_f2(fw)
    elif cmd == 'alerts':
        lat, lon, heading = float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
        sens = 4; limit = 20
        if '--sens' in sys.argv:  sens = int(sys.argv[sys.argv.index('--sens')+1])
        if '--limit' in sys.argv: limit = int(sys.argv[sys.argv.index('--limit')+1])
        cmd_alerts(fw, lat, lon, heading, sens, limit)
    else:
        print(__doc__); sys.exit(1)
