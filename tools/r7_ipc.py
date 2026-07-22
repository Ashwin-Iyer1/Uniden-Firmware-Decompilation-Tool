#!/usr/bin/env python3
"""
Uniden R7 DSP serial-protocol codec — build and decode the framed messages the
DSP MCU accepts on its UART, including the "radar configuration" message that
carries the band enables and the Ka-segment mask.

This is a *runtime* interface, not a firmware edit: nothing here reflashes the
detector. The DSP applies a configuration message immediately and keeps it only
until reset (no handler in the image touches a flash program/erase path).

Wire format (proven from dsp_nu; see docs/DSP_PROTOCOL.md):

    <opcode|0x80> <payload: N uppercase-ASCII-hex chars>

    - the high bit marks the first byte of a frame, so any byte with bit7 set
      resynchronises the receiver
    - the payload is ASCII hex: 2 chars per u8, 4 chars per u16 (big-endian)
    - the final 2 payload chars are a checksum:
          csum = (opcode | 0x80) XOR every preceding payload char
      (XOR is over the ASCII characters, not the decoded bytes)
    - total payload length is fixed per opcode, from the table at dsp_nu 0xf498

Usage:
    python3 r7_ipc.py opcodes
    python3 r7_ipc.py decode  <frame>            # "90AB01..." or "90 AB 01 ..."
    python3 r7_ipc.py config  --ka 1,3,5 [--bands 0xHHHH] [--field N=VALUE]
    python3 r7_ipc.py selftest
"""
import sys

# opcode -> (payload length in ASCII chars, description)
# dsp_nu opcode/length table @ 0xf498, 6 entries x 8 bytes {u32 opcode, u32 len}
OPCODES = {
    0x0f: (4,  "short command"),
    0x10: (32, "radar configuration (bands + Ka-segment mask)"),
    0x11: (18, "secondary configuration"),
    0x32: (2,  "short command"),
    0x33: (2,  "short command"),
    0x70: (2,  "short command"),
}

# Field layout of opcode 0x10, in parse order (dsp_nu 0xc894..0xcc0e).
# 4 + 2*9 + 4 + 4 = 30 data chars + 2 checksum = 32, matching the opcode table.
CONFIG_FIELDS = [
    ("f1_u16",      2, "u16, first field"),
    ("f2",          1, "u8"),
    ("f3",          1, "u8"),
    ("f4",          1, "u8"),
    ("f5",          1, "u8"),
    ("f6",          1, "u8"),
    ("f7",          1, "u8"),
    ("f8_nibbles",  1, "u8, split into high/low nibble by the DSP"),
    ("f9",          1, "u8"),
    ("f10",         1, "u8"),
    ("band_bits",   2, "u16 band bitfield"),
    ("ka_mask",     2, "u16 Ka-segment mask (read if band_bits bit0 or bit2; applied only if both)"),
]

# band_bits bit -> role observed in the DSP (bands are gated by combinations of
# these; the mapping from bit to marketing band name is not yet pinned down)
BAND_BITS = {
    0:  "gates the Ka-segment path (with bit2); passed to the sweep builder",
    1:  "sweep-builder arg",
    2:  "gates the Ka-segment path (with bit0)",
    3:  "sweep-builder arg",
    4:  "sweep-builder arg",
    5:  "sweep-builder arg; also drives two extra config calls",
    6:  "selects special sweep group",
    7:  "selects special sweep group",
    9:  "OR'd with bit10 to select special sweep group",
    10: "OR'd with bit9 to select special sweep group",
}

# ka_mask bit N (N=0..8) -> DSP sweep-record mode id 0x10+N.
# The DSP overrides each record's flash enable_default with (mask >> N) & 1.
KA_SEGMENT_BITS = 9

def checksum(opcode, payload_wo_csum):
    """(opcode|0x80) XOR every payload ASCII char before the checksum."""
    c = opcode | 0x80
    for ch in payload_wo_csum:
        c ^= ord(ch)
    return c & 0xff

def build(opcode, values):
    """values: list of (width_in_bytes, integer). Returns the full frame as bytes."""
    if opcode not in OPCODES:
        raise SystemExit(f"unknown opcode {opcode:#x}")
    length, _ = OPCODES[opcode]
    body = "".join("%0*X" % (w * 2, v & ((1 << (w * 8)) - 1)) for w, v in values)
    if len(body) != length - 2:
        raise SystemExit(f"opcode {opcode:#x} needs {length-2} data chars, got {len(body)}")
    return bytes([opcode | 0x80]) + (body + "%02X" % checksum(opcode, body)).encode()

def parse_frame(raw):
    """raw: bytes of a whole frame. Returns (opcode, payload_str, csum_ok)."""
    if not raw:
        raise SystemExit("empty frame")
    first = raw[0]
    if not first & 0x80:
        raise SystemExit(f"first byte {first:#04x} has no frame bit (bit7)")
    opcode = first & 0x7f
    if opcode not in OPCODES:
        raise SystemExit(f"opcode {opcode:#x} is not in the DSP's table")
    length, _ = OPCODES[opcode]
    payload = raw[1:].decode("ascii", "replace")
    if len(payload) != length:
        raise SystemExit(f"opcode {opcode:#x} expects {length} payload chars, got {len(payload)}")
    body, got = payload[:-2], payload[-2:]
    ok = ("%02X" % checksum(opcode, body)) == got.upper()
    return opcode, payload, ok

def split_fields(payload, fields):
    out, i = [], 0
    for name, width, desc in fields:
        n = width * 2
        chunk = payload[i:i + n]
        out.append((name, chunk, int(chunk, 16), desc))
        i += n
    return out

def ka_list(mask):
    return [n + 1 for n in range(KA_SEGMENT_BITS) if mask >> n & 1]

def ka_mask_from(segments):
    m = 0
    for s in segments:
        if not 1 <= s <= KA_SEGMENT_BITS:
            raise SystemExit(f"Ka segment {s} out of range 1..{KA_SEGMENT_BITS}")
        m |= 1 << (s - 1)
    return m

def cmd_opcodes():
    print("DSP frame opcodes (table @ dsp_nu 0xf498):\n")
    print("  opcode  wire  payload chars  meaning")
    for op, (ln, desc) in sorted(OPCODES.items()):
        print(f"  {op:#04x}    {op|0x80:#04x}  {ln:>13}  {desc}")
    print("\nFrame = <wire byte> + payload; last 2 payload chars are the checksum.")

def cmd_decode(arg):
    txt = arg.replace(" ", "").replace("\t", "")
    if len(txt) % 2:
        raise SystemExit("frame hex must have an even number of digits")
    raw = bytes.fromhex(txt)
    opcode, payload, ok = parse_frame(raw)
    length, desc = OPCODES[opcode]
    print(f"opcode      {opcode:#04x} (wire {opcode|0x80:#04x}) — {desc}")
    print(f"payload     {payload}  ({len(payload)} chars)")
    print(f"checksum    {payload[-2:]}  {'OK' if ok else 'BAD — expected %02X' % checksum(opcode, payload[:-2])}")
    if opcode != 0x10:
        return
    print("\nfields:")
    for name, chunk, val, fdesc in split_fields(payload[:-2], CONFIG_FIELDS):
        print(f"  {name:<12} {chunk:<6} = {val:#06x}  {fdesc}")
    fields = dict((n, v) for n, _, v, _ in split_fields(payload[:-2], CONFIG_FIELDS))
    bands, mask = fields["band_bits"], fields["ka_mask"]
    print(f"\nband_bits {bands:#06x}:")
    for bit, role in sorted(BAND_BITS.items()):
        if bands >> bit & 1:
            print(f"  bit{bit:<2} set — {role}")
    segmented = bool(bands & 1) and bool(bands >> 2 & 1)
    print(f"\nKa-segment path: {'ACTIVE (bit0 and bit2 set)' if segmented else 'inactive'}")
    print(f"ka_mask {mask:#06x} — segments enabled: {ka_list(mask) or 'none'}")
    high = mask >> 9
    if high:
        print(f"  (bits 9-15 = {high:#x}: not Ka segments; bits 14/15 gate other sweep modes)")

def cmd_config(argv):
    segs, bands, extra = None, None, {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--ka":
            i += 1
            segs = [int(x) for x in argv[i].split(",") if x.strip()]
        elif a == "--bands":
            i += 1
            bands = int(argv[i], 0)
        elif a == "--field":
            i += 1
            k, v = argv[i].split("=", 1)
            extra[k] = int(v, 0)
        else:
            raise SystemExit(f"unknown option {a}")
        i += 1
    if segs is None:
        raise SystemExit("--ka is required (e.g. --ka 1,3,5, or --ka '' for none)")
    mask = ka_mask_from(segs)
    # bit0|bit2 must be set for the DSP to read the Ka-segment field at all
    if bands is None:
        bands = 0x0005
    if not (bands & 1 and bands >> 2 & 1):
        print("warning: band_bits bit0 and bit2 are not both set — the DSP will not take the\n"
              "         segmented sweep path, so the Ka mask will be ignored.", file=sys.stderr)
    vals = []
    for name, width, _ in CONFIG_FIELDS:
        if name == "band_bits":
            v = bands
        elif name == "ka_mask":
            v = mask
        else:
            v = extra.get(name, 0)
        vals.append((width, v))
    frame = build(0x10, vals)
    print(f"Ka segments enabled : {segs or 'none'}  (mask {mask:#06x})")
    print(f"band_bits           : {bands:#06x}")
    print(f"frame ({len(frame)} bytes)     : {frame.hex().upper()}")
    print(f"  wire byte         : {frame[0]:#04x}")
    print(f"  payload           : {frame[1:].decode()}")

def cmd_selftest():
    fails = []
    def check(what, got, want):
        if got != want:
            fails.append(f"{what}: got {got!r}, want {want!r}")

    # checksum definition: seed with opcode|0x80, XOR the ASCII chars
    body = "0" * 30
    want = 0x90
    for ch in body:
        want ^= ord(ch)
    check("checksum seed/domain", checksum(0x10, body), want)

    # every opcode's declared length must survive a build/parse round trip
    for op, (ln, _) in OPCODES.items():
        vals = [(1, 0)] * ((ln - 2) // 2)
        f = build(op, vals)
        check(f"frame length {op:#x}", len(f), 1 + ln)
        o, p, ok = parse_frame(f)
        check(f"opcode round trip {op:#x}", o, op)
        check(f"checksum verifies {op:#x}", ok, True)
        check(f"frame bit {op:#x}", f[0], op | 0x80)

    # config field widths must add up to the table's declared payload length
    chars = sum(w * 2 for _, w, _ in CONFIG_FIELDS)
    check("config field widths", chars + 2, OPCODES[0x10][0])

    # Ka mask <-> segment list round trip, and bit N -> mode id 0x10+N
    for segs in ([], [1], [9], [1, 5, 9], list(range(1, 10))):
        m = ka_mask_from(segs)
        check(f"ka round trip {segs}", ka_list(m), segs)
    check("segment 1 -> bit0", ka_mask_from([1]), 0x001)
    check("segment 9 -> bit8", ka_mask_from([9]), 0x100)

    # a built config frame decodes back to the same mask
    f = build(0x10, [(w, 0x005 if n == "band_bits" else ka_mask_from([2, 4]) if n == "ka_mask" else 0)
                     for n, w, _ in CONFIG_FIELDS])
    _, p, ok = parse_frame(f)
    fields = dict((n, v) for n, _, v, _ in split_fields(p[:-2], CONFIG_FIELDS))
    check("config decode checksum", ok, True)
    check("config decode ka_mask", ka_list(fields["ka_mask"]), [2, 4])
    check("config decode band_bits", fields["band_bits"], 0x005)

    # payload must be uppercase hex only — the DSP rejects lowercase a-f
    check("uppercase hex", f[1:].decode().upper(), f[1:].decode())

    # a corrupted payload must fail the checksum
    bad = bytearray(f)
    bad[5] = ord("F") if bad[5] != ord("F") else ord("0")
    check("corruption detected", parse_frame(bytes(bad))[2], False)

    if fails:
        print("SELFTEST FAILED")
        for f_ in fails:
            print("  " + f_)
        return 1
    print("selftest OK")
    return 0

def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd = sys.argv[1]
    if cmd == "opcodes":
        cmd_opcodes()
    elif cmd == "decode":
        cmd_decode(sys.argv[2])
    elif cmd == "config":
        cmd_config(sys.argv[2:])
    elif cmd == "selftest":
        return cmd_selftest()
    else:
        raise SystemExit(__doc__)
    return 0

if __name__ == "__main__":
    sys.exit(main())
