# Changing bitmaps (boot logo & display graphics)

The R7 display is **176 × 60**, color. Bitmaps in `ui_nu` come in three formats; `r7_gfx.py`
renders and replaces any of them **in place** (byte length preserved).

| Format | Bits/px | Row stride | Used for |
|---|---|---|---|
| `1bpp` | 1 | ⌈w/8⌉ B | monochrome glyphs/icons |
| `2bpp` | 2 | ⌈w/4⌉ B (4 shades, colorized by firmware) | screen backgrounds, **boot logo** |
| `565` | 16 | w·2 B (RGB565) | full-color tiles/icons |

Pixel packing for 1/2-bpp is **MSB-first** (leftmost pixel = the high bits); the tool handles this.

## Tool: `r7_gfx.py`

```
python3 tools/r7_gfx.py render  <fw> <hex_off> <w> <h> <1bpp|2bpp|565> <out.png>
python3 tools/r7_gfx.py replace <fw> <hex_off> <w> <h> <1bpp|2bpp|565> <in.png> <out.bin>
```

Offsets are **decoded ui_nu** offsets. Render always saves a 4× upscaled PNG so you can see it.

## Replace the boot "Uniden" logo

The power-on splash is a **176×60 2-bpp** image at ui_nu `0x2d526`.

```sh
# 1. See the current logo
python3 tools/r7_gfx.py render R7_v153.150.127_db260702.bin 0x2d526 176 60 2bpp bootlogo.png

# 2. Make a 176x60 PNG (white/bright = foreground, black = background). Then:
python3 tools/r7_gfx.py replace R7_v153.150.127_db260702.bin 0x2d526 176 60 2bpp mylogo.png R7_bootlogo.bin
```

Because it's 2-bpp (4 shades) and the firmware applies the theme color, use brightness to pick the
shade: **black = off, white = brightest**, mid-greys = the in-between shades. A custom splash with
your name/email is an effective loss-prevention mark.

### Generating a logo from text (example)

```python
from PIL import Image, ImageDraw, ImageFont
img = Image.new('L', (176, 60), 0)
d = ImageDraw.Draw(img)
f = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 20)  # any TTF
d.text((10, 8), 'YOUR NAME', font=f, fill=255)
d.text((10, 38), 'you@mail.com', font=ImageFont.truetype(f.path, 11), fill=180)
img.save('mylogo.png')
```

## Verify only the logo changed

```sh
python3 - <<'PY'
s=open('R7_v153.150.127_db260702.bin','rb').read(); n=open('R7_bootlogo.bin','rb').read()
d=[i for i in range(len(s)) if s[i]!=n[i]]
print('bytes changed:', len(d), 'all in ui_nu:', all(0x18<=i<0x18+195072 for i in d))
PY
```

## Round-trip guarantee

RGB565/2-bpp/1-bpp encode is the exact inverse of decode, so `render` then `replace` with the
unchanged PNG reproduces the original bytes. This means any visible change is exactly and only your
change — nothing else in the image is disturbed.

## Other assets

Icons and screen backgrounds live in the same graphics region (`~0x20000–0x2e000` decoded). The
signal-strength meter tiles, for instance, are `114×9` RGB565. Use `r7_gfx.py render` at a candidate
offset/size/format to inspect; see [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md) for how the
asset table and blitters were found.

> The `0x2d526` boot-logo offset is for `R7_v153.150.127`; it moves on other versions.
