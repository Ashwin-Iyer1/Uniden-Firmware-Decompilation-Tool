# Uniden R8 firmware container — format & cipher

Reverse-engineered from `R8_v143.113.126_db260702.bin` (2,873,466 B = 0x2bd87a), cross-checked
against 7 historical R8 firmwares (2023-01 … 2024-10) and the Uniden R-Series updater tool
(v2.08 / v2.22 / v2.25). Companion to [FORMAT.md](FORMAT.md) (the R7 container).

## TL;DR

The R8 uses the **same container grammar as the R7** — same 12-byte length header, same
`DRSWxxx` section trailers, same `NMGF` footer. What changed is the **payload cipher**: the R7's
reversible bit-plane *transpose* is replaced, on the code and GPS-DB sections, by a genuine
**AES-128 in ECB mode** under **four distinct, device-held static keys**.

| Section | Payload transform | Recoverable from software alone? |
|---|---|---|
| `ui_nu` / MAI (main MCU) | **AES-128-ECB** (key `K_ui`) | ❌ needs the device key |
| `dsp_nu` / DSP (RF/detection) | **AES-128-ECB** (key `K_dsp`) | ❌ needs the device key |
| `gps_nu` / SUB (GPS MCU) | **AES-128-ECB** (key `K_gps`) | ❌ needs the device key |
| `GPSD:AEUS` (camera database) | **AES-128-ECB** (key `K_db`) | ✅ **recovered** (ECB codebook, no key) |
| `STSD` (voice/alert audio) | R7 old-transpose (key 255) | ✅ crackable with existing tools |
| `BLES` (Bluetooth-LE firmware) | **plaintext** (no obfuscation) | ✅ already readable |
| header / trailers / `NMGF` footer | plaintext | ✅ |

> The user's hypothesis — "bit-plane obfuscation *composed with* AES-128-ECB" — is **half right**.
> It *is* AES-128-ECB, confirmed. But it is not composed with the transpose on any one section:
> the file **mixes** the two encodings *per section* (code/DB = AES, sound = transpose), it does
> not stack them. Structural proof below.

## 1. Region map (definitive)

Block-cipher grid: **base `0x0C`, 16-byte blocks** (encryption begins exactly at the first section
body, right after the 12-byte header).

```
OFFSET RANGE              SIZE      NAME          TRANSFORM          NOTES
0x000000-0x00000c         12        header        PLAINTEXT          3× u32 LE raw section lengths: 0x38a8c/0x1d108/0xb57c; sound-bit=0
0x00000c-0x038c0c         232448    ui_nu / MAI   AES-128-ECB        ver 143. trailer "DRSWMAI", u16=0x488f (model 18)
0x038c15-0x055e15         119296    dsp_nu / DSP  AES-128-ECB        ver 113. trailer "DRSWDSP", u16=0x4871
0x055e1e-0x06141e         46592     gps_nu / SUB  AES-128-ECB        ver 126. trailer "DRSWSUB", u16=0x487e
0x061433-0x094433         208896    GPSD:AEUS db  AES-128-ECB        ident "AEUS", count 13050, date 20260702
0x094452-0x2b0446         2211840   STSD sound    OLD-TRANSPOSE(255) ISD3800 ADPCM; period-4/8 fill proves sub-16 periodicity
0x2b0465-0x2bd691         53804     BLES firmware PLAINTEXT          Dialog DA14585 BLE SoC, Cortex-M0, RAM base 0x07fc0000
0x2bd691-0x2bd865         468       pad           PLAINTEXT          0xFF pad
0x2bd865-0x2bd86e         9         trailer       PLAINTEXT          "DRSWBLE"
0x2bd86e-0x2bd87a         12        NMGF footer   PLAINTEXT          "NMGF" + u32(0) + u32(100)
```

`tools/r7_unpack.py parse()` walks the R8 file unmodified and recovers the first five sections
with correct offsets/versions (the filename's `v143.113.126` = ui/dsp/gps versions). The `key`
field it prints (182/184/183) is the R7 transpose default and does **not** apply to the AES
sections — it is meaningful only for `STSD` (255).

## 2. The cipher is AES-128-ECB — proof

**AES-128 (algorithm).** Confirmed from the updater tool's own type system, not merely assumed.
`net_main_225.exe` (`Uniden_R_Series_Tool`) defines `GPS_DB_TYPE { GPS_DB_OLD_ENC, GPS_DB_AES128 }`,
`DB_CHECK { …, ERROR_IS_NOT_AES128_DB, … }`, and `FWFileInfo.gpsDBExistAES128File`. The vendor
explicitly calls the new database encoding **AES128**.

**16-byte block (size).** Isolated 16-byte block collisions in the code sections are 100% at
distance ≡ 0 (mod 16), 0% at ≡ 8 (mod 16) — an 8-byte block would populate the latter. 32-byte is
excluded because 16-byte-period repeats occur that a 32-byte block cannot emit.

**ECB (mode).** Identical plaintext blocks produce identical ciphertext at **distant, unrelated
file positions** (e.g. the FF-padding tail block recurs 6–27× per section). CBC/CTR/OFB/stream
would not. A 37-block (592 B) contiguous run of one identical ciphertext block sits at ui_nu
0x35abc — a constant-plaintext pad region under ECB.

**A real cipher, not the R7 transpose.** Per-16-byte-block Hamming weight (popcount) is
`Binomial(128, ½)`: measured **mean 64.0, sd 5.65** across all four encrypted regions, vs
**mean 41.3, sd 20.75** for plaintext ARM. A bit-plane transpose is a *permutation* and therefore
**preserves popcount** — it is mathematically incapable of producing this distribution. Applying
the R7 transpose-decode lowers entropy by 0.000 at all four phase alignments (contrast R7, where
it drops ~1 bit/byte). This is genuine confusion+diffusion encryption.

## 3. Four distinct keys — one per section

The ciphertext of a known all-`0xFF` plaintext block (each section's pad tail) differs across all
four sections:

```
K_ui   E(FF^16) = f6ca69b0993e8b1b1acb67edc706ae96
K_dsp  E(FF^16) = 56f512c0264eeb0937ad08f7b9d0db85
K_gps  E(FF^16) = 7de11f93f3fdb01d89d48409cec73809
K_db   E(FF^16) = 42988169c62ea4d3de692a5788b6ccca
```

ECB is deterministic, so four different ciphertexts for the *same* plaintext ⇒ **four different
keys**. Practically: recovering any one key unlocks only its own section. There are **zero**
16-byte ciphertext blocks shared across section boundaries. `K_db` is **constant across all 8
historical R8 versions** (the DB tail-pad block is identical in every one) — a single fixed
per-product key, not per-release.

Each `E(FF^16)` above is a cheap **key-test oracle**: a candidate 16-byte key K is correct for a
section iff `AES-128-ECB-decrypt(E(FF^16), K) == FF^16`.

## 4. Where the keys are — and are not

- **Not in the firmware container.** The 12-byte header holds only three lengths; no key material.
- **Not in the PC updater tool.** `net_main_225.exe` references **no** cryptography assembly
  (only `HtmlAgilityPack`, `Ionic.Zip`, and the standard framework) and contains **no** cipher
  code. Its AES128 handling is a **magic-string classifier**: it compares the file's ident against
  `newFileGPSDBIdentifyStr[]` (`AEUS`/`AENZ`/`AEIL`/`AEEU`) purely to route the download. The tool
  **downloads pre-encrypted blobs and pushes them to the device; it never decrypts.**
- **Not a simple derivation.** A 1.3M-candidate dictionary/KDF sweep (model/version/magic strings
  via ASCII, MD5, SHA1/256 truncation, zero-pad) against the proven oracle returned **zero hits**.
- **Not in any pre-AES R8.** Every R8 back to `R8_20230112` is already AES on the code grid; there
  was never a transpose-era R8 to diff against.

**Conclusion:** the AES keys live **only in the on-device MCU bootloaders** (one per MCU: main /
DSP / GPS), which are not present in any distributed file. Decrypting the R8 **code** sections
therefore requires **hardware key extraction** from the user's own device — an SWD/JTAG flash/OTP
dump or a bootloader read-out-protection bypass — not a software attack on the update artifacts.

## 5. What *was* recovered without the key

**GPS/camera database (`GPSD:AEUS`) — fully decoded.** ECB leaks equality: identical plaintext
records encrypt to identical ciphertext. The R7 US database (`decoded/GPSD_LRDB.dec.bin`, already
decoded via the transpose) is byte-identical *in plaintext* to the R8 AEUS body, so it serves as a
complete **known-plaintext codebook**. Mapping R8 ciphertext blocks → R7 plaintext blocks yields a
codebook with **zero forward and zero reverse conflicts** over 13,056 blocks — proof the R8 AEUS
plaintext *is* that database. Result: **13,050 camera POIs** (lat/lon/type/heading; same 16-byte
record schema as [GPS_DATABASE.md](GPS_DATABASE.md)). Tool: `tools/r8_gpsdb.py`.

> Limitation: this recovers records that also appear in the R7 codebook. It succeeds completely
> here because this DB's content matches R7's; a future R8 DB with genuinely new records would
> leave those blocks unresolved (they need the actual `K_db`).

**Sound (`STSD`)** is the R7 old-transpose (key 255), directly crackable with `tools/r7_sound.py`
(Nuvoton ISD3800 ADPCM, per [SOUND.md](SOUND.md)).

**BLE firmware (`BLES`)** is plaintext Dialog **DA14585** Cortex-M0 (RAM base `0x07fc0000`);
disassemble as-is. Strings include the key-controller / laser-jammer BLE protocol.

## 6. Reproduce

```
python3 tools/r7_unpack.py parse  R8_v143.113.126_db260702.bin     # container walk
python3 tools/r8_gpsdb.py  export R8_v143.113.126_db260702.bin out.csv   # camera DB → CSV
```

Scratch analysis (entropy/ECB/popcount scripts, updater IL, key-test oracle, historical-version
corpus) lives under `r8_work/` (gitignored — derived from copyrighted firmware).
