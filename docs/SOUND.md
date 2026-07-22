# Voice / alert audio — `sound_dbnu` (Nuvoton ISD3800)

> **This supersedes the earlier "raw 8-bit signed PCM" description.** That was reverse-engineered
> from the **wrong container key** (255) and is incorrect: it produces noise, not audio. The section
> is not PCM and is not editable as a simple byte swap.

## What it actually is

The R7's `sound_dbnu` section is a **Nuvoton ISD3800 ChipCorder flash image**. The R7 mainboard
carries a dedicated **ISD3800** voice-playback chip (silkscreen "3800") that:

- reads this bank out of the **Winbond SPI flash**,
- **decodes the audio in hardware** (4-bit ADPCM), and
- drives the speaker via **Class-D PWM**.

The **Nuvoton NUC442** main MCU only issues *"play voice-prompt N"* SPI commands. Consequently the
audio codec lives **inside the ISD3800 chip**, not in any firmware code image — which is why no
ADPCM step-tables are found anywhere in `ui_nu` / `dsp_nu` / `gps_nu`.

Hardware chain: `Winbond SPI flash → ISD3800 (decode) → Class-D PWM → speaker`.

## Container decode: key **225** (not 255)

De-obfuscate the section with `decode_old_model(key=225, …)`. Proof it's correct: key 225 yields a
valid ISD3800 memory image — a `0xCX` memory-header byte, a 250-entry voice-prompt directory,
`0xFF` erased-flash padding, and a readable ASCII build date at the content tail. Every other key
(including the old 255) yields garbage.

## Decoded layout (ISD3800 memory image)

| Offset | Field |
|---|---|
| `0x00` | **Memory header**. Byte0 = `0xCX` protection scheme (ISD3800 Design Guide, Table 8-1). Starts `0xcf` on v153. |
| `0x17` | First voice-prompt **START** address (u24 little-endian). |
| `0x1A…` | **Voice-prompt directory**: repeating `(END_k, START_{k+1})` u24-LE pairs, with `START_{k+1} == END_k + 1`, until the chain breaks. → **250 clips**. |
| clips | Each clip = a short **audio header** (per-message sample rate + compression) then the compressed body. |
| tail | `0xFF` erased-flash padding to the section end (`0x1F3A35`→end on v153). |

The **250 voice prompts** are the real directory — not the ~23 clips the old silence-segmentation
heuristic guessed.

## Codec status — 4-bit ADPCM, predictor not yet bit-exact

Per the ISD3800 datasheet the compression is **4-bit ADPCM** (CFG0 default `0x64`; sample rate is
set per message by the audio header, from a discrete set 4–32 kHz). The framing is IMA-style: the
standard sign=MSB nibble reproduces the idle/silence pattern exactly, so **clip boundaries and
silence decode correctly**.

However, the exact **predictor / step-adaptation table is proprietary** to the ISD3800 (in-chip
ROM) and is **not plain IMA**. No reconstruction attempted here recovers clean speech — an LPC
formant-gain check reads ~1.3 on real speech versus ~0.05 (noise floor) for every candidate decode
tried (IMA/OKI step tables, all nibble bit-permutations, index-table variants, leaky/G.726-style
predictors, block-reset scans, and frame widths 8–16). So the extractor's WAV output is
**best-effort**: timing and silence are right, tonal content is still noisy.

### Two ways to get bit-exact audio

1. **Nuvoton ISD-VPE3800 (Voice Prompt Editor) + ICP tool** — the official WAV↔ISD3800-flash
   pipeline. This is the reliable path to extract and rebuild this exact bank.
2. **One confirmed clip→word anchor.** With a single known mapping (e.g. "clip N = *Ka Band*"),
   the full step table is fittable from a Rosetta pair of (firmware clip, reference WAV).

## Tool: `r7_sound.py`

```
python3 tools/r7_sound.py info    <fw>                 # format, key, clip count, padding
python3 tools/r7_sound.py clips   <fw>                 # list the 250 voice prompts (real directory)
python3 tools/r7_sound.py extract <fw> <out_dir>       # per clip: raw .adpcm + BEST-EFFORT .wav
python3 tools/r7_sound.py raw     <fw> <out.bin>       # dump the decoded ISD3800 image
```

`extract` writes both the **raw `.adpcm` blob** (exact bytes, for anyone continuing the codec work)
and a **best-effort `.wav`** (approximate tone — see above).

## Rules & limits

- **`sound_dbnu` carries no checksum**, and the container round-trip (`decode_old_model` /
  `encode_old_model`) is byte-exact, so a correctly-sized flash-image edit is structurally valid.
- Writing new audio back requires an ISD3800-format **encoder** (ADPCM + directory + headers) —
  use ISD-VPE for that; a WAV cannot be injected as raw bytes.
- This flashes the **firmware** — read [FLASHING.md](FLASHING.md), keep a stock `.bin`.
- `STSD` is the parallel STM32-sibling voice bank — irrelevant to an R7, don't touch it.
