# The DSP serial protocol — band filtering without reflashing

The DSP MCU (`dsp_nu`) accepts a small set of **framed messages on its UART**. One of them,
opcode `0x10`, is a complete radar configuration: which bands are enabled and **which of the nine
Ka segments are swept**. The DSP applies it immediately.

This matters because it is the one path to band filtering that is **not a firmware edit**. Nothing
here reflashes anything — the settings live in RAM and are lost at reset.

Tool: [`tools/r7_ipc.py`](../tools/r7_ipc.py) builds and decodes these frames.

> **Not yet proven: whether you can reach this UART from outside the case.** See
> [Reachability](#reachability) — read that before assuming any of this is usable over USB.

---

## Frame format

```
<opcode | 0x80>  <payload: N uppercase-ASCII-hex characters>
```

- **The high bit marks the start of a frame.** Any byte with bit 7 set resets the receiver and
  begins a new message (`dsp_nu 0xd68c`). Payload characters are ASCII hex, which is 7-bit, so a
  frame byte can never be mistaken for payload — that is the whole point of the design.
- **The payload is ASCII hex**, uppercase only: `0`-`9` and `A`-`F`. The parser maps anything else
  to `0xFF` and rejects the message (`0xdb76`), so lowercase `a`-`f` **fails**.
- 2 characters per `u8`, 4 per `u16`, **big-endian** (first pair is the high byte).
- **The last 2 payload characters are a checksum:**

  ```
  csum = (opcode | 0x80) XOR every preceding payload character
  ```

  The XOR runs over the **ASCII characters**, not the decoded bytes (`0xc644`). The seed is the
  wire byte, so the opcode is covered even though it is not part of the payload.
- Each opcode has a **fixed payload length**, from a 6-entry table at `dsp_nu 0xf498`:

| Opcode | Wire byte | Payload chars | Meaning |
|---|---|---|---|
| `0x0f` | `0x8f` | 4 | short command |
| **`0x10`** | **`0x90`** | **32** | **radar configuration** (bands + Ka-segment mask) |
| `0x11` | `0x91` | 18 | secondary configuration |
| `0x32` | `0xb2` | 2 | short command |
| `0x33` | `0xb3` | 2 | short command |
| `0x70` | `0xf0` | 2 | short command |

A message whose length or checksum is wrong is dropped without side effects.

---

## Opcode `0x10` — radar configuration

32 payload characters = **30 characters of data + 2 of checksum**. Twelve fields, in this order
(`dsp_nu 0xc894`–`0xcc0e`):

| # | Field | Width | Notes |
|---|---|---|---|
| 1 | — | u16 | first field |
| 2–7 | — | u8 ×6 | |
| 8 | — | u8 | the DSP splits this into high and low nibbles |
| 9–10 | — | u8 ×2 | |
| 11 | **`band_bits`** | u16 | band enable bitfield |
| 12 | **`ka_mask`** | u16 | Ka-segment mask — **only parsed if `band_bits` bit0 or bit2 is set** |

The widths sum to `4 + 2×9 + 4 + 4 = 30`, which independently reproduces the declared payload
length of 32 — a useful check that the field list is complete and correctly ordered.

### `ka_mask` — the nine Ka segments

Bit *N* (for *N* = 0..8) controls the sweep record whose **mode id is `0x10 + N`**. The DSP walks
its sweep-schedule records and **overwrites each record's stored `enable_default` with
`(ka_mask >> N) & 1`** (`0x5522`, a `tbb` jump table over the nine mode ids). The runtime mask
therefore **wins over whatever is baked into the firmware image** — which is exactly why editing
the flash defaults is the *weaker* lever of the two.

Bits 9-15 are not segment bits. Bits 14 and 15 gate other (non-segmented) sweep modes.

### `band_bits` — enables and path selection

The bits drive band gating and pick which sweep-schedule group gets loaded. Their observed roles:

| Bit | Role |
|---|---|
| 0 | **with bit2, enables the Ka-segment path**; also passed to the sweep builder |
| 1, 3, 4 | sweep-builder arguments |
| 2 | **with bit0, enables the Ka-segment path** |
| 5 | sweep-builder argument, plus two further config calls |
| 6, 7 | select a special sweep group |
| 9, 10 | OR'd together to select a special sweep group |

Two different gates, easy to conflate:

- the DSP **reads** field 12 if bit0 **or** bit2 is set (`0xcba2`);
- it **applies** the mask only if bit0 **and** bit2 are set — that is the condition for taking the
  segmented sweep path (`0x8998`).

So **set both**. With only one of them, the mask is parsed and then thrown away.

The frame is always 32 payload characters regardless; when field 12 goes unread those characters
are still present and still covered by the checksum.

Which marketing band name (X / K / Ka / laser / MRCD / …) each bit corresponds to is **not yet
pinned down** — the roles above are what the code demonstrably does, and naming them would be a
guess. The Ka-segment semantics, by contrast, are certain.

### Two code paths

`band_bits` bit0 **and** bit2 set → the DSP copies a **36-record** schedule group from flash
`0xecdc` into its working buffer and applies `ka_mask` per record (`0x53c0`). Otherwise it takes
the nine-group path (`0x5788`) and no segment masking happens.

---

## Using the tool

```sh
# what the DSP will accept
python3 tools/r7_ipc.py opcodes

# build a configuration frame: only Ka segments 1, 3 and 5 swept
python3 tools/r7_ipc.py config --ka 1,3,5

# decode a captured frame (checksum verified, fields broken out)
python3 tools/r7_ipc.py decode 903030303030303030303030303030303030303030303030303035303030373932

# verify the codec against the format rules
python3 tools/r7_ipc.py selftest
```

`config` defaults `band_bits` to `0x0005` (bits 0 and 2) so the mask is actually read. Override it
with `--bands 0xHHHH`, and set any other field with `--field f2=0x12`. The tool warns if you
choose a `band_bits` value that would cause the mask to be ignored.

---

## Reachability

**This is the open question, and it is a hardware question the firmware image cannot answer.**

What the image *does* prove: the DSP's byte pump (`0x2e6a`) pulls each received byte off one ring
buffer and hands it to **both** consumers —

- the **text debug console** (`0x2ea0`, the `BSEL` / `PLL` / `SKAH` commands in
  [FIRMWARE_MAP §2.1](FIRMWARE_MAP.md)), and
- the **frame state machine** (`0xd68c`) described here, unless the mode flag at SRAM `0x20000072`
  equals 1, which suppresses framing and leaves console-only.

So the console and this protocol are **the same physical UART**. They stand or fall together: if
you can reach one, you can reach the other. That collapses two open questions into one — *is the
DSP UART bridged to the external CP210x port, or only to an internal header?*

Until someone answers that with a probe or a logic analyser on real hardware, treat this document
as a decoded protocol, not a working remote control. Do not assume plugging in USB gets you here.

---

## Why this is the better lever for band filtering

| | Runtime protocol | Firmware edit |
|---|---|---|
| Ka segments | `ka_mask`, applied immediately | flash `enable_default` — **overridden by the mask anyway** |
| Risk | none to the image; lost at reset | bad flash needs Recovery Mode |
| Reach | needs UART access (unproven) | works, but only changes defaults |

Segment *frequencies* — as opposed to which segments are enabled — live in the `tuner_code` field
of the sweep records and are a data edit; see
[FIRMWARE_MAP §2.2](FIRMWARE_MAP.md).
