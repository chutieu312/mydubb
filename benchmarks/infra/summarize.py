"""Markdown tables from the audio-*.jsonl files of one results directory.

Usage: python -I summarize.py RESULTS_DIR      (exit 1 if any case is FAILED or incomplete)

Run 1 of every case is the warm-up and is shown separately; median/min/max use runs 2..N.
A case that is failed or incomplete (missing runs/jobs/outputs, a failed check, a non-clean
container, no harness summary) is listed as FAILED with its first reason and is NOT used in any
statistic. Results written by the first version of the harness (no "schema" field, a weaker
sample check) are shown as "legacy-v1" so they are never mistaken for validated results.
"""

import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from checks import load_records, validate_case  # noqa: E402


def spread(values, digits=1):
    if not values:
        return "-"
    return f"{statistics.median(values):.{digits}f} ({min(values):.{digits}f}-{max(values):.{digits}f})"


def legacy_problems(records, concurrency):
    """The checks that existed in schema 1: enough to refuse obviously broken old files."""
    runs = [r for r in records if r.get("type") == "run"]
    container = [r for r in records if r.get("type") == "container"]
    bad = []
    if not runs:
        bad.append("no runs recorded")
    if len(container) != 1 or container[0].get("state") != "false exit=0":
        bad.append(f"container record not clean: {container[0].get('state') if container else 'missing'}")
    for run in runs:
        if len(run.get("status", [])) != concurrency or any(s != "completed" for s in run["status"]):
            bad.append(f"run {run.get('run')}: jobs not completed")
        flags = run.get("mp3_matches_target_samples", [])
        if len(flags) != concurrency or not all(flag is True for flag in flags):
            bad.append(f"run {run.get('run')}: sample check missing or false")
        if run.get("timed_out") or run.get("disk_guard_aborted"):
            bad.append(f"run {run.get('run')}: stopped")
    return bad


def classify(path: Path):
    """(records, concurrency, 'ok' | 'legacy-v1' | 'FAILED', reasons)"""
    match = re.search(r"-c(\d+)\.jsonl$", path.name)
    concurrency = int(match.group(1)) if match else 1
    records = load_records(path)
    runs = [r for r in records if r.get("type") == "run"]
    if runs and all("schema" not in r for r in runs):
        reasons = legacy_problems(records, concurrency)
        return records, concurrency, ("FAILED" if reasons else "legacy-v1"), reasons
    summary = next((r for r in records if r.get("type") == "summary"), None)
    expected = summary.get("expected_runs") if summary else None
    if not isinstance(expected, int):
        return records, concurrency, "FAILED", ["no harness summary (crash, kill or timeout)"]
    reasons = validate_case(records, expected, concurrency)
    return records, concurrency, ("FAILED" if reasons else "ok"), reasons


def main() -> int:
    directory = Path(sys.argv[1])
    print(
        "| case | workload | mode | c | audio s | result | warm-up wall s | wall s median (min-max) "
        "| CPU-s per job | peak RSS python+ffmpeg MB | of which ffmpeg MB | peak temp disk MB | MP3 MB |"
    )
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    failed = 0
    for path in sorted(directory.glob("audio-*.jsonl")):
        records, conc, verdict, reasons = classify(path)
        name = path.stem.removeprefix("audio-")
        if verdict == "FAILED":
            failed += 1
            why = (reasons[0] if reasons else "").replace("|", "/")
            print(f"| {name} | - | - | {conc} | - | **FAILED**: {why} | - | - | - | - | - | - | - |")
            continue
        runs = [r for r in records if r.get("type") == "run"]
        first, rest = runs[0], runs[1:] or runs
        cpu = [r["container_cpu_seconds"] / conc for r in rest if r.get("container_cpu_seconds") is not None]
        sizes = [b for r in rest for b in r["output_bytes"]]
        mp3 = statistics.median(sizes) / 1e6 if sizes else 0
        print(
            f"| {name} | {first['workload']} | {first['mode']} | {conc} | {first['audio_seconds']} | {verdict} "
            f"| {first['wall_s']:.1f} | {spread([r['wall_s'] for r in rest])} | {spread(cpu)} "
            f"| {spread([r['peak_rss_total_mb'] for r in rest], 0)} "
            f"| {spread([r['peak_rss_ffmpeg_mb'] for r in rest], 0)} "
            f"| {spread([r['peak_temp_disk_mb'] for r in rest], 0)} | {mp3:.2f} |"
        )
    if failed:
        print(f"\n{failed} case(s) FAILED or incomplete; they are excluded from every statistic.")
    return 1 if failed else 0


sys.exit(main())
