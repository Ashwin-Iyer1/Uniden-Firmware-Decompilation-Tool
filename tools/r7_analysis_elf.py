#!/usr/bin/env python3
"""Wrap decoded R7 Cortex-M bytes in an analysis-only ARM ELF (not flashable).

The input is copied byte-for-byte into one RX PT_LOAD at virtual address zero.
The reset vector supplies the ELF entry and Reset_Handler Thumb function symbol.
Optional seeds are analyst-supplied addresses, not automatically discovered
functions; symbol sizes stay zero because their extents are unknown.

Usage:
    python3 tools/r7_analysis_elf.py decoded/ui_nu.bin
    python3 tools/r7_analysis_elf.py decoded/ui_nu.bin \
        --seed b340:seed_b340 --seed 13e3c:seed_13e3c --seed f1a0:seed_f1a0
    python3 tools/r7_analysis_elf.py decoded/ui_nu.bin --vector-count 158 \
        --seed b340:seed_b340 --seed 13e3c:seed_13e3c --seed f1a0:seed_f1a0

Addresses are hexadecimal, with or without 0x. Output defaults to the ignored
decoded/rea directory; vector-seeded output uses .vectors.analysis.elf. A
.manifest.json sidecar records hashes, explicit seeds, and vector-derived seeds.
Existing identical files are retained; differing files require a new --output.
This file is for disassemblers, NEVER a firmware update.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct


ELF_HEADER = struct.Struct("<16sHHIIIIIHHHHHH")
PROGRAM_HEADER = struct.Struct("<8I")
SECTION_HEADER = struct.Struct("<10I")
SYMBOL = struct.Struct("<IIIBBH")
PAYLOAD_OFFSET = 0x1000


def align(value, boundary=4):
    return (value + boundary - 1) & ~(boundary - 1)


def parse_seed(value):
    """Accept explicit hexadecimal address:name seeds, preserving neither sizes nor guesses."""
    try:
        address, name = value.split(":", 1)
        address = int(address, 16)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("seed must be hexadecimal-address:name") from exc
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.$]*", name):
        raise argparse.ArgumentTypeError("seed name must be a simple ASCII symbol name")
    if not 0 <= address <= 0xFFFFFFFF:
        raise argparse.ArgumentTypeError("seed address must fit an unsigned 32-bit value")
    return address, name


def vector_seeds(payload, count, explicit_seeds=()):
    """Take unique valid Thumb pointers from a caller-bounded vector table.

    Entry zero is the stack pointer, entry one already supplies Reset_Handler.
    The count is never guessed from firmware bytes. Duplicate handler addresses
    (including reset and explicitly supplied seeds) do not create more symbols.
    """
    if count < 2 or count * 4 > len(payload):
        raise ValueError("vector count must be at least 2 and fit within the input")
    entry = struct.unpack_from("<I", payload, 4)[0]
    seen = {entry & ~1, *(address & ~1 for address, _ in explicit_seeds)}
    names = {"Reset_Handler", *(name for _, name in explicit_seeds)}
    seeds = []
    for index in range(2, count):
        pointer = struct.unpack_from("<I", payload, index * 4)[0]
        address = pointer & ~1
        if not pointer & 1 or address + 2 > len(payload) or address in seen:
            continue
        name = f"vector_{index}"
        if name in names:
            raise ValueError(f"vector symbol name conflicts with explicit seed: {name}")
        seeds.append((pointer, name))
        seen.add(address)
    return seeds


def check_output(path, contents):
    """Permit idempotent reruns but never replace a different analysis artifact."""
    if path.exists() and path.read_bytes() != contents:
        raise ValueError(f"existing output differs; choose a new --output: {path}")


def write_new_or_identical(path, contents):
    try:
        with path.open("xb") as handle:
            handle.write(contents)
    except FileExistsError:
        check_output(path, contents)


def make_elf(payload, seeds=()):
    """Return a deterministic ELF32 image without modifying any input bytes."""
    if len(payload) < 8:
        raise ValueError("input must contain at least the initial SP and reset vector")
    entry = struct.unpack_from("<I", payload, 4)[0]
    if not entry & 1:
        raise ValueError("reset vector must have its Cortex-M Thumb bit set")
    if (entry & ~1) + 2 > len(payload):
        raise ValueError("reset vector points outside the input image")
    functions = [(entry, "Reset_Handler")]
    names = {"Reset_Handler"}
    for address, name in seeds:
        if address < 0 or (address & ~1) + 2 > len(payload):
            raise ValueError(f"seed {name} at {address:#x} is outside the input image")
        if name in names:
            raise ValueError(f"duplicate function symbol name: {name}")
        names.add(name)
        functions.append((address | 1, name))

    strings = bytearray(b"\0")

    def intern(name):
        offset = len(strings)
        strings.extend(name.encode("ascii") + b"\0")
        return offset

    # ARM mapping symbols have even addresses and STT_NOTYPE; STT_FUNC values
    # retain bit zero to express Thumb mode. No mapping is asserted before the
    # first explicit code seed: the image includes vectors and embedded data.
    symbols = bytearray(SYMBOL.size)
    code_addresses = sorted({address & ~1 for address, _ in functions})
    for index, address in enumerate(code_addresses):
        symbols.extend(SYMBOL.pack(intern(f"$t.{index}"), address, 0, 0, 0, 1))
    first_global = 1 + len(code_addresses)
    for address, name in functions:
        symbols.extend(SYMBOL.pack(intern(name), address, 0, 0x12, 0, 1))

    provenance = (
        "R7 analysis-only ELF wrapper; NOT A FLASHABLE FIRMWARE UPDATE.\n"
        f"Input SHA-256: {hashlib.sha256(payload).hexdigest()}\n"
        "Function symbols: reset vector and explicit analyst seeds only; sizes unknown.\n"
    ).encode("ascii") + b"\0"
    section_names = b"\0.text\0.symtab\0.strtab\0.comment\0.shstrtab\0"

    image = bytearray(PAYLOAD_OFFSET)
    image.extend(payload)

    def append(data, boundary=1):
        image.extend(b"\0" * (align(len(image), boundary) - len(image)))
        offset = len(image)
        image.extend(data)
        return offset

    symbol_offset = append(symbols, 4)
    string_offset = append(strings)
    comment_offset = append(provenance)
    section_string_offset = append(section_names)
    section_offset = append(b"", 4)
    sections = [
        (0,) * 10,
        # name, type, flags, VA, file offset, size, link, info, alignment, entsize
        (1, 1, 6, 0, PAYLOAD_OFFSET, len(payload), 0, 0, 4, 0),
        (7, 2, 0, 0, symbol_offset, len(symbols), 3, first_global, 4, SYMBOL.size),
        (15, 3, 0, 0, string_offset, len(strings), 0, 0, 1, 0),
        (23, 1, 0, 0, comment_offset, len(provenance), 0, 0, 1, 0),
        (32, 3, 0, 0, section_string_offset, len(section_names), 0, 0, 1, 0),
    ]
    for section in sections:
        image.extend(SECTION_HEADER.pack(*section))
    ident = b"\x7fELF\x01\x01\x01" + b"\0" * 9
    image[:ELF_HEADER.size] = ELF_HEADER.pack(
        ident, 2, 40, 1, entry, ELF_HEADER.size, section_offset, 0x05000000,
        ELF_HEADER.size, PROGRAM_HEADER.size, 1, SECTION_HEADER.size, len(sections), 5,
    )
    image[ELF_HEADER.size:ELF_HEADER.size + PROGRAM_HEADER.size] = PROGRAM_HEADER.pack(
        1, PAYLOAD_OFFSET, 0, 0, len(payload), len(payload), 5, PAYLOAD_OFFSET,
    )
    return bytes(image)


def verify_elf(image, payload, seeds=()):
    """Reparse the serialized file and verify its mapped bytes and explicit symbols."""
    header = ELF_HEADER.unpack_from(image)
    ident, kind, machine, version, entry, phoff, shoff, flags, ehsize, phsize, phnum, shsize, shnum, shstrndx = header
    if (ident[:7], kind, machine, version, ehsize, phsize, phnum, shsize, shnum, shstrndx) != (
        b"\x7fELF\x01\x01\x01", 2, 40, 1, 52, 32, 1, 40, 6, 5,
    ):
        raise ValueError("ELF header verification failed")
    expected_entry = struct.unpack_from("<I", payload, 4)[0]
    if entry != expected_entry or flags != 0x05000000:
        raise ValueError("ELF entry or ARM EABI flags changed")
    program = PROGRAM_HEADER.unpack_from(image, phoff)
    if program != (1, PAYLOAD_OFFSET, 0, 0, len(payload), len(payload), 5, PAYLOAD_OFFSET):
        raise ValueError("PT_LOAD verification failed")
    if image[program[1]:program[1] + program[4]] != payload:
        raise ValueError("PT_LOAD bytes differ from input")
    sections = [SECTION_HEADER.unpack_from(image, shoff + i * shsize) for i in range(shnum)]
    text = sections[1]
    if text[1:4] != (1, 6, 0) or image[text[4]:text[4] + text[5]] != payload:
        raise ValueError(".text bytes or mapping differ from input")
    for section in sections[2:]:
        if section[2] & 2 or section[4] < program[1] + program[4]:
            raise ValueError("metadata must remain outside the loadable segment")
    symtab, strtab = sections[2:4]
    strings = image[strtab[4]:strtab[4] + strtab[5]]
    actual_functions = []
    for offset in range(symtab[4], symtab[4] + symtab[5], SYMBOL.size):
        name, value, size, info, other, section = SYMBOL.unpack_from(image, offset)
        if info == 0x12:
            if size or other or section != 1:
                raise ValueError("function symbol metadata verification failed")
            actual_functions.append((value, strings[name:strings.index(0, name)].decode("ascii")))
    expected_functions = [(expected_entry, "Reset_Handler")] + [(address | 1, name) for address, name in seeds]
    if actual_functions != expected_functions:
        raise ValueError("Thumb function symbols differ from explicit seeds")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path, help="decoded Cortex-M binary (base VA zero)")
    parser.add_argument("--output", "-o", type=Path, help="default: decoded/rea/<input stem>.analysis.elf")
    parser.add_argument("--seed", action="append", type=parse_seed, default=[], metavar="HEX:NAME",
                        help="explicit Thumb function seed; repeat as needed")
    parser.add_argument("--vector-count", type=int, metavar="COUNT",
                        help="explicit vector-table length, including SP/reset; add unique valid Thumb targets")
    args = parser.parse_args()
    suffix = ".vectors.analysis.elf" if args.vector_count is not None else ".analysis.elf"
    output = args.output or Path(__file__).resolve().parents[1] / "decoded" / "rea" / f"{args.input.stem}{suffix}"
    manifest_path = output.with_name(output.name + ".manifest.json")
    try:
        for destination in (output, manifest_path):
            if args.input.resolve() == destination.resolve() or (
                destination.exists() and args.input.samefile(destination)
            ):
                raise ValueError("output must not overwrite the input")
        payload = args.input.read_bytes()
        vectors = vector_seeds(payload, args.vector_count, args.seed) if args.vector_count is not None else []
        seeds = args.seed + vectors
        image = make_elf(payload, seeds)
        verify_elf(image, payload, seeds)
        manifest = {
            "schema": "r7-analysis-elf-manifest-v1",
            "analysis_only": True,
            "input": {"path": str(args.input.resolve()), "bytes": len(payload),
                      "sha256": hashlib.sha256(payload).hexdigest()},
            "elf": {"path": str(output.resolve()), "bytes": len(image),
                    "sha256": hashlib.sha256(image).hexdigest(), "load_address": 0,
                    "entry": struct.unpack_from("<I", payload, 4)[0]},
            "explicit_seeds": [{"address": address, "name": name} for address, name in args.seed],
            "vector_count": args.vector_count,
            "vector_seeds": [{"address": address, "name": name} for address, name in vectors],
            "function_sizes": "unknown (zero-sized symbols)",
        }
        manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
        check_output(output, image)
        check_output(manifest_path, manifest_bytes)
        output.parent.mkdir(parents=True, exist_ok=True)
        write_new_or_identical(output, image)
        verify_elf(output.read_bytes(), payload, seeds)
        write_new_or_identical(manifest_path, manifest_bytes)
    except (OSError, ValueError, struct.error) as exc:
        parser.exit(1, f"error: {exc}\n")
    print(f"Analysis-only ELF (NOT flashable): {output}")
    print(f"Verified {len(payload):,} identical PT_LOAD/.text bytes at VA 0; entry {struct.unpack_from('<I', payload, 4)[0]:#x}")
    print(f"Input SHA-256: {hashlib.sha256(payload).hexdigest()}")
    print(f"Function symbols: reset + {len(args.seed)} explicit + {len(vectors)} vector-derived (all sizes zero)")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
