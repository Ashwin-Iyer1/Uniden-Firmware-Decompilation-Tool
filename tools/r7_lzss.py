#!/usr/bin/env python3
"""
Encoder for the custom LZSS used by the Uniden R7 ui_nu ".data" block1.

Decoder side (reference): tools/r7_scan.py:decompress  == firmware FUN_00000488.
This module is the missing *compressor*. It produces a byte stream that the
firmware decompressor accepts and expands back to the exact input.

Stream format (one "group" per iteration; decoder loop in r7_scan.decompress):

    [ctrl]                       control byte
    [L_ext]  if (ctrl & 7)==0    literal-count field, else L = ctrl & 7
    [M_ext]  if (ctrl>>4)==0     length field,        else M = ctrl >> 4
    [lit ... ] (L-1) bytes       verbatim literals
    [dist]   if ctrl & 8         back-distance byte (1..255), backref only

  literal count copied  = L - 1        (L in 1..255; low3==0 => next byte)
  ctrl & 8  set  -> BACKREF : copy (M+2) bytes from  dst[len-dist ..]  (overlap ok)
  ctrl & 8  clear-> ZEROFILL: append M zero bytes
  M in 1..255 (high4==0 => next byte). Backref copy len = M+2 (2..257).

So every group is  <optional literals> + <one backref OR one zerofill>.
There is no literals-only group; a pure-literal flush is emitted as
literals + a zerofill of length 0 (M_ext == 0).

Design goal here: NOT byte-identical to the stock stream, just a valid stream
the decoder accepts that fits the space stock left (stock compressed len +
the 0xFF header room that follows it in flash). A simple greedy longest-match
LZSS is far below that budget.

Usage:
    python3 r7_lzss.py verify <firmware.bin>   # decode ui_nu, roundtrip block1, report
    python3 r7_lzss.py selftest                # roundtrip a battery of byte patterns
"""
import sys

# ---- limits imposed by the format -----------------------------------------
MAX_LIT   = 254     # L-1 with L in 1..255  ->  literal count 0..254
MAX_DIST  = 255     # distance is a single byte, >= 1
MAX_BACK  = 257     # copy len = M+2, M in 0..255
MAX_ZERO  = 255     # zerofill len = M, M in 1..255 (0 reserved for flush)

# Only take a backref if it clearly pays: cost is ctrl(shared) + maybe M_ext +
# 1 dist byte. A 3-byte copy costs at most 1 dist byte -> always a win; a
# 2-byte copy needs an M_ext (M=0) too, so it breaks even at best -> skip.
MIN_BACK = 3


def decompress(src, off=0, out_len=None):
    """Reference decoder (identical to r7_scan.decompress / FUN_00000488)."""
    if out_len is None:
        out_len = len(src)  # decode everything the caller wants; caller sets len
    dst = bytearray(); i = off
    while len(dst) < out_len:
        c = src[i]; i += 1
        L = c & 7
        if L == 0: L = src[i]; i += 1
        M = c >> 4
        if M == 0: M = src[i]; i += 1
        for _ in range(L - 1): dst.append(src[i]); i += 1
        if c & 8:
            o = src[i]; i += 1; s = len(dst) - o
            for k in range(M + 2): dst.append(dst[s + k])
        else:
            dst.extend(b'\x00' * M)
    return bytes(dst[:out_len])


def _find_backref(x, pos, n):
    """Longest overlapping match ending distance in 1..255, len<=257.
    Returns (dist, length); length 0 if none. Comparing directly against x is
    valid because the decoder copies from already-produced output == x[:pos]."""
    best_len = 0; best_o = 0
    max_o = pos if pos < MAX_DIST else MAX_DIST
    # anchor on the first byte to skip most distances cheaply
    first = x[pos]
    for o in range(1, max_o + 1):
        if x[pos - o] != first:
            continue
        m = 1
        lim = MAX_BACK
        # extend while within bounds and matching (overlap-safe)
        while m < lim and pos + m < n and x[pos + m] == x[pos - o + m]:
            m += 1
        if m > best_len:
            best_len = m; best_o = o
            if m >= lim:
                break
    return best_o, best_len


def _find_zeros(x, pos, n):
    m = 0
    while m < MAX_ZERO and pos + m < n and x[pos + m] == 0:
        m += 1
    return m


def _emit(out, literals, op):
    """op = ('back', dist, copylen) | ('zero', count).  count==0 => pure flush."""
    Lc = len(literals)
    assert 0 <= Lc <= MAX_LIT, Lc
    L = Lc + 1                      # low3 field value
    if op[0] == 'back':
        dist, cl = op[1], op[2]
        assert 1 <= dist <= MAX_DIST and 2 <= cl <= MAX_BACK
        M = cl - 2
        bit3 = 8
    else:
        cnt = op[1]
        assert 0 <= cnt <= MAX_ZERO
        M = cnt
        bit3 = 0
    low3  = L if L <= 7 else 0                    # 0 => L_ext follows
    high4 = M if 1 <= M <= 15 else 0              # 0 => M_ext follows
    out.append((high4 << 4) | bit3 | low3)
    if low3 == 0:
        out.append(L)                            # 8..255
    if high4 == 0:
        out.append(M)                            # 0..255
    out += literals
    if op[0] == 'back':
        out.append(op[1])


def compress(x):
    """Greedy LZSS encoder. Returns a bytes stream s with decompress(s,0,len(x))==x."""
    x = bytes(x)
    n = len(x)
    out = bytearray()
    pos = 0
    lit_start = 0

    def flush_full_literals():
        # keep pending literal runs within MAX_LIT by closing zero-length groups
        nonlocal lit_start
        while pos - lit_start > MAX_LIT:
            _emit(out, x[lit_start:lit_start + MAX_LIT], ('zero', 0))
            lit_start += MAX_LIT

    while pos < n:
        bo, bl = _find_backref(x, pos, n)
        zr = _find_zeros(x, pos, n)
        take = None
        if bl >= MIN_BACK and bl >= zr:
            take = ('back', bo, bl); adv = bl
        elif zr >= 1:
            take = ('zero', zr); adv = zr
        elif bl >= MIN_BACK:
            take = ('back', bo, bl); adv = bl

        if take is not None:
            # emit accumulated literals + this op as one group
            # (literal run guaranteed <= MAX_LIT by flush below)
            lit = x[lit_start:pos]
            if len(lit) > MAX_LIT:
                # split off full-literal groups first
                s = lit_start
                while pos - s > MAX_LIT:
                    _emit(out, x[s:s + MAX_LIT], ('zero', 0))
                    s += MAX_LIT
                lit = x[s:pos]
            _emit(out, lit, take)
            pos += adv
            lit_start = pos
        else:
            pos += 1
            flush_full_literals()

    # trailing literals with no terminating op -> flush as literals + zerofill(0)
    s = lit_start
    while n - s > MAX_LIT:
        _emit(out, x[s:s + MAX_LIT], ('zero', 0))
        s += MAX_LIT
    if s < n:
        _emit(out, x[s:n], ('zero', 0))
    return bytes(out)


# ---------------------------------------------------------------------------
def _verify_firmware(fw):
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from r7_unpack import decode_old_model, parse
    import r7_scan  # use the *canonical* decoder for the acceptance test

    UI_KEY = 182
    DATA_LMA, DATA_LEN = 0x2f7ac, 0x514
    buf = open(fw, 'rb').read()
    off = length = None
    for f in parse(buf):
        if f['name'] == 'ui_nu':
            off, length = f['offset'], f['length']; break
    if off is None:
        raise SystemExit('ui_nu not found')
    ui = decode_old_model(UI_KEY, buf[off:off + max(length, 0x30000)])

    # original compressed length: decode block1 and note where the decoder stops
    def decompress_len(src, o, out_len):
        dst = bytearray(); i = o
        while len(dst) < out_len:
            c = src[i]; i += 1
            L = c & 7
            if L == 0: L = src[i]; i += 1
            M = c >> 4
            if M == 0: M = src[i]; i += 1
            for _ in range(L - 1): dst.append(src[i]); i += 1
            if c & 8:
                d = src[i]; i += 1; s = len(dst) - d
                for k in range(M + 2): dst.append(dst[s + k])
            else:
                dst.extend(b'\x00' * M)
        return bytes(dst[:out_len]), i - o

    X, orig_comp = decompress_len(ui, DATA_LMA, DATA_LEN)
    # count 0xFF header room that follows in flash
    headroom = 0
    p = DATA_LMA + orig_comp
    while p < len(ui) and ui[p] == 0xFF:
        headroom += 1; p += 1
    budget = orig_comp + headroom

    enc = compress(X)
    # acceptance: canonical decoder must reproduce X exactly
    round1 = r7_scan.decompress(enc, 0, len(X))
    round2 = decompress(enc, 0, len(X))
    ok = (round1 == X) and (round2 == X)
    fits = len(enc) <= budget

    print("== r7_lzss verify ==")
    print(f"decompressed X            : {len(X)} bytes (0x{len(X):x})")
    print(f"stock compressed length   : {orig_comp} bytes (0x{orig_comp:x})")
    print(f"0xFF header room after it : {headroom} bytes (0x{headroom:x})")
    print(f"budget (stock + headroom) : {budget} bytes (0x{budget:x})")
    print(f"our compressed length     : {len(enc)} bytes (0x{len(enc):x})")
    print(f"slack under budget        : {budget - len(enc)} bytes")
    print(f"roundtrip decompress==X   : {'PASS' if ok else 'FAIL'}"
          f" (r7_scan.decompress={'ok' if round1==X else 'BAD'})")
    print(f"fits in budget            : {'PASS' if fits else 'FAIL'}")
    print(f"OVERALL                   : {'PASS' if (ok and fits) else 'FAIL'}")
    return ok and fits


def _selftest():
    import os, random
    cases = [
        b"",
        b"\x00",
        b"A",
        b"\x00" * 300,
        b"AB" * 400,
        b"ABCABCABCABC",
        bytes(range(256)) * 5,
        b"\xff" + b"\x00" * 108 + b"\xff\xff\xff",
        os.urandom(1000),
        b"".join(bytes([i % 7]) for i in range(1300)),
    ]
    random.seed(1)
    for _ in range(50):
        L = random.randint(0, 2000)
        # biased toward zeros / repeats to exercise both ops
        cases.append(bytes(random.choice([0, 0, 0, random.randint(0, 255),
                                          (i % 5)]) for i in range(L)))
    bad = 0
    for i, c in enumerate(cases):
        e = compress(c)
        d = decompress(e, 0, len(c)) if len(c) else b""
        if d != c:
            bad += 1
            print(f"case {i}: FAIL len={len(c)} enc={len(e)}")
    print(f"selftest: {len(cases)-bad}/{len(cases)} passed")
    return bad == 0


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'verify':
        sys.exit(0 if _verify_firmware(sys.argv[2]) else 1)
    elif len(sys.argv) >= 2 and sys.argv[1] == 'selftest':
        sys.exit(0 if _selftest() else 1)
    else:
        print(__doc__); sys.exit(1)
