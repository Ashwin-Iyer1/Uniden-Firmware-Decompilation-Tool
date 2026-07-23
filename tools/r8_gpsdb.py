#!/usr/bin/env python3
"""
r8_gpsdb.py — recover the Uniden R8 GPS/camera database (GPSD:AEUS) WITHOUT the AES key.

The R8 encrypts its camera database with AES-128-ECB (see docs/R8_FORMAT.md). ECB is a codebook:
identical plaintext blocks encrypt to identical ciphertext blocks. The R7 US database
(decoded via the reversible transpose) is byte-identical *in plaintext* to the R8 AEUS body, so it
is a complete known-plaintext codebook. We map each R8 ciphertext block to the R7 plaintext block
at the same index and PROVE the mapping is conflict-free — that proof is what makes the decode
trustworthy without ever recovering K_db.

Records are the same 16-byte schema as the R7 DB (see docs/GPS_DATABASE.md):
    lat  f32le | lon f32le | f0 u8 | speed u8 | f2 u8 | category u8 | heading u16le | 0xFFFF

Usage:
    python3 tools/r8_gpsdb.py verify <R8.bin>                 # prove the ECB codebook is consistent
    python3 tools/r8_gpsdb.py export <R8.bin> <out.csv>       # decode + write camera CSV
    python3 tools/r8_gpsdb.py oracle <R8.bin>                 # emit AES key-test pairs (E(pt)->ct)

Limitation: recovers blocks present in the R7 codebook. It is complete for databases whose content
matches R7's (as the shipping R8 US DB does); genuinely new records would need the real K_db.
"""
import os, sys, struct, csv, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R7_PLAINTEXT_DB = os.path.join(ROOT, 'decoded', 'GPSD_LRDB.dec.bin')

# AEUS section location within R8_v143.113.126. `find_aeus` re-derives it for other builds.
AEUS_IDENT = b'AEUS'


def find_aeus(fw):
    """Return (offset, enc_len) of the AES-128-ECB GPS-DB body, from the plaintext GPSD tag header.

    Tag layout (plaintext, little-endian):
        "GPSD" | u32 subtype | u32 clen | body[enc_len] | u32 poi | u32 date | ident("AEUS")
    where clen counts the body plus the 12-byte trailing meta, so enc_len = clen - 12. The body is
    the AES-128-ECB ciphertext; the meta is plaintext.
    """
    gpsd = fw.find(b'GPSD')
    if gpsd < 0:
        raise SystemExit("no GPSD tag found — not an R8-style container")
    clen = struct.unpack_from('<I', fw, gpsd + 8)[0]
    body = gpsd + 12
    enc_len = clen - 12
    ident = fw[body + enc_len + 8: body + enc_len + 12]
    if ident != AEUS_IDENT:
        raise SystemExit("GPSD body does not end in the AEUS ident (got %r) — unexpected layout" % ident)
    return body, enc_len


def load_codebook():
    if not os.path.exists(R7_PLAINTEXT_DB):
        raise SystemExit(
            "need the R7 plaintext DB as a codebook: %s\n"
            "  produce it with: python3 tools/r7_unpack.py extract <R7.bin> decoded/" % R7_PLAINTEXT_DB)
    return open(R7_PLAINTEXT_DB, 'rb').read()


def build_map(ct, pt):
    """Map ct block -> pt block by shared index; return (mapping, fwd_conflicts, rev_conflicts)."""
    n = min(len(ct), len(pt)) // 16
    fwd, rev, fc, rc = {}, {}, 0, 0
    for i in range(n):
        c = ct[i*16:i*16+16]
        p = pt[i*16:i*16+16]
        if c in fwd and fwd[c] != p:
            fc += 1
        fwd[c] = p
        if p in rev and rev[p] != c:
            rc += 1
        rev[p] = c
    return fwd, rev, fc, rc, n


def decode(fw):
    """Return (plaintext_bytes, coverage_fraction). Blocks absent from the codebook become b'\\x00'*16."""
    off, clen = find_aeus(fw)
    ct = fw[off:off+clen]
    pt_codebook = load_codebook()
    fwd, rev, fc, rc, n = build_map(ct, pt_codebook)
    if fc or rc:
        raise SystemExit("ECB codebook is INCONSISTENT (fwd=%d rev=%d) — R8 DB is not R7-derived" % (fc, rc))
    out = bytearray()
    resolved = 0
    for i in range(len(ct) // 16):
        c = ct[i*16:i*16+16]
        if c in fwd:
            out += fwd[c]; resolved += 1
        else:
            out += b'\x00' * 16
    cov = resolved / (len(ct)//16) if ct else 0.0
    return bytes(out), cov, off, clen


def parse_records(pt):
    recs = []
    for i in range(len(pt) // 16):
        rec = pt[i*16:i*16+16]
        if rec == b'\xff' * 16:
            continue
        lat, lon = struct.unpack_from('<ff', rec, 0)
        f0, speed, f2, cat = rec[8], rec[9], rec[10], rec[11]
        heading, tail = struct.unpack_from('<HH', rec, 12)
        recs.append((lat, lon, f0, speed, f2, cat, heading, tail))
    return recs


def cmd_verify(fw):
    off, clen = find_aeus(fw)
    ct = fw[off:off+clen]
    pt = load_codebook()
    fwd, rev, fc, rc, n = build_map(ct, pt)
    dup = sum(1 for v in collections.Counter(ct[i*16:i*16+16] for i in range(n)).values() if v > 1)
    print("AEUS body: off=0x%x len=%d (%d blocks)" % (off, clen, n))
    print("distinct ct=%d pt=%d ; duplicate ct blocks=%d" % (len(fwd), len(rev), dup))
    print("forward conflicts=%d  reverse conflicts=%d" % (fc, rc))
    print("VERDICT:", "PROVEN — R8 AEUS == ECB(R7 LRDB)" if fc == 0 and rc == 0 else "FAILED")


def cmd_export(fw, out_csv):
    pt, cov, off, clen = decode(fw)
    recs = parse_records(pt)
    with open(out_csv, 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['idx', 'lat', 'lon', 'type', 'f0', 'speed', 'f2', 'category', 'heading', 'tail'])
        for i, (lat, lon, f0, speed, f2, cat, hdg, tail) in enumerate(recs):
            typ = 'speed' if f0 == 1 else ('redlight' if f0 == 2 else 'other%d' % f0)
            w.writerow([i, '%.6f' % lat, '%.6f' % lon, typ, f0, speed, f2, cat, hdg, '0x%04x' % tail])
    poi, date = struct.unpack_from('<II', fw, off + clen)
    print("coverage=%.4f  records=%d  footer poi=%d date=%d -> %s" % (cov, len(recs), poi, date, out_csv))


def cmd_oracle(fw):
    """Emit AES-128-ECB key-test pairs: for candidate key K, decrypt(ct)==pt must hold."""
    off, clen = find_aeus(fw)
    ct = fw[off:off+clen]
    pt = load_codebook()
    fwd, rev, fc, rc, n = build_map(ct, pt)
    pc = collections.Counter(pt[i*16:i*16+16] for i in range(n))
    print("# AES-128-ECB key-test oracle for K_db (decrypt(ct) must equal pt):")
    for name, pblk in [('FF16', b'\xff'*16), ('ZERO16', b'\x00'*16), ('block0', pt[0:16])]:
        c = rev.get(pblk)
        if c:
            print("  %-8s pt=%s ct=%s x%d" % (name, pblk.hex(), c.hex(), pc[pblk]))
    for rank, (pblk, cnt) in enumerate(pc.most_common(4)):
        print("  top%-5d pt=%s ct=%s x%d" % (rank, pblk.hex(), rev[pblk].hex(), cnt))


def main(argv):
    if len(argv) < 3:
        print(__doc__); return 1
    cmd, fwpath = argv[1], argv[2]
    fw = open(fwpath, 'rb').read()
    if cmd == 'verify':
        cmd_verify(fw)
    elif cmd == 'export':
        if len(argv) < 4:
            print("export needs <out.csv>"); return 1
        cmd_export(fw, argv[3])
    elif cmd == 'oracle':
        cmd_oracle(fw)
    else:
        print("unknown command:", cmd); print(__doc__); return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
