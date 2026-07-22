#!/usr/bin/env python3
"""
Uniden R7 sound_dbnu decoder / clip extractor / re-encoder.

FORMAT (reverse-engineered here):
  After the container transform (decode_old_model, key 255), the sound_dbnu
  payload is RAW 8-bit SIGNED PCM, mono, 1 byte == 1 sample. There is NO
  internal table-of-contents, no per-clip header, and no codec framing --
  it is a flat concatenation of clips. Silence is the constant byte 0xE2
  (the DAC resting level, ~ -30 signed). The used content runs from offset
  0x000000 to 0x1F3A35; the tail (0x1F3A35..end) is 0xE1 flash padding.

  Clips are packed back-to-back separated only by short (<=~80 byte) quiet
  runs, so clip boundaries are recovered by silence segmentation (a heuristic,
  not an exact directory). Sample rate is not stored in the blob; 16000 Hz is
  the working assumption (override with --rate).

WAV mapping is a loss-less bijection so extract->inject reproduces the firmware
byte-for-byte:
    wav_u8  = (fw_byte - 0xE2 + 128) & 0xFF     # silence -> 0x80 (clean-sounding)
    fw_byte = (wav_u8  - 128 + 0xE2) & 0xFF

Usage:
    python3 r7_sound.py info    <firmware.bin>
    python3 r7_sound.py clips   <firmware.bin> [--gap N] [--min N]   # list segmented clips
    python3 r7_sound.py extract <firmware.bin> <out_dir> [--rate R] [--gap N] [--min N]
    python3 r7_sound.py wav     <firmware.bin> <start_hex> <len> <out.wav> [--rate R]
    python3 r7_sound.py inject  <firmware.bin> <start_hex> <in.wav>  <out.bin>   # in place, len preserved
    python3 r7_sound.py verify  <firmware.bin>                       # 0-diff round trip
"""
import sys, os, struct, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from r7_unpack import decode_old_model, encode_old_model, parse

SOUND_KEY = 255
SILENCE   = 0xE2          # DAC resting byte
PAD       = 0xE1          # flash padding byte in tail
DEF_RATE  = 16000

def sound_span(buf):
    for f in parse(buf):
        if f['name'] == 'sound_dbnu':
            return f['offset'], f['length']
    raise SystemExit("sound_dbnu not found")

def load_pcm(buf):
    off, length = sound_span(buf)
    return bytearray(decode_old_model(SOUND_KEY, buf[off:off+length])), off, length

def content_end(pcm):
    i = len(pcm)
    while i > 0 and pcm[i-1] == PAD:
        i -= 1
    return i

def segment(pcm, end, gap=40, minlen=256):
    """Split [0,end) into clips at quiet runs (bytes in {E1,E2,E3}) of >= `gap`."""
    quiet = (PAD, SILENCE, 0xE3)
    runs = []           # (start,len) of quiet runs >= gap
    i = 0
    while i < end:
        if pcm[i] in quiet:
            j = i
            while j < end and pcm[j] in quiet:
                j += 1
            if j - i >= gap:
                runs.append((i, j - i))
            i = j
        else:
            i += 1
    clips = []
    prev = 0
    for s, l in runs:
        if s - prev >= minlen:
            clips.append((prev, s - prev))
        prev = s + l
    if end - prev >= minlen:
        clips.append((prev, end - prev))
    return clips

def wav_bytes_from_fw(chunk):
    return bytes((b - SILENCE + 128) & 0xFF for b in chunk)

def fw_bytes_from_wav(chunk):
    return bytes((b - 128 + SILENCE) & 0xFF for b in chunk)

def write_wav(path, fw_chunk, rate):
    w = wave.open(path, 'wb')
    w.setnchannels(1); w.setsampwidth(1); w.setframerate(rate)
    w.writeframes(wav_bytes_from_fw(fw_chunk))
    w.close()

def read_wav_as_fw(path):
    w = wave.open(path, 'rb')
    assert w.getnchannels() == 1 and w.getsampwidth() == 1, "need mono 8-bit WAV"
    data = w.readframes(w.getnframes()); w.close()
    return fw_bytes_from_wav(data)

def cmd_info(fw):
    buf = open(fw, 'rb').read()
    pcm, off, length = load_pcm(buf)
    end = content_end(pcm)
    print(f"sound_dbnu file@0x{off:x} len={length} (0x{length:x})")
    print(f"codec: 8-bit signed PCM, mono, silence=0x{SILENCE:02x}")
    print(f"content 0x000000..0x{end:06x} ({end} bytes), padding 0x{PAD:02x} for {length-end} bytes")
    print(f"duration @16k={end/16000:.1f}s  @8k={end/8000:.1f}s")

def cmd_clips(fw, gap, minlen):
    buf = open(fw, 'rb').read()
    pcm, off, length = load_pcm(buf)
    end = content_end(pcm)
    clips = segment(pcm, end, gap, minlen)
    print(f"{len(clips)} clips (gap>={gap}, min>={minlen}):")
    for i, (s, l) in enumerate(clips):
        print(f"  [{i:3d}] 0x{s:06x} len {l:6d}  ~{l/16000*1000:5.0f}ms@16k")

def cmd_extract(fw, outdir, rate, gap, minlen):
    buf = open(fw, 'rb').read()
    pcm, off, length = load_pcm(buf)
    end = content_end(pcm)
    clips = segment(pcm, end, gap, minlen)
    os.makedirs(outdir, exist_ok=True)
    for i, (s, l) in enumerate(clips):
        write_wav(os.path.join(outdir, f"clip_{i:03d}_0x{s:06x}_{l}.wav"), pcm[s:s+l], rate)
    print(f"extracted {len(clips)} clips -> {outdir}/ ({rate} Hz)")

def cmd_wav(fw, start, ln, out, rate):
    buf = open(fw, 'rb').read()
    pcm, off, length = load_pcm(buf)
    write_wav(out, pcm[start:start+ln], rate)
    print(f"wrote {out}  ({ln} samples @ {rate} Hz)")

def cmd_inject(fw, start, inwav, out):
    buf = open(fw, 'rb').read()
    off, length = sound_span(buf)
    pcm = bytearray(decode_old_model(SOUND_KEY, buf[off:off+length]))
    new = read_wav_as_fw(inwav)
    region_len = None
    # replace exactly len(new) bytes at start, but never grow the section
    if start + len(new) > length:
        raise SystemExit("replacement runs past section end")
    pcm[start:start+len(new)] = new
    enc = encode_old_model(SOUND_KEY, bytes(pcm))
    assert len(enc) == length
    open(out, 'wb').write(buf[:off] + enc + buf[off+length:])
    print(f"injected {len(new)} bytes at 0x{start:x} -> {out} (section length preserved)")

def cmd_verify(fw):
    buf = open(fw, 'rb').read()
    off, length = sound_span(buf)
    pcm = decode_old_model(SOUND_KEY, buf[off:off+length])
    reenc = encode_old_model(SOUND_KEY, pcm)
    rebuilt = buf[:off] + reenc + buf[off+length:]
    same = rebuilt == buf
    # also test wav bijection on a chunk
    chunk = pcm[0x1000:0x2000]
    bij = fw_bytes_from_wav(wav_bytes_from_fw(chunk)) == chunk
    print(f"decode->encode round trip: {'0 DIFF OK' if same else 'DIFFERS'}")
    print(f"wav<->fw byte bijection:   {'OK' if bij else 'BROKEN'}")
    return same and bij

def main():
    a = sys.argv
    if len(a) < 3:
        print(__doc__); sys.exit(1)
    def opt(name, default, cast=int):
        return cast(a[a.index(name)+1]) if name in a else default
    rate = opt('--rate', DEF_RATE); gap = opt('--gap', 40); minlen = opt('--min', 256)
    cmd = a[1]
    if   cmd == 'info':    cmd_info(a[2])
    elif cmd == 'clips':   cmd_clips(a[2], gap, minlen)
    elif cmd == 'extract': cmd_extract(a[2], a[3], rate, gap, minlen)
    elif cmd == 'wav':     cmd_wav(a[2], int(a[3], 16), int(a[4]), a[5], rate)
    elif cmd == 'inject':  cmd_inject(a[2], int(a[3], 16), a[4], a[5])
    elif cmd == 'verify':  sys.exit(0 if cmd_verify(a[2]) else 1)
    else: print(__doc__); sys.exit(1)

if __name__ == '__main__':
    main()
