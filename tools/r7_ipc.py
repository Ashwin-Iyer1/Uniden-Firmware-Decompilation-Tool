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
    - the payload is ASCII hex: 2 chars per byte, low byte first for u16
    - for opcodes 0x0f/0x10/0x11, the final 2 payload chars are a checksum:
          csum = (opcode | 0x80) XOR every preceding payload char
      (XOR is over the ASCII characters, not the decoded bytes)
    - total payload length is fixed per opcode, from the table at dsp_nu 0xf498
    - short opcodes 0x32/0x33/0x70 parse their two chars without a separate
      checksum gate; this codec's XOR result for them is a host convention

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
    ("f1_u16",      2, "u16; UI encodes cfg[0x0f,0x0d,0xb1]"),
    ("f2",          1, "u8; UI cfg[0xdd]"),
    ("f3",          1, "u8; UI cfg[0xde]"),
    ("f4",          1, "u8; UI cfg[0xdf]"),
    ("f5",          1, "u8; UI cfg[0x112]"),
    ("f6",          1, "u8; UI cfg[0x113]"),
    ("f7",          1, "u8; UI cfg[0x114]"),
    ("f8_nibbles",  1, "u8; UI cfg[0xc9]/state, split high/low nibble by DSP"),
    ("f9",          1, "u8; UI cfg[0x06,0x07,0x08]/builder argument"),
    ("f10",         1, "u8; UI cfg[0xcb,0xcc]"),
    ("band_bits",   2, "u16 band bitfield"),
    ("ka_mask",     2, "u16 Ka-segment mask (read if bit0 or bit2; see sweep-path status)"),
]

# band_bits bit -> role observed in dsp_nu 0xcaf6..0xcc06, 0x8908,
# 0x53c0 and 0x5788. Frequency labels follow the selected coefficient records;
# UI 0xd61c supplies the config-byte map in docs/DSP_PROTOCOL.md; frequency
# descriptions alone do not establish every marketing/menu label.
BAND_BITS = {
    0:  "selects nine Ka segments (bit1 takes priority unless bit2 is set)",
    1:  "selects three narrow Ka windows in the nine-group builder",
    2:  "with bit0, selects the combined K/Ka segment table",
    3:  "selects wide K table (23.899250-24.251002 GHz), unless bit4 is set",
    4:  "selects narrow K table (24.079998-24.200002 GHz)",
    5:  "sweep-builder arg; also drives two extra config calls",
    6:  "selects special sweep group",
    7:  "selects special sweep group",
    9:  "OR'd with bit10 to select special sweep group",
    10: "OR'd with bit9 to select special sweep group",
}

# ka_mask bit N (N=0..8) -> DSP sweep-record mode id 0x10+N.
# Both sweep builders override segment enable_default with (mask >> N) & 1.
KA_SEGMENT_BITS = 9

def ka_mask_status(bands):
    """Static sweep selection; does not assert UART reachability or RF activity.

    0xcba2 reads the mask for bit0 OR bit2. 0x8998 selects the 36-record
    builder for bit0 AND bit2. Otherwise 0x5788 prefers bit1's 16-record
    narrow table over bit0's 28-record segment table; 0x5938 gates masking
    on bit0. Counts include the two group delimiters.
    """
    if bands & 1 and bands & 4:
        return True, True, "36-record combined K/Ka segment table"
    if bands & 1 and not bands & 2:
        return True, True, "28-record Ka segment table"
    if bands & 1:
        return True, False, "bit1 selects a 16-record narrow Ka table with no segment records"
    if bands & 4:
        return True, False, "bit0 is clear; no Ka segment masking"
    return False, False, "bit0 and bit2 are clear; mask is not parsed"

def checksum(opcode, payload_wo_csum):
    """(opcode|0x80) XOR every payload ASCII char before the checksum."""
    c = opcode | 0x80
    for ch in payload_wo_csum:
        c ^= ord(ch)
    return c & 0xff

def build(opcode, values):
    """Encode (width_in_bytes, integer) values as low-byte-first ASCII pairs."""
    if opcode not in OPCODES:
        raise SystemExit(f"unknown opcode {opcode:#x}")
    length, _ = OPCODES[opcode]
    # ui_nu 0xd61c emits low byte before high byte through 0xdbf0;
    # dsp_nu 0xcea4 decodes those pairs into adjacent little-endian bytes.
    body = "".join((v & ((1 << (w * 8)) - 1)).to_bytes(w, "little").hex().upper()
                   for w, v in values)
    if len(body) != length - 2:
        raise SystemExit(f"opcode {opcode:#x} needs {length-2} data chars, got {len(body)}")
    return bytes([opcode | 0x80]) + (body + "%02X" % checksum(opcode, body)).encode()

def parse_frame(raw):
    """Return (opcode, payload_str, XOR_ok); short-op XOR is not an acceptance gate."""
    if not raw:
        raise SystemExit("empty frame")
    first = raw[0]
    if not first & 0x80:
        raise SystemExit(f"first byte {first:#04x} has no frame bit (bit7)")
    opcode = first & 0x7f
    if opcode not in OPCODES:
        raise SystemExit(f"opcode {opcode:#x} is not in the DSP's table")
    length, _ = OPCODES[opcode]
    # dsp_nu 0xdb76 accepts only '0'..'9' and 'A'..'F'; the checksum
    # itself is decoded through that same routine. Never normalize wire data.
    if any(ch not in b"0123456789ABCDEF" for ch in raw[1:]):
        raise SystemExit("DSP payload must contain uppercase ASCII hex only (0-9, A-F)")
    payload = raw[1:].decode("ascii")
    if len(payload) != length:
        raise SystemExit(f"opcode {opcode:#x} expects {length} payload chars, got {len(payload)}")
    body, got = payload[:-2], payload[-2:]
    ok = ("%02X" % checksum(opcode, body)) == got
    return opcode, payload, ok

def split_fields(payload, fields):
    out, i = [], 0
    for name, width, desc in fields:
        n = width * 2
        chunk = payload[i:i + n]
        out.append((name, chunk, int.from_bytes(bytes.fromhex(chunk), "little"), desc))
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
    print("\nFrame = <wire byte> + payload; opcodes 0x0f/0x10/0x11 end with a checksum.")
    print("Short opcodes parse two hex characters without a separate checksum gate.")

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
    if opcode in (0x32, 0x33, 0x70):
        print("            (host XOR convention; DSP dispatch has no separate checksum gate)")
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
    _, applied, reason = ka_mask_status(bands)
    print(f"\nKa mask: {'applied to segment records' if applied else 'not applied'} — {reason}")
    print(f"ka_mask {mask:#06x} — requested segments: {ka_list(mask) or 'none'}")
    high = mask >> 9
    if high:
        print(f"  (bits 9-15 = {high:#x}: not Ka segments; bits 14/15 gate combined-table K sweeps)")

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
    # Preserve the historical default: both bits select the combined table.
    if bands is None:
        bands = 0x0005
    _, applied, reason = ka_mask_status(bands)
    if not applied:
        print(f"warning: Ka mask is not applied — {reason}.", file=sys.stderr)
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
    print(f"Ka segments requested: {segs or 'none'}  (mask {mask:#06x})")
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
