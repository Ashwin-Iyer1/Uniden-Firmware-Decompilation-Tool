#!/usr/bin/env python3
"""Persistently analyze and export the three R7 v153.150.127 MCU images in Ghidra.

Requires locally supplied decoded/ui_nu.bin, dsp_nu.bin and gps_nu.bin plus an
installed Ghidra/JDK. Generated projects and proprietary derived output remain
under ignored decoded/ghidra/. No firmware is downloaded, modified or flashed.

    python3 tools/r7_decompile.py --ghidra-home /path/to/ghidra
    python3 tools/r7_decompile.py --sections gps_nu --reexport

The result is C-like decompiler pseudocode for every discovered function, not
original source or proof that all functions have been discovered.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import sys
import time

from r7_lzss import decompress

ROOT = Path(__file__).resolve().parents[1]
PROFILES = {
    "ui_nu": {"sha256": "16a8c58e25766909faaa114beb22d87e2dd5108c3a176a2587fccb901218d79f",
              "table": 0x2F78C, "data": (0x2F7AC, 0x20000000, 0x514, 0x488),
              "bss": (0x2F8D8, 0x20000514, 0x19E4, 0x14A0), "copy": "lzss", "sram": 0x20000},
    "dsp_nu": {"sha256": "feb85e6dfff8eb23c095beafc6d028c15e3da446c6954d0266e11c1ddcba2a9d",
               "table": 0x1BF44, "data": (0x1BF64, 0x20000000, 0x1D0, 0xD6A),
               "bss": (0x1BFE0, 0x200001D0, 0x3398, 0x193A), "copy": "lzss", "sram": 0x20000},
    "gps_nu": {"sha256": "a33c5ec9f01f1c91d4c4f9983b847c1f327134c8f8b4dd923610e03a5cffd607",
               "table": 0x9D7C, "data": (0x9D9C, 0x20000000, 0x110, 0x14C4),
               "bss": (0x9EAC, 0x20000110, 0x3C28, 0x14D2), "copy": "memcpy", "sram": 0x4000},
}


def headless_path(home):
    if home:
        candidate = Path(home).expanduser().resolve() / "support" / "analyzeHeadless"
        if candidate.is_file():
            return candidate
        raise SystemExit(f"Ghidra headless executable missing: {candidate}")
    found = shutil.which("analyzeHeadless")
    if found:
        return Path(found).resolve()
    raise SystemExit("Set GHIDRA_INSTALL_DIR or pass --ghidra-home (Ghidra installation directory).")


def prepare(section, input_dir, output):
    profile = PROFILES[section]
    binary = (input_dir / f"{section}.bin").resolve()
    data = binary.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != profile["sha256"]:
        raise SystemExit(f"{binary}: unrecognized SHA-256 {digest}; refusing version-specific seeds. "
                         "Relocate and verify descriptors/functions for this firmware before adding a profile.")
    for index, key in enumerate(("data", "bss")):
        actual = struct.unpack_from("<4I", data, profile["table"] + index * 16)
        if actual != profile[key]:
            raise SystemExit(f"{section}: unexpected {key} copy descriptor {actual!r}")
    source, destination, length, function = profile["data"]
    initialized = decompress(data, source, length) if profile["copy"] == "lzss" else data[source:source + length]
    if len(initialized) != length:
        raise SystemExit(f"{section}: .data reconstruction has wrong length")
    destination_dir = output / "prepared" / section
    destination_dir.mkdir(parents=True, exist_ok=True)
    data_path = destination_dir / "data_at_20000000.bin"
    data_path.write_bytes(initialized)
    metadata = {"section": section, "input": str(binary), "input_sha256": digest,
                "input_bytes": len(data), "profile": "R7_v153.150.127", "copy_table": hex(profile["table"]),
                "data_copy_descriptor": [hex(x) for x in profile["data"]],
                "bss_copy_descriptor": [hex(x) for x in profile["bss"]], "data_copy_kind": profile["copy"],
                "data_sha256": hashlib.sha256(initialized).hexdigest(), "data_file": str(data_path),
                "sram_model_bytes": profile["sram"],
                "sram_note": "Analysis address-space model, not a measured silicon capacity. .data/.bss are writable."}
    (destination_dir / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    return binary, data_path, metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ghidra-home", default=os.environ.get("GHIDRA_INSTALL_DIR"))
    parser.add_argument("--input-dir", type=Path, default=ROOT / "decoded")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "decoded" / "ghidra")
    parser.add_argument("--sections", nargs="+", choices=tuple(PROFILES), default=list(PROFILES))
    parser.add_argument("--function-timeout", type=int, default=30, help="Seconds per decompilation (default: 30)")
    parser.add_argument("--analysis-timeout", type=int, default=900, help="Seconds of Ghidra auto-analysis per image")
    parser.add_argument("--process-timeout", type=int, default=3600, help="Hard wall-clock limit per headless process")
    parser.add_argument("--reexport", action="store_true", help="Export existing saved analysis without rerunning analysis or seeds")
    parser.add_argument("--prepare-only", action="store_true", help="Validate images and reconstruct runtime .data without Ghidra")
    args = parser.parse_args()
    if args.reexport and args.prepare_only:
        parser.error("--reexport and --prepare-only are mutually exclusive")
    if min(args.function_timeout, args.analysis_timeout, args.process_timeout) < 1:
        parser.error("Timeouts must be positive")
    output = args.output_dir.expanduser().resolve()
    # This repository deliberately never tracks firmware-derived output.
    if not output.is_relative_to(ROOT / "decoded"):
        parser.error("--output-dir must remain under the repository's ignored decoded/ directory")
    output.mkdir(parents=True, exist_ok=True)
    scripts = ROOT / "tools" / "ghidra"
    headless = None if args.prepare_only else headless_path(args.ghidra_home)
    summaries = {}
    if not args.prepare_only:
        (output / "last_run_summary.json").unlink(missing_ok=True)
    for section in dict.fromkeys(args.sections):
        if args.prepare_only:
            prepare(section, args.input_dir, output)
            print(f"{section}: input hash and startup descriptors verified; .data reconstructed", flush=True)
            continue
        projects = output / "projects"
        projects.mkdir(exist_ok=True)
        export = output / "export" / section
        project_name = "R7_" + section
        exists = (projects / (project_name + ".gpr")).exists()
        if exists and not args.reexport:
            raise SystemExit(f"Project already exists: {project_name}. Use --reexport to preserve analysis or a fresh --output-dir.")
        if args.reexport and not exists:
            raise SystemExit(f"Cannot reexport missing project {project_name}")
        analysis_path = output / "provenance" / section / "analysis_run.json"
        analysis_path.parent.mkdir(parents=True, exist_ok=True)
        if args.reexport:
            # Earlier runner versions kept the original import record as run.json.
            # Migrate only an actual import record; never invent prior provenance.
            if not analysis_path.is_file():
                legacy = json.loads((export / "run.json").read_text())
                if "-import" not in legacy.get("command", []):
                    raise SystemExit(f"{section}: original import provenance unavailable; use a fresh output directory")
                analysis_path.write_text(json.dumps(legacy, indent=2) + "\n")
            metadata = json.loads(analysis_path.read_text())
            binary = Path(metadata["input"])
            actual_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
            if actual_hash != metadata["input_sha256"]:
                raise SystemExit(f"{section}: original input has changed since analysis")
            # Each export is a fresh snapshot. Archive prior files rather than
            # leaving stale names behind or discarding the analyst's old output.
            if export.exists():
                archive = output / "archive" / f"{section}_{time.time_ns()}"
                archive.parent.mkdir(parents=True, exist_ok=True)
                export.rename(archive)
            export.mkdir(parents=True)
            shutil.copyfile(analysis_path, export / "analysis_run.json")
            print(f"{section}: reexporting saved analysis; original import provenance preserved", flush=True)
        else:
            binary, data_path, metadata = prepare(section, args.input_dir, output)
            if export.exists() or analysis_path.exists():
                raise SystemExit(f"{section}: output already contains analysis artifacts; use a fresh --output-dir")
            export.mkdir(parents=True)
            print(f"{section}: input hash and startup descriptors verified; .data reconstructed", flush=True)
        command = [str(headless), str(projects), project_name, "-scriptPath", str(scripts)]
        if args.reexport:
            command += ["-process", binary.name, "-noanalysis"]
        else:
            command += ["-import", str(binary), "-loader", "BinaryLoader", "-loader-baseAddr", "0x0",
                        "-processor", "ARM:LE:32:Cortex", "-cspec", "default",
                        "-analysisTimeoutPerFile", str(args.analysis_timeout), "-preScript", "R7Seed.java",
                        section, str(data_path), str(export), str(PROFILES[section]["sram"]),
                        str(PROFILES[section]["bss"][2])]
        command += ["-postScript", "R7Export.java", str(export), str(args.function_timeout)]
        log = output / (section + (f"_reexport_{time.time_ns()}.log" if args.reexport else "_analysis.log"))
        run = {"section": section, "mode": "reexport" if args.reexport else "import",
               "input": str(binary), "input_sha256": metadata["input_sha256"],
               "original_analysis_provenance": str(analysis_path),
               "command": command, "log": str(log), "started_unix": time.time(),
               "script_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in scripts.glob("*.java")},
               "function_timeout_seconds": args.function_timeout, "process_timeout_seconds": args.process_timeout}
        if not args.reexport:
            run = {**metadata, **run}
        run_path = export / "run.json"
        run_path.write_text(json.dumps(run, indent=2) + "\n")
        summary_path = export / "summary.json"
        print(f"{section}: Ghidra running; log {log}", flush=True)
        try:
            with log.open("w") as handle:
                # analyzeHeadless launches shell/JVM/native-decompiler children;
                # terminate the full process group if the outer deadline expires.
                process = subprocess.Popen(command, stdout=handle, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                try:
                    returncode = process.wait(timeout=args.process_timeout)
                except BaseException:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                    raise
            run["returncode"] = returncode
        except subprocess.TimeoutExpired:
            run["error"] = "headless process exceeded hard wall-clock limit"
            raise SystemExit(f"{section}: headless timeout; inspect {log}")
        except BaseException as exception:
            run["error"] = f"headless interrupted: {type(exception).__name__}"
            raise
        finally:
            run["finished_unix"] = time.time()
            run_path.write_text(json.dumps(run, indent=2) + "\n")
            if not args.reexport:
                with analysis_path.open("x") as handle:
                    handle.write(json.dumps(run, indent=2) + "\n")
                shutil.copyfile(analysis_path, export / "analysis_run.json")
        if returncode or not summary_path.is_file():
            raise SystemExit(f"{section}: Ghidra did not finish export (exit {returncode}); inspect {log}")
        summary = json.loads(summary_path.read_text())
        manifest = json.loads((export / "functions.json").read_text())
        if manifest["flash_sha256"] != metadata["input_sha256"]:
            summary_path.unlink()
            raise SystemExit(f"{section}: saved program flash bytes differ from original input; export retained for review")
        if len(manifest["functions"]) != summary["discovered_functions"]:
            raise SystemExit(f"{section}: incomplete function manifest")
        for function in manifest["functions"]:
            for key in ("c_file", "assembly_file"):
                if not (export / function[key]).is_file():
                    raise SystemExit(f"{section}: missing export {function[key]}")
        summaries[section] = summary
        print(f"{section}: {summary['decompiled_successfully']}/{summary['discovered_functions']} discovered functions "
              f"decompiled; {summary['timeouts']} timeouts, {summary['failures']} failures, {summary['errors']} errors", flush=True)
    if summaries:
        (output / "last_run_summary.json").write_text(json.dumps(summaries, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
