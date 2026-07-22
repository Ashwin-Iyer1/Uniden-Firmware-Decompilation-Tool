# Editing the GPS / camera database

The R7's camera database (`LRDB`, US "old" format) is fully editable — add speed cameras, red-light
cameras, and custom alert points from any source. `r7_gpsdb.py` handles decode, encode, sorting,
padding, the POI count, and the date automatically.

## Record format (16 bytes, decoded)

```
lat  float32     latitude  (decimal degrees)
lon  float32     longitude (decimal degrees)
f0   u8          camera TYPE:  1 = speed camera,  2 = red-light camera
speed u8         posted speed limit (speed cameras); 0 = none
f2   u8          directional match mode: 1 = one-way (alert within ±30° of heading),
                              2 = two-way (±30° of heading or its reverse)
cat  u8          alert category (1/2)
heading u16      approach direction, 0–360 (360 = any direction)
—    u16         reserved (0xFFFF)
```

Key facts: **POI count** is stored (encoded) in the footer, there is **no checksum**, the body is
`0xFF`-padded to a 512-byte boundary, and records **must be sorted by latitude, descending** (the
device looks up nearby points by latitude window). `r7_gpsdb.py` always re-sorts, so **CSV row
order does not matter.**

## Tool: `r7_gpsdb.py`

```
python3 tools/r7_gpsdb.py export <fw> <out.csv>
python3 tools/r7_gpsdb.py build  <in.csv> <template_fw> <out.bin> [YYYYMMDD]
python3 tools/r7_gpsdb.py add    <fw> <out.bin> <lat> <lon> [speed] [category] [heading] [YYYYMMDD]
```

CSV columns: `lat, lon, type, speed, heading, f2, category` (`type` = `speed`|`redlight`). See
[`examples/cameras.template.csv`](../examples/cameras.template.csv).

## Workflows

**Export → edit in a spreadsheet → rebuild:**
```sh
python3 tools/r7_gpsdb.py export R7_v153.150.127_db260702.bin cameras.csv
# ...edit cameras.csv (add/remove/modify rows, any order)...
python3 tools/r7_gpsdb.py build cameras.csv R7_v153.150.127_db260702.bin R7_custom.bin
```

**Add one point quickly** (speed given ⇒ speed camera; omit ⇒ red-light):
```sh
python3 tools/r7_gpsdb.py add R7_v153.150.127_db260702.bin out.bin 32.9201 -97.1307 45   # speed, 45
python3 tools/r7_gpsdb.py add R7_v153.150.127_db260702.bin out.bin 51.5074 -0.1278       # red-light
```

## Verify the edit

```sh
python3 - <<'PY'
import sys; sys.path.insert(0,'tools')
from r7_unpack import parse
s=open('R7_v153.150.127_db260702.bin','rb').read(); n=open('R7_custom.bin','rb').read()
for a,b in zip(parse(s),parse(n)):
    ra=s[a['offset']:a['offset']+a['length']]; rb=n[b['offset']:b['offset']+b['length']]
    tag='GPS(edited)' if a['name'].startswith('GPSD') else ('same' if ra==rb else '*** DIFF ***')
    print(f"{a['name']:14s} {tag}")
PY
```
Everything except `GPSD:LRDB` should read `same` — only the database changed.

## Flashing

The database is the **lower-risk** thing to flash (via the Updater's "Download Files" path). See
[FLASHING.md](FLASHING.md). Always keep your stock `.bin`.

## Sourcing camera data

Bring your own coordinates (e.g. public speed-camera datasets, red-light-camera lists, or points
you mark yourself). Respect the source's license and your local laws. **Do not commit databases
derived from Uniden's firmware** — the `.gitignore` excludes `*.csv` for this reason (the template
under `examples/` is the exception).
