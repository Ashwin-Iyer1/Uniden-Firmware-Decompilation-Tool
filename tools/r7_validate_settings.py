#!/usr/bin/env python3
"""Execute private R7 UI Thumb code to validate the researched settings patches.

This harness contains addresses and behavioral assertions, not vendor code. Supply
your own combined firmware, or a decoded ``ui_nu`` with ``--decoded-ui``. The
strict validator in r7_settings runs before any emulation. Unicorn is optional
for the editor and is required only for this command.

The two initializer routines execute with three declared external-call stubs.
Auto-mute checks execute the self-contained basic-block region [0x16a8e,
0x16b3c) of routine 0x16914: its input tick is already latched at timer+8, and
execution stops before the following unrelated alert logic. Volume selection
executes routine 0x196dc, recording its call to 0x19660 instead of driving audio.
These are bounded code checks, not whole-system, peripheral, or hardware tests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path
from typing import Any, Callable


RAM_BASE = 0x20000000
RAM_SIZE = 0x20000
STACK_TOP = RAM_BASE + 0x1F000
RETURN_ADDRESS = 0x100000
CONFIG = RAM_BASE + 0x8EC
MUTE_STATE = RAM_BASE + 0x188
TIMER = RAM_BASE + 0x514
ALERT_PRESENT = RAM_BASE + 0x35
SIGNAL_LEVEL = RAM_BASE + 0x3C
MASTER_VOLUME = RAM_BASE + 0x3B0
VOLUME_OVERRIDE = RAM_BASE + 0x3B4
MAX_INPUT_BYTES = 32 * 1024 * 1024

INITIALIZERS = {
    0x1CF48: (0x1D25C, {"theme": 0x1D05E, "volume": 0x1D0A6, "level": 0x1D21A}),
    0x1D29C: (0x1D618, {"theme": 0x1D458, "volume": 0x1D488, "level": 0x1D608}),
}
INIT_STUBS = {0x103EC, 0x18010, 0x9980}
PATCHED_CONFIG = {CONFIG + 0xB7, CONFIG + 0xCA, CONFIG + 0xC1}


class ValidationError(ValueError):
    """A runtime observation violated the declared harness contract."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def _unicorn() -> tuple[Any, Any]:
    try:
        import unicorn
        from unicorn import arm_const
    except ImportError as exc:
        raise ValidationError(
            "Unicorn is required for this optional harness; install it in your "
            "analysis environment with 'python3 -m pip install unicorn'."
        ) from exc
    return unicorn, arm_const


class Machine:
    """No peripheral mappings; code and SRAM are distinct and bounded."""

    def __init__(self, ui: bytes, *, fill: int = 0):
        unicorn, arm = _unicorn()
        self.unicorn, self.arm = unicorn, arm
        self.uc = unicorn.Uc(
            unicorn.UC_ARCH_ARM, unicorn.UC_MODE_THUMB | unicorn.UC_MODE_MCLASS
        )
        flash_size = (len(ui) + 0xFFF) & ~0xFFF
        _require(0 < flash_size < RETURN_ADDRESS, "UI image exceeds code mapping")
        self.uc.mem_map(0, flash_size, unicorn.UC_PROT_ALL)
        self.uc.mem_write(0, ui)
        self.uc.mem_protect(0, flash_size, unicorn.UC_PROT_READ | unicorn.UC_PROT_EXEC)
        self.uc.mem_map(RAM_BASE, RAM_SIZE, unicorn.UC_PROT_READ | unicorn.UC_PROT_WRITE)
        if fill:
            self.uc.mem_write(RAM_BASE, bytes([fill]) * RAM_SIZE)
        self.uc.mem_map(
            RETURN_ADDRESS, 0x1000, unicorn.UC_PROT_READ | unicorn.UC_PROT_EXEC
        )
        self.uc.reg_write(arm.UC_ARM_REG_SP, STACK_TOP)
        self.uc.reg_write(arm.UC_ARM_REG_LR, RETURN_ADDRESS | 1)
        self.writes: list[tuple[int, int, int]] = []
        self.calls: list[tuple[int, tuple[int, int, int, int]]] = []
        self.stopped = False

    def put(self, address: int, value: int, size: int = 1) -> None:
        self.uc.mem_write(address, value.to_bytes(size, "little"))

    def get(self, address: int, size: int = 1) -> int:
        return int.from_bytes(self.uc.mem_read(address, size), "little")

    def ram(self) -> bytes:
        return bytes(self.uc.mem_read(RAM_BASE, RAM_SIZE))

    def run(
        self,
        start: int,
        end: int,
        *,
        stop: int = RETURN_ADDRESS,
        stubs: dict[int, Callable[["Machine"], int | None]] | None = None,
    ) -> None:
        stubs = stubs or {}
        arm, unicorn = self.arm, self.unicorn

        def code_hook(uc: Any, address: int, size: int, _data: Any) -> None:
            if address == stop:
                self.stopped = True
                uc.emu_stop()
                return
            if address in stubs:
                args = tuple(
                    uc.reg_read(register)
                    for register in (
                        arm.UC_ARM_REG_R0, arm.UC_ARM_REG_R1,
                        arm.UC_ARM_REG_R2, arm.UC_ARM_REG_R3,
                    )
                )
                self.calls.append((address, args))
                result = stubs[address](self)
                if result is not None:
                    uc.reg_write(arm.UC_ARM_REG_R0, result)
                uc.reg_write(arm.UC_ARM_REG_PC, uc.reg_read(arm.UC_ARM_REG_LR))
                return
            _require(
                start <= address and address + size <= end,
                f"execution escaped declared code region at 0x{address:x}",
            )

        def write_hook(
            _uc: Any, _access: int, address: int, size: int, value: int, _data: Any
        ) -> None:
            _require(
                RAM_BASE <= address and address + size <= RAM_BASE + RAM_SIZE,
                f"write outside SRAM at 0x{address:x}",
            )
            self.writes.append((address, size, value & ((1 << (size * 8)) - 1)))

        code_handle = self.uc.hook_add(unicorn.UC_HOOK_CODE, code_hook)
        write_handle = self.uc.hook_add(unicorn.UC_HOOK_MEM_WRITE, write_hook)
        self.stopped = False
        try:
            self.uc.emu_start(start | 1, 0, timeout=1_000_000, count=10_000)
        except unicorn.UcError as exc:
            pc = self.uc.reg_read(arm.UC_ARM_REG_PC)
            raise ValidationError(f"emulator failed at 0x{pc:x}: {exc}") from exc
        finally:
            self.uc.hook_del(code_handle)
            self.uc.hook_del(write_handle)
        _require(self.stopped, "code did not reach its declared stop within the execution budget")


def _movw_value(ui: bytes, address: int) -> int:
    # Thumb MOVW's immediate is imm4:i:imm3:imm8. Opcode/register checking is
    # deliberately delegated to the strict, full-window settings validator.
    first, second = struct.unpack_from("<HH", ui, address)
    return ((first & 15) << 12) | (((first >> 10) & 1) << 11) | \
        (((second >> 12) & 7) << 8) | (second & 255)


def _initializer(ui: bytes, address: int, fill: int) -> Machine:
    end, sites = INITIALIZERS[address]
    machine = Machine(ui, fill=fill)
    machine.run(address, end, stubs={entry: lambda _machine: None for entry in INIT_STUBS})
    for field, offset in (("theme", 0xB7), ("volume", 0xCA), ("level", 0xC1)):
        _require(
            machine.get(CONFIG + offset) == ui[sites[field]],
            f"initializer 0x{address:x} stored the wrong {field}",
        )
    expected_calls = [0x103EC, 0x18010, 0x9980] if address == 0x1CF48 else [0x18010, 0x9980]
    _require([entry for entry, _args in machine.calls] == expected_calls, "unexpected initializer calls")
    _require(machine.calls[-1][1][0] == ui[sites["theme"]], "theme helper received the wrong selector")
    return machine


def _compare_initializers(reference: Machine, changed: Machine, label: str) -> None:
    def non_setting_writes(machine: Machine) -> list[tuple[int, int, int]]:
        result = []
        for address, size, value in machine.writes:
            touched = set(range(address, address + size))
            if touched & PATCHED_CONFIG:
                _require(size == 1 and address in PATCHED_CONFIG, "unexpected overlapping settings store")
            else:
                result.append((address, size, value))
        return result

    _require(
        non_setting_writes(reference) == non_setting_writes(changed),
        f"{label}: initializer changed an unrelated SRAM write",
    )
    before, after = reference.ram(), changed.ram()
    differences = {RAM_BASE + index for index, (a, b) in enumerate(zip(before, after)) if a != b}
    _require(differences <= PATCHED_CONFIG, f"{label}: initializer changed unrelated final SRAM")


def _mute_state(machine: Machine) -> tuple[int, int, int]:
    return machine.get(MUTE_STATE, 2), machine.get(MUTE_STATE + 2, 2), machine.get(MUTE_STATE + 4)


def _mute_machine(
    ui: bytes, *, elapsed: int = 0, gap: int = 10000, active: int = 0,
    threshold: int = 8, signal_level: int = 1,
) -> Machine:
    machine = Machine(ui)
    machine.put(CONFIG + 0xC1, threshold)
    machine.put(SIGNAL_LEVEL, signal_level)
    machine.put(MUTE_STATE, elapsed, 2)
    machine.put(MUTE_STATE + 2, gap, 2)
    machine.put(MUTE_STATE + 4, active)
    return machine


def _mute_step(machine: Machine, *, tick: int, alert: int, expected: tuple[int, int, int]) -> None:
    machine.put(TIMER + 8, tick, 2)
    machine.put(ALERT_PRESENT, alert)
    machine.run(0x16A8E, 0x16B3C, stop=0x16B3C)
    _require(_mute_state(machine) == expected, f"auto-mute state {_mute_state(machine)} != {expected}")
    _require(
        all(MUTE_STATE <= address and address + size <= MUTE_STATE + 5 for address, size, _ in machine.writes),
        "auto-mute region wrote outside its five-byte state",
    )
    _require(not machine.calls, "auto-mute block unexpectedly called another routine")


def _check_mute(ui: bytes, delay: int) -> dict[str, Any]:
    # Successive calls preserve state; each tick is the actual block's u16 input.
    machine = _mute_machine(ui)
    _mute_step(machine, tick=delay - 1, alert=1, expected=(delay - 1, 10000, 0))
    _mute_step(machine, tick=1, alert=1, expected=(delay, 0, 1))
    _mute_step(machine, tick=123, alert=1, expected=(delay, 0, 1))
    _mute_step(machine, tick=9999, alert=0, expected=(delay, 9999, 1))
    _mute_step(machine, tick=1, alert=1, expected=(delay, 0, 1))
    _mute_step(machine, tick=9999, alert=0, expected=(delay, 9999, 1))
    _mute_step(machine, tick=1, alert=0, expected=(0, 10000, 0))
    _mute_step(machine, tick=1, alert=1, expected=(1, 10000, 0))

    overshoot = _mute_machine(ui)
    _mute_step(overshoot, tick=delay + 1, alert=1, expected=(delay, 0, 1))
    disabled = _mute_machine(ui, elapsed=delay, gap=5, active=1, threshold=0)
    _mute_step(disabled, tick=1, alert=1, expected=(0, 10000, 0))
    excluded = _mute_machine(ui, elapsed=delay, gap=5, active=1, threshold=3, signal_level=4)
    _mute_step(excluded, tick=1, alert=1, expected=(0, 10000, 0))
    included = _mute_machine(ui, threshold=3, signal_level=3)
    _mute_step(included, tick=delay, alert=1, expected=(delay, 0, 1))
    idle = _mute_machine(ui, elapsed=40, gap=12)
    _mute_step(idle, tick=1, alert=0, expected=(0, 10000, 0))
    return {"delay_ms": delay, "state_transitions_checked": 13, "recovery_gap_ms": 10000}


def _check_volume(ui: bytes) -> int:
    count = 0
    marker = 0x13579BDF
    cases = [(master, muted, active, None) for master in range(8) for muted in range(8) for active in (0, 1)]
    cases.extend((5, 2, active, override) for active in (0, 1) for override in (0, 3, 7))
    for master, muted, active, override in cases:
        machine = Machine(ui)
        machine.put(MASTER_VOLUME, master)
        machine.put(CONFIG + 0xCA, muted)
        machine.put(MUTE_STATE + 4, active)
        machine.put(VOLUME_OVERRIDE, 0xFFFFFFFF if override is None else override, 4)
        for register, value in zip(
            (machine.arm.UC_ARM_REG_R0, machine.arm.UC_ARM_REG_R1, machine.arm.UC_ARM_REG_R2),
            (0x12, 0x34, 0x56),
        ):
            machine.uc.reg_write(register, value)
        machine.run(0x196DC, 0x19742, stubs={0x19660: lambda _machine: marker})
        expected = override if override is not None else min(master, muted) if active else master
        _require(machine.calls == [(0x19660, (0x12, 0x34, 0x56, expected))], "volume selector routed wrong arguments")
        _require(machine.uc.reg_read(machine.arm.UC_ARM_REG_R0) == marker, "volume selector lost audio helper return value")
        _require(
            all(STACK_TOP - 24 <= address and address + size <= STACK_TOP for address, size, _ in machine.writes),
            "volume selector unexpectedly changed non-stack SRAM",
        )
        count += 1
    return count


def validate_settings(ui: bytes, reference: bytes | None = None) -> dict[str, Any]:
    """Return a byte-free report; raise if any guard or runtime assertion fails.

    A supplied stock reference additionally establishes that the input's two
    initializer paths preserve every unrelated SRAM write and final SRAM byte.
    With no reference, generated patch variants are compared against the input.
    """
    from r7_settings import patch_ui, validate_ui

    validate_ui(ui)
    reference_supplied = reference is not None
    baseline = ui if reference is None else reference
    validate_ui(baseline)
    unicorn, _arm = _unicorn()
    init_results = []
    variants: list[tuple[str, bytes]] = [("input", ui)]
    for volume, theme, level in ((0, 0, 0), (4, 3, 4), (7, 7, 8)):
        changes = {"default_mute_volume": volume, "default_theme": theme, "default_mute_level": level}
        patched, _report = patch_ui(ui, changes)
        validate_ui(patched)
        variants.append((f"volume={volume},theme={theme},level={level}", patched))
    for fill in (0, 0xA5):
        for address, (_end, sites) in INITIALIZERS.items():
            stock_run = _initializer(baseline, address, fill)
            for label, patched in variants:
                run = _initializer(patched, address, fill)
                _compare_initializers(stock_run, run, f"{label}, initializer 0x{address:x}")
                init_results.append({
                    "variant": label, "entry": f"0x{address:x}", "initial_sram_fill": fill,
                    "theme": patched[sites["theme"]], "mute_volume": patched[sites["volume"]],
                    "mute_level": patched[sites["level"]], "write_events": len(run.writes),
                    "unrelated_writes_and_final_sram_match_reference": True,
                })

    delays = sorted({100, 3000, 30000, _movw_value(ui, 0x16AF2)})
    mute_results = []
    for delay in delays:
        patched, _report = patch_ui(ui, {"auto_mute_delay_ms": delay})
        validate_ui(patched)
        mute_results.append(_check_mute(patched, delay))
    volume_count = _check_volume(ui)
    return {
        "schema": "r7-settings-emulation-v1", "status": "passed",
        "ui_sha256": hashlib.sha256(ui).hexdigest(),
        "reference_ui_sha256": hashlib.sha256(baseline).hexdigest(),
        "reference_kind": "supplied" if reference_supplied else "input",
        "unicorn_version": unicorn.__version__,
        "initializers": init_results, "auto_mute": mute_results,
        "volume_routing_cases": volume_count,
        "boundaries": {
            "initializer_external_call_stubs": ["0x103ec", "0x18010", "0x9980"],
            "initializer_stub_behavior": "record arguments and return without side effects",
            "auto_mute_region": "0x16a8e inclusive to 0x16b3c exclusive, within 0x16914",
            "auto_mute_tick_input": "u16 at 0x2000051c, already latched by the enclosing routine",
            "auto_mute_inputs": "alert flag, current signal level, config+0xc1, and five-byte mute state",
            "volume_routine": "0x196dc through return at 0x1973e",
            "volume_stub": "0x19660 records r0-r3 and returns a fixed marker",
            "not_covered": [
                "whole-system boot or persistent settings", "peripherals and audio output",
                "alert classification or Laser exclusion outside the isolated region",
                "physical-device behavior or updater acceptance",
            ],
        },
    }


def _load(path: Path, decoded: bool) -> bytes:
    from r7_settings import read_ui, validate_ui

    with path.open("rb") as source:
        raw = source.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValidationError("input exceeds the 32 MiB harness limit")
    if decoded:
        ui = raw
    else:
        _section, ui = read_ui(raw)
    validate_ui(ui)
    return ui


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("firmware", type=Path, help="private firmware container (or decoded UI with --decoded-ui)")
    parser.add_argument("--decoded-ui", action="store_true", help="input is decoded ui_nu instead of a combined container")
    parser.add_argument("--reference", type=Path, help="private stock reference for unrelated-write comparisons")
    parser.add_argument("--reference-decoded-ui", action="store_true", help="the reference is decoded ui_nu")
    parser.add_argument("--report", type=Path, help="write a new derived JSON report; refuses existing paths")
    args = parser.parse_args(argv)
    if args.reference_decoded_ui and args.reference is None:
        parser.error("--reference-decoded-ui requires --reference")
    try:
        ui = _load(args.firmware, args.decoded_ui)
        reference = _load(args.reference, args.reference_decoded_ui) if args.reference else None
        report = validate_settings(ui, reference)
        if args.report:
            with args.report.open("x", encoding="utf-8") as output:
                json.dump(report, output, indent=2)
                output.write("\n")
        print(
            f"PASS: {len(report['initializers'])} initializer comparisons, "
            f"{sum(item['state_transitions_checked'] for item in report['auto_mute'])} "
            f"auto-mute state transitions, {report['volume_routing_cases']} volume routes."
        )
        print(f"Reference: {report['reference_kind']}; bounded emulation only, hardware untested.")
        if args.report:
            print(f"Report: {args.report}")
        return 0
    except (OSError, ValueError, ImportError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
