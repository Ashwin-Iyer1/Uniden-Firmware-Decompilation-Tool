#!/usr/bin/env python3
"""
Uniden R7 sound_dbnu decoder / clip extractor.

WHAT THIS SECTION ACTUALLY IS (reverse-engineered here; supersedes the earlier
"8-bit signed PCM" theory, which was derived from the WRONG container key):

  sound_dbnu is a **Nuvoton ISD3800 ChipCorder flash image**. On the R7 mainboard
  a dedicated ISD3800 (marked "3800") reads this bank out of the Winbond SPI flash,
  decodes it IN HARDWARE, and drives the speaker via Class-D PWM. The Nuvoton NUC442
  main MCU only issues "play voice-prompt N" SPI commands -- so the audio codec is
  NOT in any firmware code image, which is why no ADPCM step-tables live in ui/dsp/gps.

  Container: the section is de-obfuscated with decode_old_model(key=**225**) -- NOT
  255. Proof: key 225 yields a valid ISD3800 memory image (0xCX memory-header byte,
  a 250-entry voice-prompt directory, 0xFF erased-flash padding, an ASCII build date);
  every other key yields garbage.

  Layout of the decoded section (ISD3800 memory image):
    0x00        Memory header. Byte0 = 0xCX protection scheme (design guide Table 8-1).
    0x17        First voice-prompt START address (u24 little-endian).
    0x1A..      Voice-prompt directory: repeating (END_k, START_{k+1}) u24 LE pairs,
                with START_{k+1} == END_k + 1, until the chain breaks. -> **250 clips**.
    <clips>     Each clip: a short audio header (sample-rate + compression, set per
                message) followed by the compressed audio body.
    tail        0xFF erased-flash padding to the section end.

  Codec: **4-bit ADPCM** (ISD3800 CFG0 default 0x64), IMA-style framing -- the standard
  sign=MSB nibble reproduces the idle/silence pattern exactly, so clip boundaries and
  silence decode correctly. BUT the exact predictor / step-adaptation table is
  PROPRIETARY to the ISD3800 (in-chip ROM) and is NOT plain IMA: no reconstruction
  tried here recovers clean speech (an LPC formant-gain check reads ~1.3 on real speech
  vs ~0.05 == noise floor for every candidate decode). So `extract` below is BEST-EFFORT:
  timing/silence are right, tonal content is still noisy. Getting bit-exact audio needs
  either Nuvoton's ISD-VPE3800 Voice Prompt Editor (the official WAV<->flash tool) or one
  confirmed clip<->word anchor to fit the full table. See docs/SOUND.md.

Usage:
    python3 r7_sound.py info    <firmware.bin>
    python3 r7_sound.py clips   <firmware.bin>                     # list the 250 voice prompts
    python3 r7_sound.py extract <firmware.bin> <out_dir> [--rate R]  # best-effort WAV + raw .adpcm
    python3 r7_sound.py raw     <firmware.bin> <out.bin>           # dump the decoded ISD3800 image
"""
import sys, os, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from r7_unpack import decode_old_model, parse

SOUND_KEY = 225           # correct container key for sound_dbnu (NOT 255)
PAD       = 0xFF          # erased-flash padding byte in the decoded image
DEF_RATE  = 16000         # ISD3800 sample rate is per-message; 16k is a working default

# IMA-89 step table (ISD3800 uses IMA-style framing; the exact table is proprietary,
# so decoded tone is approximate -- see module docstring).
IMA_STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,
            97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,
            658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,
            3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,
            13899,15289,16818,18500,20350,22385,24623,27086,29794,32767]
IMA_IDX  = [-1,-1,-1,-1,2,4,6,8]


def sound_span(buf):
    for f in parse(buf):
        if f['name'] == 'sound_dbnu':
            return f['offset'], f['length']
    raise SystemExit("sound_dbnu not found")


def load_image(buf):
    """Return the de-obfuscated ISD3800 memory image (decode key 225)."""
    off, length = sound_span(buf)
    return bytearray(decode_old_model(SOUND_KEY, buf[off:off + length])), off, length


def u24(b, i):
    return b[i] | b[i + 1] << 8 | b[i + 2] << 16


def content_end(img):
    i = len(img)
    while i > 0 and img[i - 1] == PAD:
        i -= 1
    return i


def voice_prompts(img):
    """Parse the ISD3800 voice-prompt directory -> list of (start, end) clip spans.

    Directory: first START at 0x17, then (END_k, START_{k+1}) u24 pairs from 0x1A with
    START_{k+1} == END_k + 1, until the chain breaks."""
    starts = [u24(img, 0x17)]
    ends = []
    i = 0x1A
    while i + 6 <= len(img) and u24(img, i) + 1 == u24(img, i + 3):
        ends.append(u24(img, i))
        starts.append(u24(img, i + 3))
        i += 6
    ends.append(u24(img, i))
    return list(zip(starts, ends))


def adpcm_decode(payload, header=2):
    """BEST-EFFORT 4-bit ADPCM decode (IMA-style; tone is approximate -- see docstring).
    Skips a short per-message audio header, then low-nibble-first IMA over the body."""
    body = payload[header:]
    out = []
    pred = 0
    idx = 0
    for byte in body:
        for nib in (byte & 0x0F, byte >> 4):        # low nibble first
            step = IMA_STEP[idx]
            mag = nib & 7
            diff = step >> 3
            if mag & 4: diff += step
            if mag & 2: diff += step >> 1
            if mag & 1: diff += step >> 2
            pred += -diff if (nib & 8) else diff     # sign = MSB (correct for silence)
            pred = max(-32768, min(32767, pred))
            idx = max(0, min(88, idx + IMA_IDX[mag]))
            out.append(pred)
    return out


def write_wav(path, samples, rate):
    import struct
    w = wave.open(path, 'wb')
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
    w.writeframes(b''.join(struct.pack('<h', s) for s in samples))
    w.close()


def cmd_info(fw):
    buf = open(fw, 'rb').read()
    img, off, length = load_image(buf)
    end = content_end(img)
    clips = voice_prompts(img)
    print(f"sound_dbnu file@0x{off:x} len={length} (0x{length:x})")
    print(f"format: Nuvoton ISD3800 ChipCorder flash image (decode key {SOUND_KEY})")
    print(f"memory-header byte0 = 0x{img[0]:02x} (ISD3800 0xCX protection scheme)")
    print(f"codec: 4-bit ADPCM, decoded in the ISD3800 hardware (see docs/SOUND.md)")
    print(f"voice prompts (directory): {len(clips)} clips")
    print(f"content 0x000000..0x{end:06x} ({end} bytes), 0xFF padding for {length - end} bytes")


def cmd_clips(fw):
    buf = open(fw, 'rb').read()
    img, _, _ = load_image(buf)
    clips = voice_prompts(img)
    print(f"{len(clips)} voice prompts (ISD3800 directory):")
    for i, (s, e) in enumerate(clips):
        print(f"  [{i:3d}] 0x{s:06x}..0x{e:06x}  len {e - s + 1:6d}")


def cmd_extract(fw, outdir, rate):
    buf = open(fw, 'rb').read()
    img, _, _ = load_image(buf)
    clips = voice_prompts(img)
    os.makedirs(outdir, exist_ok=True)
    for i, (s, e) in enumerate(clips):
        payload = bytes(img[s:e + 1])
        open(os.path.join(outdir, f"clip_{i:03d}_0x{s:06x}.adpcm"), 'wb').write(payload)
        write_wav(os.path.join(outdir, f"clip_{i:03d}_0x{s:06x}.wav"), adpcm_decode(payload), rate)
    print(f"extracted {len(clips)} clips -> {outdir}/  (raw .adpcm + BEST-EFFORT .wav @ {rate} Hz)")
    print("NOTE: .wav tone is approximate -- the ISD3800 ADPCM predictor is proprietary; "
          "silence/timing are correct. See docs/SOUND.md.")


def cmd_raw(fw, out):
    buf = open(fw, 'rb').read()
    img, _, _ = load_image(buf)
    open(out, 'wb').write(bytes(img))
    print(f"wrote decoded ISD3800 image ({len(img)} bytes) -> {out}")


def main():
    a = sys.argv
    if len(a) < 3:
        print(__doc__); sys.exit(1)
    rate = int(a[a.index('--rate') + 1]) if '--rate' in a else DEF_RATE
    cmd = a[1]
    if   cmd == 'info':    cmd_info(a[2])
    elif cmd == 'clips':   cmd_clips(a[2])
    elif cmd == 'extract': cmd_extract(a[2], a[3], rate)
    elif cmd == 'raw':     cmd_raw(a[2], a[3])
    else:
        print(__doc__); sys.exit(1)


if __name__ == '__main__':
    main()
