# Reverse-engineering notes & methodology

How the format was cracked, and how to re-locate feature offsets on a **different firmware version**
or extend the toolkit. The specific offsets in the tools are for `R7_v153.150.127`; the *methods*
below are version-independent.

## Tooling used

- **Python + capstone** for quick Thumb-2 disassembly (`pip install capstone`).
- **Ghidra** for full decompilation. Import `decoded/*.bin` as **`ARM:LE:32:Cortex:default`**,
  image base `0x0`, then seed the reset handler and auto-analyze.
- **Pillow** to render candidate bitmaps and *see* what's stored.

## Step 0 — decode the sections

```sh
python3 tools/r7_unpack.py parse   <fw.bin>          # sections, offsets, versions, keys
python3 tools/r7_unpack.py extract <fw.bin> decoded/ # decoded ARM images for Ghidra
```

The code-section subtract keys (ui_nu 182, dsp_nu 184, gps_nu 183) were found by brute-forcing the
key that maximizes valid Thumb-2 at the reset handler — see the `thumb_score` approach; re-run it if
a new version shifts keys.

## Step 1 — Ghidra, headless

Ghidra 11+/12 dropped Jython, so **write scripts in Java** for headless runs. A minimal driver:

```sh
HL=/path/to/ghidra/support/analyzeHeadless
"$HL" <projdir> proj -import decoded/ui_nu.bin -processor "ARM:LE:32:Cortex" \
      -preScript Seed.java -postScript YourScript.java -scriptPath <dir> -deleteProject
```

`Seed.java` disassembles the reset handler as Thumb so analysis has an entry point:

```java
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.lang.Register;
import java.math.BigInteger;
public class Seed extends GhidraScript {
  public void run() throws Exception {
    Register tmode = currentProgram.getRegister("TMode");
    Address a = toAddr(0x2acL);                      // ui_nu reset (see FORMAT.md for others)
    if (tmode != null) currentProgram.getProgramContext().setValue(tmode, a, a, BigInteger.ONE);
    disassemble(a);
  }
}
```

Much of the display code is reachable only indirectly, so a lot of functions come up as
*undefined*. A `find-or-create` helper (walk back to a `push {…, lr}` prologue, then
`createFunction`) lets you decompile them anyway — see the scripts referenced in the project history.

## Step 2 — find a feature by its string, then its data

The reliable pattern: **string → code → data**.

1. `strings -t x decoded/ui_nu.bin` (or Ghidra's Defined Strings) to find an anchor
   (`Advanced`, `Scan Display`, `K Filter`, …).
2. Find references to that string; walk to the function that uses it. Beware **menu-registration
   stubs** (`FUN_0000a080(label)`) — those just draw the option, not the feature.
3. From the real renderer, follow the data it reads — often a table in SRAM `.data`.

## Step 3 — the `.data` catch (important)

Global tables live in **`.data`, which is LZSS-compressed in flash** and unpacked at boot. Direct
offset math into flash will land on the wrong bytes. To read a `.data` global statically:

1. Find the copy-descriptor table (ui_nu `0x2f78c` on v153): entries `{src, dst, len, func}`.
2. The `.data` descriptor points a **decompressor** (`FUN_00000488`) at compressed flash → SRAM.
3. Re-implement that LZSS in Python (`r7_scan.py:decompress`), decompress the block, then index by
   `SRAM_addr − .data_VMA`.

The decompressor's control byte: `low 3 bits` = literal count + 1 (0 ⇒ next byte is the count),
`high 4 bits` = match/fill length (0 ⇒ next byte), `bit 3` = back-reference vs zero-fill.

Also note: the compressed `.data` tail makes the real ui_nu content run slightly past its declared
length field — decode a bit beyond nominal (the tools already do).

## Step 4 — graphics

The blitters reveal the pixel format: `FUN_00005690` = 1-bpp (⌈w/8⌉ B/row), `FUN_000056dc` = 2-bpp
(⌈w/4⌉), `FUN_00009d9c` = RGB565 (`u16`/px). 1/2-bpp is MSB-first. Find asset addresses in the
pointer table the draw code indexes, then `r7_gfx.py render` at (offset, w, h, format) to view.

## Contributing a new firmware version

The highest-value contributions are **version → offset tables**. For a new `.bin`:
1. `parse`/`extract` (works on any R-series image).
2. Re-derive keys if needed; confirm the reset handlers disassemble cleanly.
3. Re-locate: boot logo, self-test/owner string slots, scan tiles + `.data` layout.
4. Open a PR adding the offsets (ideally a small `versions/` map the tools can select from).

Community discussion and prior art: [rdforum.org](https://www.rdforum.org/) and
[AngeloD2022/uniden-firmware-tool](https://github.com/AngeloD2022/uniden-firmware-tool).
