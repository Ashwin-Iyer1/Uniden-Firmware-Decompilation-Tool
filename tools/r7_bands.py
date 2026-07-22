#!/usr/bin/env python3
"""
Uniden R7 DSP band/frequency table tool (dsp_nu).

The DSP's real RF detection frequencies live in a COEFFICIENT TABLE at decoded
dsp_nu offset 0x0dd34: 33 records x 16 bytes:

    +0x00 u32 band_type   1=X 2=K 3/6=Ka(low-mix) 4=Ka(high-mix) 7=K(alt) 8=spot
    +0x04 u32 freq_low    RF window low edge, in kHz  (kHz/1000 = MHz)
    +0x08 u32 freq_high   RF window high edge, in kHz
    +0x0c u32 ifconst     per-band-group IF/mix constant (NOT a per-record freq)

Every 20-byte sweep-schedule record's +0x10 field is a POINTER (decoded dsp_nu
file offset) into this table -- i.e. the "tuner_code" is really &coeff_record.
The PLL (FUN_0x47e0) is programmed straight from freq_high with a 25 MHz reference
fractional-N divider, so the numbers in this table ARE the RF frequencies (no
hidden harmonic multiplier at the firmware level). To move a detection band you
edit freq_low / freq_high here -- a clean data-edit, length-preserving.

CAUTION: many sweep records across different groups point at the SAME coeff
record (e.g. the X record 0xdd34 is referenced by almost every group), so one
edit here changes that band for every mode that uses it. band_type and ifconst
are coupled to hardware/DSP code -- leave them alone (see docs/FIRMWARE_MAP.md).

Usage:
    python3 r7_bands.py dump    <fw.bin>
    python3 r7_bands.py setfreq <fw.bin> <rec_idx> <lo_MHz> <hi_MHz> <out.bin>
    python3 r7_bands.py verify  <orig_fw.bin> <patched_fw.bin>
"""
import sys, struct
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from r7_unpack import decode_old_model, encode_old_model, parse

COEFF_OFF = 0x0dd34          # decoded dsp_nu offset of coeff table
COEFF_N   = 33               # records
COEFF_SZ  = 16
BANDNAME  = {1: 'X', 2: 'K', 3: 'Ka(lo-mix)', 4: 'Ka(hi-mix)',
             6: 'Ka(narrow)', 7: 'K(alt)', 8: 'spot/instant'}

def get_dsp(buf):
    for f in parse(buf):
        if f['name'] == 'dsp_nu':
            return f['offset'], f['length'], f['key']
    raise SystemExit("dsp_nu not found")

def load_dec(fw):
    buf = open(fw, 'rb').read()
    off, length, key = get_dsp(buf)
    dec = bytearray(decode_old_model(key, buf[off:off+length]))
    return buf, off, length, key, dec

def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]

def records(dec):
    for i in range(COEFF_N):
        o = COEFF_OFF + i * COEFF_SZ
        yield i, o, u32(dec, o), u32(dec, o+4), u32(dec, o+8), u32(dec, o+12)

def dump(fw):
    _, _, _, _, dec = load_dec(fw)
    print(f"dsp_nu coeff table @0x{COEFF_OFF:05x}  ({COEFF_N} records x {COEFF_SZ}B)\n")
    print(f"{'idx':>3} {'addr':>7} {'ptr(=code)':>10} {'band':>12} "
          f"{'lo_MHz':>9} {'hi_MHz':>9} {'ctr_MHz':>9} {'ifconst':>9}")
    for i, o, bt, lo, hi, c in records(dec):
        ctr = (lo + hi) / 2 / 1000
        print(f"{i:3d} 0x{o:05x} 0x{o:08x} {BANDNAME.get(bt,'?%d'%bt):>12} "
              f"{lo/1000:9.2f} {hi/1000:9.2f} {ctr:9.3f} {c:9d}")

def setfreq(fw, idx, lo_mhz, hi_mhz, out):
    buf, off, length, key, dec = load_dec(fw)
    if not (0 <= idx < COEFF_N):
        raise SystemExit(f"rec_idx must be 0..{COEFF_N-1}")
    o = COEFF_OFF + idx * COEFF_SZ
    bt = u32(dec, o)
    old_lo, old_hi = u32(dec, o+4), u32(dec, o+8)
    lo_khz = int(round(lo_mhz * 1000))
    hi_khz = int(round(hi_mhz * 1000))
    if lo_khz > hi_khz:
        raise SystemExit("lo must be <= hi")
    for v in (lo_khz, hi_khz):
        if not (0 <= v <= 0xFFFFFFFF):
            raise SystemExit("frequency out of u32 range")
    struct.pack_into('<I', dec, o+4, lo_khz)
    struct.pack_into('<I', dec, o+8, hi_khz)
    enc = encode_old_model(key, bytes(dec))
    assert len(enc) == length, (len(enc), length)
    newfw = buf[:off] + enc + buf[off+length:]
    assert len(newfw) == len(buf)
    open(out, 'wb').write(newfw)
    # round-trip verify
    ok = _verify(buf, newfw, expect={idx: (lo_khz, hi_khz)})
    print(f"rec[{idx}] band={BANDNAME.get(bt,bt)}: "
          f"lo {old_lo/1000:.2f}->{lo_khz/1000:.2f} MHz, "
          f"hi {old_hi/1000:.2f}->{hi_khz/1000:.2f} MHz")
    print(f"wrote {out}  ({len(newfw)} bytes, {8} bytes changed)  round-trip: {'OK' if ok else 'FAIL'}")
    if not ok:
        raise SystemExit(1)

def _verify(orig, patched, expect=None):
    """Confirm container parses, dsp_nu length preserved, and only the coeff
    edits differ (all other decoded bytes byte-identical)."""
    if len(orig) != len(patched):
        print("  [x] file length changed"); return False
    o1, l1, k1 = get_dsp(orig)
    o2, l2, k2 = get_dsp(patched)
    if (o1, l1, k1) != (o2, l2, k2):
        print("  [x] dsp_nu section moved/resized"); return False
    d1 = bytearray(decode_old_model(k1, orig[o1:o1+l1]))
    d2 = bytearray(decode_old_model(k2, patched[o2:o2+l2]))
    diffs = [i for i in range(len(d1)) if d1[i] != d2[i]]
    inband = all(COEFF_OFF <= i < COEFF_OFF + COEFF_N*COEFF_SZ for i in diffs)
    if not inband:
        print(f"  [x] changes outside coeff table: {[hex(i) for i in diffs[:8]]}"); return False
    if expect:
        for idx, (lo, hi) in expect.items():
            o = COEFF_OFF + idx*COEFF_SZ
            if (u32(d2, o+4), u32(d2, o+8)) != (lo, hi):
                print(f"  [x] rec[{idx}] not written as expected"); return False
    # every other section must be byte-identical in the container
    if orig[:o1] != patched[:o1] or orig[o1+l1:] != patched[o2+l2:]:
        print("  [x] bytes outside dsp_nu changed"); return False
    return True

def verify(orig_fw, patched_fw):
    orig = open(orig_fw, 'rb').read()
    patched = open(patched_fw, 'rb').read()
    ok = _verify(orig, patched)
    # report the diffs as coeff-record edits
    o1, l1, k1 = get_dsp(orig); o2, l2, k2 = get_dsp(patched)
    d1 = decode_old_model(k1, orig[o1:o1+l1]); d2 = decode_old_model(k2, patched[o2:o2+l2])
    for i in range(COEFF_N):
        o = COEFF_OFF + i*COEFF_SZ
        if d1[o:o+16] != d2[o:o+16]:
            print(f"  rec[{i}] @0x{o:05x}: "
                  f"lo {u32(d1,o+4)/1000:.2f}->{u32(d2,o+4)/1000:.2f}  "
                  f"hi {u32(d1,o+8)/1000:.2f}->{u32(d2,o+8)/1000:.2f} MHz")
    print("verify:", "OK (only coeff freqs changed, length preserved)" if ok else "FAIL")
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    cmd = sys.argv[1]
    if cmd == 'dump':
        dump(sys.argv[2])
    elif cmd == 'setfreq':
        setfreq(sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), sys.argv[6])
    elif cmd == 'verify':
        verify(sys.argv[2], sys.argv[3])
    else:
        print(__doc__); sys.exit(1)
