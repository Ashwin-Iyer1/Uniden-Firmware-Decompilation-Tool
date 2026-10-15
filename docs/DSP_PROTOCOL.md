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
- 2 characters per `u8`, 4 per `u16`, **low byte first**. Each byte uses the usual high
  hex nibble then low nibble. For example, `0x1234` is transmitted as ASCII `3412`.
  The UI builder `0xd61c` emits the low byte before the high byte using `0xdbf0`; DSP
  `0xcea4` decodes the first pair into `[sp]`, the second into `[sp+1]`, then loads a
  little-endian halfword. This corrects the earlier big-endian description.
- For opcodes `0x0f`, `0x10`, and `0x11`, **the last 2 payload characters are a checksum:**

  ```
  csum = (opcode | 0x80) XOR every preceding payload character
  ```

  The XOR runs over the **ASCII characters**, not the decoded bytes (`0xc644`). The seed is the
  wire byte, so the opcode is covered even though it is not part of the payload. The short
  opcodes `0x32`, `0x33`, and `0x70` instead decode their two characters with `0xced8` and
  dispatch without a separate checksum comparison in `0xc780`.
- Each opcode has a **fixed payload length**, from a 6-entry table at `dsp_nu 0xf498`:

| Opcode | Wire byte | Payload chars | Meaning |
|---|---|---|---|
| `0x0f` | `0x8f` | 4 | short command |
| **`0x10`** | **`0x90`** | **32** | **radar configuration** (bands + Ka-segment mask) |
| `0x11` | `0x91` | 18 | secondary configuration |
| `0x32` | `0xb2` | 2 | short command |
| `0x33` | `0xb3` | 2 | short command |
| `0x70` | `0xf0` | 2 | short command |

The framer uses these fixed lengths. For `0x0f`, `0x10`, and `0x11`, the dispatcher checks the
checksum before their configuration handlers run. Configuration updates are **not transactional**:
fields are parsed and applied in sequence, so a later malformed field can leave earlier changes
in place. `r7_ipc.py` checks the documented XOR convention for every opcode; for the short
commands, its `checksum OK/BAD` output is a host-side calculation, not a prediction of the
DSP's acceptance. The helper's short-command builder likewise emits that convention, without
establishing the short command's argument semantics.

---

## Opcode `0x10` — radar configuration

32 payload characters = **30 characters of data + 2 of checksum**. Twelve fields, in this order
(`dsp_nu 0xc894`–`0xcc0e`):

| # | Field | Width | UI config source |
|---|---|---|---|
| 1 | `f1_u16` | u16 | Encoded from `+0x0f`, `+0x0d`, `+0xb1`; high byte zero |
| 2–7 | `f2`…`f7` | u8 ×6 | `+0xdd`, `+0xde`, `+0xdf`, `+0x112`, `+0x113`, `+0x114` |
| 8 | `f8_nibbles` | u8 | `0x40` plus a mode from `+0xc9` and SRAM `0x200003c4`; the DSP splits high/low nibbles |
| 9 | `f9` | u8 | Encoded from `+0x06`, `+0x07`, `+0x08` and the builder's argument |
| 10 | `f10` | u8 | Mode from `+0xcb`, `+0xcc` via UI `0x15018` |
| 11 | **`band_bits`** | u16 | band enable bitfield |
| 12 | **`ka_mask`** | u16 | Ka-segment mask — **only parsed if `band_bits` bit0 or bit2 is set** |

The widths sum to `4 + 2×9 + 4 + 4 = 30`, which independently reproduces the declared payload
length of 32 — a useful check that the field list is complete and correctly ordered.

### The UI builder and actual transport

The complete emitter is **`ui_nu 0xd61c`**, reading config at **SRAM `0x200008ec`**.
It constructs wire byte `0x90`, all twelve fields, and the XOR of bytes 0 through 30,
then emits the 33-byte frame through **`0xd5d0(0x10, frame, 33)` → `0x1b67c` → UART5
`0x40075000`**. `0xd5d0` makes up to three attempts and waits for a response through
`0xe750`. These routines were previously misidentified as NVM load/save code.
The DSP receives this format on UART3 `0x40073000`; the matching format and settings
map establish the intended firmware link, while physical wiring has not been probed.

UI UART3 `0x40073000` is a different path: its IRQ `0x10cc` answers byte `0x40` with
`0x41`. It is not the configuration sender. The SUB/GPS `0xd2/0xab` message is a
separate settings copy; no GPS re-framing stage is needed to explain this DSP frame.

Exact transformations for the non-bitfield inputs, with `cfg` relative to `0x200008ec`:

```text
f1 = (cfg[0x0f] == 0 ? 0x41 : cfg[0x0d] == 1 ? 0x11 : 0x03)
     | (cfg[0xb1] == 0 ? 0x20 : 0x04)
f8 = 0x40 | (byte[0x200003c4] == 1 ? 0 : cfg[0xc9] == 0 ? 2 : 1)
f9 = (builder_arg == 1 ? 0x80 : 0)
     | (cfg[0x06] != 0 ? 1 : 0)
     | (cfg[0x07] != 1 ? 2 : 0)
     | (cfg[0x08] != 1 ? 4 : 0)
f10 = cfg[0xcb] == 1 ? 0 : cfg[0xcc] == 1 ? 2 : 1
```

These are observed byte transformations, not recovered source-level field names.

| `band_bits` bit | UI condition setting it |
|---|---|
| 0 | `cfg[0xce] == 1` |
| 1 | `cfg[0xb6] == 1` |
| 2 | `cfg[0xb2] == 0` |
| 3 | `cfg[0xb5] != 0 && cfg[0x115] == 0` |
| 4 | `cfg[0xb5] == 0` |
| 5 | `cfg[0xcf] == 1` |
| 6 | `cfg[0x0b] == 0` |
| 7 | `cfg[0x0c] == 0` |
| 9 and 10 together | `cfg[0x11a] == 0` |

The UI sets mask bits 0–8 when `cfg[0xe0]`…`cfg[0xe8]` are zero, respectively;
this directly connects menu **Ka 1…Ka 9** to DSP mode IDs **`0x10`…`0x18`** with
the same polarity. It also emits bit9 for `cfg[0xe9] == 0`, but neither recovered
mask applier uses bit9. Mask bit14 is set when `cfg[0xb3] == 1`; bit15 is set when
`cfg[0xb4] == 0`. Other bitfield bits remain zero in this builder.

For a reproducible encoding check, fields
`[0x23,7,7,7,8,8,8,0x41,0,0,0x0001,0x0081]` produce wire byte `0x90` and ASCII
payload **`23000707070808084100000100810093`**. This is an illustrative UI-compatible
configuration, not a captured or stock default frame.

REA evidence: builder `ev_98ad9bcd378482dea509bd03e9f8200430a881c9f51c2efd12223233bbb20ef3`,
byte encoder `ev_2b3aa457efbdcc11acbc9bb1a8f81f418ab8a8254819b842be8a32f39d8648e0`,
sender `ev_f80fc1525742ea87861871531e370c311480c2d4ad015b57fdbdadd2ca74518a`,
UART5 TX `ev_bace26a69c7d35f5d8c2b4e14a3ee3c9ab944e89a3b7829bf747d1bfa7312dd5`,
DSP u16 parser `ev_88ded55ca4d01c9c4c7f39c7416c2624cdc4cef0c612fad5177f723341d370ba`,
and u8 parser `ev_bf22aa25f8c863893173bdb03380992f4a4af52f4a6fdc6023423ffd5c4c1f55`.

### `ka_mask` — the nine Ka segments

Bit *N* (for *N* = 0..8) controls the sweep record whose **mode id is `0x10 + N`**. The DSP walks
its sweep-schedule records and **overwrites each record's stored `enable_default` with
`(ka_mask >> N) & 1`** (`0x5522`, a `tbb` jump table over the nine mode ids). The runtime mask
therefore **wins over whatever is baked into the firmware image** — which is exactly why editing
the flash defaults is the *weaker* lever of the two.

Bits 9-15 are not Ka-segment bits. In the combined table, bits 14 and 15 gate K-band
sweep modes (`0x5416`–`0x550a`); bits 9-13 have no effect in either mask applier.

### `band_bits` — enables and path selection

The bits drive band gating and pick which sweep-schedule group gets loaded. Their observed roles:

| Bit | Role |
|---|---|
| 0 | Selects nine Ka segments; bit1 takes priority in the standard builder |
| 1 | Selects three narrow Ka windows in the standard builder: 33.701–33.899, 34.600–34.870, and 35.401–35.599 GHz |
| 2 | With bit0, selects the combined K/Ka segment table |
| 3 | Selects the wide K table, 23.899250–24.251002 GHz, unless bit4 is set |
| 4 | Selects the narrow K table, 24.079998–24.200002 GHz |
| 5 | sweep-builder argument, plus two further config calls |
| 6, 7 | select a special sweep group |
| 9, 10 | OR'd together to select a special sweep group |

These labels describe the coefficient windows selected by the DSP. The config-byte map above
is proven; exact marketing labels for the remaining modes need further UI tracing. In the standard
builder, clearing bits3 and4 selects the default K table, 24.049002–24.251002 GHz.

The parser and two sweep builders have different gates:

| Bits 0/1/2 | Field 12 parsed? | Selected main table | Ka mask applied to segment records? |
|---|---|---|---|
| bit0=1, bit2=1; bit1 either | Yes | 36-record combined K/Ka table | Yes |
| bit0=1, bit1=0, bit2=0 | Yes | 28-record Ka segment table | Yes |
| bit0=1, bit1=1, bit2=0 | Yes | 16-record narrow Ka table | No; it contains no segment records |
| bit0=0, bit2=1 | Yes | 14- or 16-record standard table | No |
| bit0=0, bit2=0 | No | 14- or 16-record standard table | No |

The DSP reads field 12 if bit0 **or** bit2 is set (`0xcba2`). Bit0 **and** bit2 select the
36-record builder (`0x8998` → `0x53c0`). Otherwise `0x5788` selects one of nine standard groups:
bit1 chooses a narrow Ka group before bit0 can choose a segmented group. That builder also
contains a Ka-mask loop (`0x5938`–`0x5a08`), gated by bit0. Thus the mask changes Ka segment
records when **bit0 && (bit2 || !bit1)**. The earlier claim that both bit0 and bit2 were always
required was incorrect.

The frame is always 32 payload characters regardless; when field 12 goes unread those characters
are still present and still covered by the checksum. Applying a mask to records is a static
firmware result, not proof of UART reachability or observed RF detection.

### Two code paths

`band_bits` bit0 **and** bit2 set → the DSP copies a **36-record** schedule group from flash
`0xecdc` into its working buffer and applies `ka_mask` per record (`0x53c0`). Otherwise it takes
the nine-group path (`0x5788`), which selects 14, 16, or 28 records and applies the mask to
mode IDs `0x10`–`0x18` when bit0 is set. The 28-record groups are `0xe64c`, `0xe87c`, and
`0xeaac`, selected by the K-table bits. All these counts include two group delimiters.

The stack/register call chain independently confirms the bit mapping: `0xcc06` calls `0x8908`
with `(bit1, bit4, bit3, bit0, bit2, bit7, bit6, inverse_state_bit1, bit5, ka_mask,
bit9_or_bit10)`. Its fallback calls `0x5788` with `(bit4, bit3, bit1, bit0,
inverse_state_bit1, bit5, ka_mask)`; its combined branch calls `0x53c0` with
`(inverse_state_bit1, bit5, ka_mask)`. `ka_mask` is the tenth argument to `0x8908`,
at caller stack `+0x14` / callee stack `+0x44` after its 48-byte prologue. The other state
bit comes from `0x859c`, not directly from `band_bits`.

REA evidence: `ev_f9d373ff2980a0433ea3e0a96c12820e1102be7b2fd0d28dd3d594caa2d32062`
(`0x8908`), `ev_7dd3ab246d0065049573e39ad538848f53ba73888afed9db1ff0a70b273e7ce8`
(`0x5788`), and `ev_736c0a58b355d5f1c5aebde838a7ea7ef260552828540cee68e2d437dca7e415`
(`0x53c0`). Decompiler argument guesses were checked against Thumb instructions and the
coefficient/schedule bytes in `dsp_nu.bin`.

---

## Using the tool

```sh
# what the DSP will accept
python3 tools/r7_ipc.py opcodes

# build a configuration frame: only Ka segments 1, 3 and 5 swept
python3 tools/r7_ipc.py config --ka 1,3,5

# decode the illustrative UI-compatible frame (checksum and fields)
python3 tools/r7_ipc.py decode 903233303030373037303730383038303834313030303030313030383130303933

# verify the codec against the format rules
python3 tools/r7_ipc.py selftest
```

`config` preserves its default `band_bits=0x0005` (bits 0 and 2), selecting the combined table.
`--bands 0x0001` selects the 28-record Ka segment path instead. Override the bitfield
with `--bands 0xHHHH`, and set any other field with `--field f2=0x12`. The tool warns if you
choose a `band_bits` value that would leave Ka segment records unchanged. The default is not a
recovered stock configuration: other fields remain zero unless supplied.

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
