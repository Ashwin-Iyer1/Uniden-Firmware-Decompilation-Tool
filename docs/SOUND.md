# Editing voice / alert audio

The R7's `sound_dbnu` section (~2 MB) turned out to be simple: after the container transform
(`decode_old_model`, key 255) it's **raw 8-bit *signed* PCM, mono** — 1 byte = 1 sample, no
table-of-contents, no codec. Silence is the constant byte `0xE2` (≈ −30 signed). That makes the
voice/alert audio a **data-edit** you can round-trip losslessly with `r7_sound.py`.

> Verified: a tone window decodes to a clean repeating waveform `[98, 2, −22, −28, −30]`; IMA/OKI
> ADPCM and DPCM all rail. `r7_sound.py verify` reports a 0-diff decode→encode round trip and a
> wav↔firmware byte bijection. Offsets/format are for `R7_v153.150.127`.

## Tool: `r7_sound.py`

```
python3 tools/r7_sound.py info    <fw>                    # format, size, duration
python3 tools/r7_sound.py clips   <fw>                    # auto-split into clips by silence gaps
python3 tools/r7_sound.py extract <fw> <out_dir>          # every clip -> .wav
python3 tools/r7_sound.py wav     <fw> <all.wav>          # the whole PCM stream -> one .wav
python3 tools/r7_sound.py inject  <fw> <in.wav> <off> <out.bin>   # write a .wav back at a byte offset
python3 tools/r7_sound.py verify  <fw>                    # 0-diff round-trip self-check
```

The stream splits into ~**23 clips** (the individual voice-alert phrases), each a silence-delimited
PCM run. `info` reports the play length (the exact sample rate isn't stored in the section — the tool
assumes 16 kHz for the duration estimate; the on-device rate is set by the audio peripheral in code).

## Replace a voice clip

```sh
python3 tools/r7_sound.py clips   R7_v153.150.127_db260702.bin          # find the clip + its offset
python3 tools/r7_sound.py extract R7_v153.150.127_db260702.bin clips/   # export all to WAV to audition
#   ...author a replacement WAV: 8-bit signed PCM, mono, SAME sample count (byte length) as the clip...
python3 tools/r7_sound.py inject  R7_v153.150.127_db260702.bin new.wav 0x00babf R7_sound.bin
```

## Rules & limits

- **Keep byte length constant.** The section is a fixed slot; `inject` writes in place at an offset,
  so your replacement must have the **same number of samples** as the region you overwrite (a clip
  is `len` bytes at `1 byte/sample`). Pad or trim with silence (`0xE2`) to fit.
- **Match the format:** 8-bit **signed** PCM, mono. Convert with any audio tool
  (`ffmpeg -i in.wav -ac 1 -ar 16000 -acodec pcm_s8 out.wav`), then `inject`.
- This flashes the **firmware** — read [FLASHING.md](FLASHING.md), keep a stock `.bin`. The
  `sound_dbnu` section carries no checksum, so a correctly-sized edit is structurally valid.
- The parallel `STSD` section is the STM32 sibling's voice bank — irrelevant to an R7, don't touch it.
