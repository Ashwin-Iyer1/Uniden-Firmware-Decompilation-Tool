# Changing on-screen text

Menu items, mode names, and display strings in the R7 are plain **null-terminated strings** in the
`ui_nu` section, drawn with the built-in font. `r7_patch.py` edits them **in place** — the byte
length is preserved, so every other section stays byte-identical to stock.

## Tool: `r7_patch.py`

```
python3 tools/r7_patch.py showstr <fw> <section> <hex_offset>
python3 tools/r7_patch.py setstr  <fw> <section> <hex_offset> "<new text>" <out.bin>
python3 tools/r7_patch.py patch   <fw> <section> <patchfile> <out.bin>
```

`<section>` is `ui_nu`, `dsp_nu`, or `gps_nu`. Offsets are **decoded-section** offsets.

## Rule: your text must fit the field

Each string occupies its characters plus some trailing NUL padding, up to the next data. `showstr`
tells you the editable field size:

```
$ python3 tools/r7_patch.py showstr R7_v153.150.127_db260702.bin ui_nu 0x2268
ui_nu @0x2268: 'Self Test'  string=9 chars, editable field=12 bytes (max 11 chars)
```

`setstr` refuses anything that won't fit (it needs room for one NUL terminator).

## Example: rename the Self Test menu item

```sh
python3 tools/r7_patch.py setstr R7_v153.150.127_db260702.bin ui_nu 0x2268 "MY DETECTOR" out.bin
```

Confirm only those bytes changed:

```sh
python3 - <<'PY'
s=open('R7_v153.150.127_db260702.bin','rb').read(); n=open('out.bin','rb').read()
d=[i for i in range(len(s)) if s[i]!=n[i]]
print("bytes changed:", len(d), "range:", hex(min(d)), "-", hex(max(d)))
PY
```

## Owner name / email (loss-prevention)

There is no dedicated free-text field in stock firmware, so pick visible string slots to repurpose.
Fields are ~12–19 chars, so an email may need two slots. Known-good slots on `R7_v153.150.127`:

| Offset | Stock text | Field |
|---|---|---|
| `0x2268` | `Self Test` | 12 B |
| `0xa458` | `Alert Display #1` | 20 B |
| `0xa478` | `Alert Display #2` | 20 B |

```sh
python3 tools/r7_patch.py setstr R7_v153.150.127_db260702.bin ui_nu 0xa458 "yourname"     t.bin
python3 tools/r7_patch.py setstr t.bin                         ui_nu 0xa478 "you@mail.com" R7_owner.bin
```

To put a name/email on the **power-on splash** (rather than a menu), that's a graphics edit — see
[GRAPHICS.md](GRAPHICS.md) (the boot logo is a bitmap, not text).

## Finding more strings

`r7_unpack.py extract <fw> decoded/` writes `decoded/ui_nu.bin`; then `strings -t x decoded/ui_nu.bin`
lists offsets (subtract nothing — those are the decoded-section offsets `setstr` expects). Useful
anchors on v153: mode names (`Advanced` `0xa380`, `Highway` `0x22b0`, `City` `0x2454`), Main-Display
options (`Scan Display` `0x2354`, `Mode Display` `0xbb98`, `Time Display` `0x2338`), band settings
(`K Filter`, `Ka Band`, `Ka Segmentation`, `Gatso RT3/4`, `Rear K Mute`).

> Offsets are specific to `R7_v153.150.127`. On another version, find them yourself with `strings`
> as above — the string *contents* are the same, only their offsets move.
