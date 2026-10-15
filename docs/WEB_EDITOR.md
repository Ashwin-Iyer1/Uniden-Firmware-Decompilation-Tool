# Browser firmware workbench

[Open the workbench](https://ashwin-iyer1.github.io/Uniden-Firmware-Decompilation-Tool/)
to edit your own firmware locally. It combines named R7 resource editors with
access to every byte of the file, decoded sections, and complete section replacement.
Download a separate modified `.bin` and a JSON change report; keep your original.

## Editors

| Editor | What it changes | Coordinates / constraints |
|---|---|---|
| Band boundaries | All 33 DSP coefficient records: start and end frequencies | MHz input, exact 0.001 MHz steps; decoded DSP `0xdd34`, 16-byte records; low must not exceed high |
| Text | Common labels and searchable NUL-terminated ASCII candidates in UI/DSP/GPS | Existing slot size; printable ASCII; printf placeholders must remain intact |
| Graphics | Boot logo, backgrounds, badges, alert icons, signal bars, scan tiles, font glyphs, and custom bitmap ranges | 1-bit, 2-bit, or RGB565; fixed dimensions and byte allocation; import/export PNG and pixel painting |
| Scan motion | 20 frames × 8 tile levels | Values 0–4; decompress/recompress startup data while preserving all other initialized RAM bytes |
| GPS database | Add/edit/remove LRDB records, import/export CSV, update date | Float32 coordinates, record flags, latitude sorting, encoded count, footer and padding; container resizes as necessary |
| Raw / sections | Any instruction, constant, pointer, header, trailer, audio payload or other byte | Hex/ASCII and little-endian typed values, offset navigation, search, same-size section replacement, file insertion/deletion |
| Review | Applied operation history and exported file | Input/output hashes, byte differences, structural status and change descriptions |

Frequency records are shared by multiple sweep modes. Their band type and IF
constant remain visible; use the raw typed editor for those hardware-coupled values.
A changed frequency does not prove that the receiver can tune or detect it.

Text scanning finds byte patterns, not proven string references. A candidate can
be code-adjacent data. The two “Alert Display” quick fields rename menu labels;
they do not create new owner-information screens. The 234 graphics presets, including 178 font glyphs, are researched
addresses and dimensions, with image contents read only from your file. Font glyph
presets preserve their separate width/advance bytes; those bytes are available in
the raw editor. Custom geometry can address any in-bounds decoded bitmap range.

## Profile recognition and previously edited files

Named editors target **R7 v153.150.127**. Recognition checks the container, model,
versions, logical lengths, and decoded code fingerprints. Documented graphics,
font, quick-text and band-boundary ranges are excluded from the matching hash.
Compressed UI startup data is independently decoded and checked outside the scan
frame table. This lets those resource edits reopen without requiring stock assets.

A session opened from recognized firmware retains its layout knowledge while you
edit, provided the code-section layout remains intact. This does not certify the
modified code. Other string edits and arbitrary code patches can prevent automatic
recognition when reopening a saved file. Supply a matching, verified original
reference from Overview to identify that file's layout again. Reference mode
checks the reference and matching section framing, not equivalence of edited code.

Unknown or structurally malformed files remain editable in raw mode. No R7 offsets
are automatically applied to them. Raw header or file-length edits can break the
container; that status is shown in Overview and Review. A raw export is still
available because this editor intentionally permits every byte to be changed.
The file limit is 32 MiB.

## Applying, undoing and exporting

Each Apply action is an atomic operation. Previews and form fields are drafts until
applied; downloads contain only applied edits. Drafts survive tab changes and
unrelated edits; overlapping changes are rejected until the draft is reopened.
Undo reverses recent operations while retaining unapplied drafts;
Reset restores the input file for the current session. Undo history is bounded to
limit browser memory, while Reset retains the original session input.

Section offsets are relative to the selected section. With decoding enabled, edits
are made to decoded bytes and then re-encoded. Whole-file offsets always refer to
on-disk encoded bytes. Opaque sections without a verified key remain raw. Section
replacement requires the same size; advanced file splicing can insert/remove bytes
but does not repair lengths, pointers or addresses for you. The structured GPS
editor performs its own length/footer reconstruction.

The JSON report records input/output SHA-256 hashes, structural status, operations,
and byte-difference ranges. Large descriptions and histories may be truncated, with
that fact reported. It is an audit report, not a replayable replacement for keeping
the source and output files. Byte-difference offsets after a resize describe the
final files positionally, so shifted untouched data can appear as differences.

## Limits of the analysis

The editor can modify all bytes, but the meaning of all bytes has not been recovered.
Factory defaults and logic changes are instruction patches; there is no verified
editable default-settings table or C-to-firmware compiler in this application.
Current on-device settings and learned GPS lockouts are not contained in this `.bin`.
The actual persistent-settings storage path remains partly unresolved.

Sound is an ISD3800 flash image with a proprietary ADPCM predictor. The raw editor
lists all 250 mapped clips, with jumps to their byte ranges and individual exports.
Its encoded or decoded bytes can be replaced, but this site does not claim to convert WAV audio to
a working voice bank. Alternate STM32 sections are accessible as raw data; that
does not make them executable on the R7's Nuvoton MCUs.

Modified firmware is experimental and has not been tested on a detector. Structural
validation and round-trip equality do not prove hardware acceptance or correct RF
behavior. The site does not flash devices; consult [FLASHING.md](FLASHING.md).

## Privacy and development

All firmware, image and CSV processing happens in browser memory. There is no upload
endpoint, account, analytics, third-party script, or automatic file storage. GitHub
Pages serves the application; user file contents are never sent to it. Refreshing
or closing the tab discards the session.

No build step or runtime package installation is required. Serve **only `web/`**:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory web
# Open http://127.0.0.1:4173
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
```

Node.js 22 or later runs the JavaScript tests. Private stock-fixture checks use
`R7_FIXTURE=/absolute/path/to/your/firmware.bin`. No fixture belongs in Git.
For browser integration tests, install Playwright outside the repository, install
its Chromium browser, and run against the local server or the public URL:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
R7_FIXTURE=/absolute/path/to/your/stock/firmware.bin \
WEB_URL=http://127.0.0.1:4173 \
node tests/web_browser.mjs
```

Browser tests compare actual downloaded edits with the independent Python codecs,
exercise malformed/unknown raw inputs, and monitor for uploads. Artifacts stay under
ignored `decoded/web-qa/`. Public CI uses synthetic fixtures; private firmware is
never uploaded to CI or included in deployment.

Implementation: `binary.mjs` supplies the encoding transform; `firmware.mjs` owns
container parsing and edit sessions; `profile.mjs` holds researched layout metadata;
`resources.mjs` implements resource formats; `app.mjs` connects them to the interface.
The [Pages workflow](../.github/workflows/pages.yml) runs checks before publishing
**only `web/`** from `main`. Pull requests run checks without publishing.
