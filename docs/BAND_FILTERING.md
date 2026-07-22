# Band filtering — editing the RF detection frequencies

The R7's radar bands are **not** hardcoded magic — the DSP keeps its real RF detection windows in a
plain **coefficient table** in `dsp_nu`, with frequencies stored **directly in kHz**. Moving or
narrowing a band is a length-preserving **data-edit** with `r7_bands.py`.

> This is the DSP *frequency* half of band filtering. Turning whole bands or Ka segments on/off is a
> **menu setting** (runtime, in EEPROM); the *sweep logic* that walks these records is code. See
> [WHAT_YOU_CAN_CHANGE.md](WHAT_YOU_CAN_CHANGE.md) for the split. Offsets are for `R7_v153.150.127`.

## The coefficient table — `dsp_nu` `0x0dd34`

**33 records × 16 bytes**, each defining one detection window:

```
+0x00 u32 band_type   1=X  2=K  3/6=Ka(low-mix)  4=Ka(high-mix)  7=K(alt)  8=spot/instant
+0x04 u32 freq_low    RF window low edge,  in kHz   (kHz / 1000 = MHz)
+0x08 u32 freq_high   RF window high edge, in kHz
+0x0c u32 ifconst     per-group IF / mix constant — coupled to hardware; DO NOT edit
```

The 20-byte sweep-schedule records' `+0x10` field is a **pointer** into this table (that's what the
"tuner_code" really is), and the PLL (`FUN_0x47e0`) is programmed straight from `freq_high` via a
25 MHz-reference fractional-N divider — **no hidden harmonic multiplier at the firmware level**, so
the kHz numbers here *are* the RF frequencies. Confirmed: `rec0 type=1 = X 10.499–10.551 GHz`,
`rec1 type=2 = K 24.049–24.251 GHz`.

## Tool: `r7_bands.py`

```
python3 tools/r7_bands.py dump    <fw>                                  # list all 33 records
python3 tools/r7_bands.py setfreq <fw> <rec_idx> <lo_MHz> <hi_MHz> <out.bin>
python3 tools/r7_bands.py verify  <orig_fw> <patched_fw>                # show the diff
```

`setfreq` writes only `freq_low`/`freq_high` of one record (8 bytes), re-encodes `dsp_nu` (key 184),
splices it back, and round-trip-verifies that **only those bytes changed** and every other section is
byte-identical to stock.

### Example — narrow the K band to reject a BSM frequency

```sh
python3 tools/r7_bands.py dump R7_v153.150.127_db260702.bin        # find the K record index
# e.g. tighten K to 24.10–24.20 GHz on record 1:
python3 tools/r7_bands.py setfreq R7_v153.150.127_db260702.bin 1 24100 24200 R7_kband.bin
```

## ⚠️ Cautions (this is expert territory)

- **Records are shared.** Many sweep records across different modes point at the *same* coefficient
  record (the X record `0xdd34` is referenced by almost every group), so one edit changes that band
  for **every mode** that uses it. `dump` shows the table; there's no per-mode isolation here.
- **`band_type` and `ifconst` are hardware-coupled** — leave them alone. Only edit `freq_low`/`freq_high`.
- Moving a window outside what the tuner/PLL can actually reach will simply not detect (or mis-mix).
- Adding a *new* Ka segment (beyond the existing set) is **not** a data-edit — it needs the sweep
  record count, masks, and `tbb` jump tables widened, which is a **code-patch**
  ([FIRMWARE_MAP.md](FIRMWARE_MAP.md) §2).
- This flashes the **firmware** (`dsp_nu`), not the database — read [FLASHING.md](FLASHING.md) and
  keep a stock `.bin`. Change one record at a time and confirm on the bench before trusting it.
