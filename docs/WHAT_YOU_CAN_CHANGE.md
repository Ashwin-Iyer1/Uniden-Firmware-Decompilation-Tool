# What you can change

> Structured editing is verified for R7 only. For R4W/R8W inspection, extraction
> and unchanged reproduction, see [R4W/R8W support](R4W_R8W.md).

The [browser workbench](https://ashwin-iyer1.github.io/Uniden-Firmware-Decompilation-Tool/)
now edits every byte of a supplied `.bin`, with structured controls for researched
R7 v153.150.127 resources. “Editable bytes” does not mean every field's purpose is
known or every modification works on hardware. Keep the original file.

## Resource and code map

| Resource | Web workflow | Python / research guide |
|---|---|---|
| X/K/Ka band starts and ends | Band boundaries: 33 coefficient records, MHz input | `r7_bands.py`; [Band filtering](BAND_FILTERING.md) |
| Menu/display/diagnostic strings | Text: quick labels, searchable candidates, and explicit Latin-1 strings by offset | `r7_patch.py`; [Text](TEXT.md) |
| Boot logo, badges, backgrounds, icons, bars | Graphics: mapped or custom geometry; PNG import/export and painting | `r7_gfx.py`; [Graphics](GRAPHICS.md) |
| Font glyph shapes | Graphics: glyph presets; preserve each slot's dimensions | [Firmware map §1.9](FIRMWARE_MAP.md) |
| Font width bytes and pointer tables | Raw / sections: typed byte or instruction patch | [Firmware map](FIRMWARE_MAP.md) |
| Scan tiles | Graphics: individual tiles and tile sheet | `r7_scan.py`; [Scan animation](SCAN_ANIMATION.md) |
| Scan motion | Scan motion: 20×8 levels, LZSS repacking | `r7_lzss.py`; [Scan animation](SCAN_ANIMATION.md) |
| GPS cameras and points | GPS database: record edits, CSV, dates, resizing | `r7_gpsdb.py`; [GPS database](GPS_DATABASE.md) |
| DSP sweep schedules, tuning constants, version words | Raw / sections: typed values at researched offsets | [Firmware map §2](FIRMWARE_MAP.md) |
| Auto-mute delay, default theme, mute volume and signal level | Settings & timing: the same guarded instruction edits as Python | `r7_settings.py`; [Settings and timing](R7_SETTINGS.md) |
| Other default initialization and menu logic | Raw / sections: patch instructions or replace an externally edited section | [REA findings](REA_FINDINGS.md) |
| Interrupt vectors, boot code, arbitrary executable code | Raw / sections: bytes, typed words, Python patch-file import, section import/export | Ghidra; `r7_patch.py patch` |
| Sound clips and bank bytes | Raw / sections: 250 clip ranges, clip exports, encoded or decoded bank replacement | `r7_sound.py`; [Sound](SOUND.md) |
| Alternate STM32 sections, headers and trailers | Raw / sections: encoded bytes, whole-file patches and splices | [Format](FORMAT.md) |

Named editors require a verified R7 layout. Other firmware remains available for
raw editing; it does not inherit R7 offsets. The [web editor guide](WEB_EDITOR.md)
explains reference files, undo, exports, coordinate systems and validation.
Its [Python editing parity table](WEB_EDITOR.md#python-editing-parity) maps every
firmware-editing command to a browser workflow. Patch files retain Python's comment
syntax and ordered overlaps, with complete validation and one-step undo. The text
offset editor includes short, empty, long, and Latin-1 fields while retaining the
printf-token guard.

## Distinctions that matter

**Band coefficients and runtime enables are different.** Frequencies live in the
33×16-byte coefficient table at decoded DSP `0xdd34`. Sweep schedules reference
these shared records. Runtime band configuration can override stored sweep enables;
changing a coefficient is not the same operation as switching a Ka segment on/off.
The corrected mask condition is `bit0 && (bit2 || !bit1)` for the traced paths;
see [DSP protocol](DSP_PROTOCOL.md).

**Text labels do not control radio tuning.** Ka boundary labels in UI strings are
separate from DSP coefficient values. Changing one does not automatically change
the other. Text must fit its slot and retain the original printf placeholders.

**Factory defaults are code.** UI `0x1cf48` initializes menu-reset defaults;
`0x1d29c` handles invalid settings storage and has some different defaults. The guarded
`r7_settings.py` and browser Settings & timing editors change both paths for theme,
Auto Mute Vol, and Auto Mute Lv.
They also change all three coupled auto-mute delay instructions. Saved preferences
are restored from a separate serial-memory path on normal startup, so default edits
do not automatically override them. Current device settings and learned lockouts are
not in the supplied firmware file. Apply settings before other UI resource edits:
both settings editors require the original UI apart from their complete coupled
patches. A browser reference cannot bypass that check. Complete settings patches
remain recognized when reopened. See [the evidence and editing guide](R7_SETTINGS.md).

**Raw sound editing is not audio encoding.** R7 `sound_dbnu` uses key 225 and contains
an ISD3800 image, not 8-bit PCM. The predictor remains proprietary. Replacing bytes
or a known-compatible bank is possible; importing WAV as raw audio is not a verified
conversion path. The Python WAV extraction is an approximation; that tool inspects
and extracts sounds, with no WAV encoder missing from the browser.

**STM32 images are for different silicon.** They are carried in the combined file
and can be inspected or patched as bytes, but cannot be treated as R7 Nuvoton code.

No in-file integrity field requiring recomputation has been identified for the
researched edits. That is not proof that every updater/device check is understood.
All modified outputs remain untested on hardware. See [Flashing](FLASHING.md).
