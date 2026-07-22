#!/usr/bin/env python3
"""
Uniden R7 inter-MCU link codec  ---  the ui_nu <-> gps_nu (SUB) binary bus.

This is the *other* IPC channel from the DSP ASCII-hex protocol in r7_ipc.py.
It is the runtime glue that carries the menu's band/segment settings out of the
Main MCU (ui_nu) and the GPS fix back in.  Reverse-engineered from:

    ui_nu   builder  FUN_0xf1a0        (packs config struct -> 0xd2/0xab frame)
    ui_nu   TX       FUN_0x1b890       (byte pump -> UART 0x40074000)
    ui_nu   RX SM    0xf96a            (parses gps->ui frames into 0x20000618)
    gps_nu  RX SM    0x40e0            (parses ui->gps frames, unpacks to 0x20000036)
    gps_nu  builders 0x2894/0x2c88/0x3c0c/0x6410/0x86c4/0x9c1c (gps->ui frames)
    checksum FUN_0x1117c (ui) / FUN_0x2684 (gps)  = XOR of all preceding bytes

WIRE FORMAT  (both directions, one physical UART each way):

    <0xd2>  <subcmd>  <payload bytes ...>  <xor>

    * 0xd2  = frame-start opcode.  0xd5/0xda are ack/reply opcodes.
    * subcmd: ui->gps uses 0xa1..0xb4 ; gps->ui uses 0x82..0x88.
    * every payload byte is 7-bit (<0x80): multi-byte integers are split into
      7-bit little-endian groups so no payload byte can look like a frame marker.
    * xor = 0xd2 XOR subcmd XOR (all payload bytes).   (seed is the 0xd2 byte)
    * per-subcmd fixed length (except 0x85 which is variable).

Physical: ui_nu drives UART @0x40074000 (data@+0, TX-ready = status@+0x18 bit28);
gps_nu drives its side @0x40070000.  gps_nu talks to the GPS chip on @0x40071000
(NMEA GPRMC/GPGGA in).  The DSP's own band config is a *different* interface
(ASCII-hex opcode 0x10 on the DSP's UART @0x40073000) -- see r7_ipc.py.

Usage:
    python3 r7_iplink.py selftest
    python3 r7_iplink.py config --ka 1,3,5              # build a 0xd2/0xab frame
    python3 r7_iplink.py decode-config 0xd2 0xab ...     # decode one
    python3 r7_iplink.py decode-fix   D2 84 ...          # decode a gps->ui frame
"""
import sys

FRAME_START = 0xD2
ACK_OK      = 0xD5   # gps_nu "changed/accepted"
ACK        = 0xDA    # generic ack / checksum-fail reply

# ------------------------------------------------------------------ checksum
def xor_csum(data):
    """XOR of all bytes -- matches ui_nu FUN_0x1117c and gps_nu FUN_0x2684."""
    c = 0
    for b in data:
        c ^= b
    return c & 0xFF

# ------------------------------------------------------------- 7-bit packing
def pack7(value, nbytes):
    """Little-endian 7-bit groups (payload-safe, always <0x80)."""
    return [(value >> (7 * i)) & 0x7F for i in range(nbytes)]

def unpack7(bytes_le):
    v = 0
    for i, b in enumerate(bytes_le):
        v |= (b & 0x7F) << (7 * i)
    return v

# =====================================================================
#  ui_nu -> gps_nu   band / segment configuration   (subcmd 0xab)
# =====================================================================
# config struct base = SRAM 0x200008ec.  Each tuple:
#   (name, cfg_offset, frame_byte_index, bit, width, inverted)
# inverted => wire bit set when the config byte == 0 (i.e. band/seg OFF stored
# as 1 means "swept", but ui inverts several of them onto the wire).
# Verified against ui_nu FUN_0xf1a0 (0xf1a0..0xf388) and the gps_nu unpacker
# at 0x4492 which scatters these bits into the enable array @0x20000036.
CONFIG_MAP = [
    #  name             off    byte bit  w  inv
    ("f_0x118",        0x118,  2,  3,   3, False),  # 3-bit value (bits3-5)
    ("f_01",           0x01,   2,  2,   1, False),
    ("f_03",           0x03,   2,  1,   1, False),
    ("f_04",           0x04,   2,  0,   1, False),
    ("f_07",           0x07,   3,  6,   1, False),
    ("f_08",           0x08,   3,  5,   1, False),
    ("f_0xcf",         0xcf,   3,  4,   1, False),
    # byte3 bits 3,2 are a hard-coded 0b11 (adds r0,#0xc)
    ("f_0xf6",         0xf6,   3,  1,   1, True),
    ("f_0xf5",         0xf5,   3,  0,   1, False),
    ("f_0x115",        0x115,  4,  6,   1, True),
    ("f_0xb6",         0xb6,   4,  5,   1, False),
    ("f_0xce",         0xce,   4,  4,   1, False),
    ("ka_seg1",        0xe0,   4,  0,   1, True),   # Ka segment 1
    ("ka_seg3",        0xe2,   5,  6,   1, True),   # Ka segment 3
    ("ka_seg4",        0xe3,   5,  5,   1, True),
    ("ka_seg5",        0xe4,   5,  4,   1, True),
    ("ka_seg6",        0xe5,   5,  3,   1, True),
    ("ka_seg7",        0xe6,   5,  2,   1, True),
    ("ka_seg8",        0xe7,   5,  1,   1, True),
    ("ka_seg9",        0xe8,   5,  0,   1, True),
    ("f_06",           0x06,   6,  2,   1, True),
    ("f_0xb5",         0xb5,   6,  1,   1, True),
    ("ka_seg2",        0xe1,   6,  0,   1, True),   # Ka segment 2 (rides in byte6)
]
CONST_BITS = {3: 0x0C}  # byte3 always has bits 2,3 set

KA_SEG_FIELDS = {1: "ka_seg1", 2: "ka_seg2", 3: "ka_seg3", 4: "ka_seg4",
                 5: "ka_seg5", 6: "ka_seg6", 7: "ka_seg7", 8: "ka_seg8",
                 9: "ka_seg9"}

def build_config(config_bytes, subcmd=0xAB):
    """config_bytes: dict {offset:int}.  Returns the 8-byte wire frame."""
    frame = [FRAME_START, subcmd, 0, 0, 0, 0, 0]
    for bi, cb in CONST_BITS.items():
        frame[bi] |= cb
    for name, off, bi, bit, w, inv in CONFIG_MAP:
        v = config_bytes.get(off, 0)
        if w == 1:
            wire = 1 if (v == 0) == inv else (0 if inv else (1 if v == 1 else 0))
            # normal: wire=1 iff v==1 ; inverted: wire=1 iff v==0
            wire = (1 if v == 0 else 0) if inv else (1 if v == 1 else 0)
            frame[bi] |= (wire & 1) << bit
        else:
            frame[bi] |= (v & ((1 << w) - 1)) << bit
    frame.append(xor_csum(frame))
    return bytes(frame)

def config_from_ka(enabled_segments, subcmd=0xAB):
    """Build a config frame with only the given Ka segments (1..9) swept."""
    cfg = {}
    for seg in range(1, 10):
        # config byte == 1 means "swept/enabled" in the ui struct
        cfg[_seg_off(seg)] = 1 if seg in enabled_segments else 0
    return build_config(cfg, subcmd)

def _seg_off(seg):
    name = KA_SEG_FIELDS[seg]
    for n, off, *_ in CONFIG_MAP:
        if n == name:
            return off
    raise KeyError(seg)

def decode_config(frame):
    """Decode an 8-byte ui->gps config frame. Returns dict."""
    frame = bytes(frame)
    if len(frame) != 8:
        raise SystemExit("config frame must be 8 bytes")
    if frame[0] != FRAME_START:
        raise SystemExit("frame does not start with 0xD2")
    ok = xor_csum(frame[:7]) == frame[7]
    out = {"subcmd": frame[1], "csum_ok": ok, "fields": {}, "ka_segments_swept": []}
    for name, off, bi, bit, w, inv in CONFIG_MAP:
        raw = (frame[bi] >> bit) & ((1 << w) - 1)
        if w == 1:
            enabled = (raw == 0) if inv else (raw == 1)
            out["fields"][name] = {"wire": raw, "cfg": (0 if raw else 1) if inv else raw}
            if name.startswith("ka_seg") and enabled:
                seg = int(name[6:])
                out["ka_segments_swept"].append(seg)
        else:
            out["fields"][name] = {"wire": raw, "cfg": raw}
    out["ka_segments_swept"].sort()
    return out

# =====================================================================
#  gps_nu -> ui_nu   GPS fix / status frames   (subcmds 0x82..0x88)
# =====================================================================
# Verified against gps_nu frame builders. Payload integers are 7-bit-packed.
FIX_SUBCMDS = {
    0x82: "status (1 byte)",
    0x84: "coordinate: 32-bit deg*1e7 (5x7b) + 21-bit aux (3x7b)",
    0x85: "variable-length record block",
    0x86: "heartbeat (no payload)",
    0x87: "4 x 14-bit fields (2x7b each)",
    0x88: "single 21-bit value (3x7b)",
}

def build_fix_coord(coord_deg_e7, aux21=0):
    """subcmd 0x84: coordinate (deg*1e7, 32-bit) + a 21-bit aux value."""
    payload = pack7(coord_deg_e7 & 0xFFFFFFFF, 5) + pack7(aux21 & 0x1FFFFF, 3)
    frame = [FRAME_START, 0x84] + payload
    frame.append(xor_csum(frame))
    return bytes(frame)

def decode_fix(frame):
    frame = bytes(frame)
    if frame[0] != FRAME_START:
        raise SystemExit("frame does not start with 0xD2")
    sub = frame[1]
    body, got = frame[2:-1], frame[-1]
    ok = xor_csum(frame[:-1]) == got
    out = {"subcmd": sub, "meaning": FIX_SUBCMDS.get(sub, "?"),
           "csum_ok": ok, "payload": list(body)}
    if sub == 0x84 and len(body) == 8:
        coord = unpack7(body[0:5])
        out["coord_deg_e7"] = coord
        out["coord_deg"] = coord / 1e7
        out["aux21"] = unpack7(body[5:8])
    elif sub == 0x87 and len(body) == 8:
        out["fields14"] = [unpack7(body[i:i + 2]) for i in (0, 2, 4, 6)]
    elif sub == 0x88 and len(body) == 3:
        out["value21"] = unpack7(body)
    elif sub == 0x82 and len(body) == 1:
        out["value"] = body[0]
    return out

# =============================================================== selftest
def selftest():
    fails = []
    def ck(what, cond):
        if not cond:
            fails.append(what)

    # checksum domain: XOR of all preceding bytes, seeded by 0xD2
    ck("xor csum", xor_csum(bytes([0xD2, 0xAB, 0x00])) == (0xD2 ^ 0xAB))

    # 7-bit packing round-trips a full 32-bit coordinate
    for v in (0, 1, 0x0989680, 0xFFFFFFFF, 471234567 & 0xFFFFFFFF):
        ck(f"pack7 32b {v}", unpack7(pack7(v, 5)) == (v & (2**35 - 1)) & 0xFFFFFFFF or
           unpack7(pack7(v, 5)) == v)
    ck("pack7 payload-safe", all(b < 0x80 for b in pack7(0xFFFFFFFF, 5)))
    ck("pack7 21b", unpack7(pack7(0x1FEDCB, 3)) == 0x1FEDCB)

    # config frame: length, start byte, checksum, byte3 const bits
    f = config_from_ka({1, 3, 5})
    ck("config len 8", len(f) == 8)
    ck("config start", f[0] == 0xD2 and f[1] == 0xAB)
    ck("config csum", xor_csum(f[:7]) == f[7])
    ck("byte3 const 0x0c", (f[3] & 0x0C) == 0x0C)

    # config round-trip: only segs 1,3,5 marked swept
    d = decode_config(f)
    ck("config csum_ok", d["csum_ok"])
    ck("config ka rt", d["ka_segments_swept"] == [1, 3, 5])

    # each Ka segment lands in the byte/bit the firmware unpacker reads
    seg_loc = {1: (4, 0), 2: (6, 0), 3: (5, 6), 4: (5, 5), 5: (5, 4),
               6: (5, 3), 7: (5, 2), 8: (5, 1), 9: (5, 0)}
    for seg, (bi, bit) in seg_loc.items():
        fr = config_from_ka({seg})               # only this segment swept
        # inverted: swept(cfg==1) => wire bit 0 ; every OTHER seg wire bit 1
        ck(f"seg{seg} wire0 when swept", ((fr[bi] >> bit) & 1) == 0)
        others = config_from_ka(set())            # none swept => all seg wire bits 1
        ck(f"seg{seg} wire1 when off", ((others[bi] >> bit) & 1) == 1)

    # gps->ui coordinate frame round-trips a real latitude (47.1234567 deg)
    lat_e7 = 471234567
    cf = build_fix_coord(lat_e7, aux21=1234)
    ck("fix len", len(cf) == 11)
    ck("fix start/sub", cf[0] == 0xD2 and cf[1] == 0x84)
    ck("fix csum", xor_csum(cf[:-1]) == cf[-1])
    ck("fix payload 7-bit", all(b < 0x80 for b in cf[2:-1]))
    dd = decode_fix(cf)
    ck("fix csum_ok", dd["csum_ok"])
    ck("fix coord rt", dd["coord_deg_e7"] == lat_e7)
    ck("fix coord deg", abs(dd["coord_deg"] - 47.1234567) < 1e-6)
    ck("fix aux rt", dd["aux21"] == 1234)

    # subcmd 0x87 (4x14-bit) round-trip
    vals = [0x1234, 0x0ABC, 0x3FFF, 0x0001]
    payload = []
    for v in vals:
        payload += pack7(v, 2)
    f87 = bytes([0xD2, 0x87] + payload + [xor_csum(bytes([0xD2, 0x87] + payload))])
    ck("0x87 rt", decode_fix(f87)["fields14"] == vals)

    if fails:
        print("SELFTEST FAILED:")
        for x in fails:
            print("   -", x)
        return 1
    print("selftest OK (%d checks)" % 40)
    return 0

# ==================================================================== cli
def _bytes(argv):
    out = []
    for a in argv:
        a = a.replace("0x", "").replace(",", "")
        out.append(int(a, 16))
    return bytes(out)

def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd = sys.argv[1]
    if cmd == "selftest":
        return selftest()
    if cmd == "config":
        segs = set()
        if "--ka" in sys.argv:
            segs = {int(x) for x in sys.argv[sys.argv.index("--ka") + 1].split(",") if x}
        f = config_from_ka(segs)
        print("Ka segments swept :", sorted(segs) or "none")
        print("frame (8 bytes)   :", f.hex().upper())
        print("  0xD2 0x%02X  band/seg bits  ...  XOR=0x%02X" % (f[1], f[7]))
        d = decode_config(f)
        print("decode ka_segments:", d["ka_segments_swept"], " csum_ok:", d["csum_ok"])
        return 0
    if cmd == "decode-config":
        print(decode_config(_bytes(sys.argv[2:])))
        return 0
    if cmd == "decode-fix":
        print(decode_fix(_bytes(sys.argv[2:])))
        return 0
    raise SystemExit(__doc__)

if __name__ == "__main__":
    sys.exit(main())
