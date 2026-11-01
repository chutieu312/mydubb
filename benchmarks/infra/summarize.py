"""Markdown tables from the audio-*.jsonl files of one results directory.

Usage: python -I summarize.py RESULTS_DIR
Run 1 of every case is the warm-up and is shown separately; median/min/max use runs 2..N.
"""

import json
import statistics
import sys
from pathlib import Path


def load(path: Path):
    runs, container = [], {}
    for line in path.read_text().splitlines():
        row = json.loads(line)
        if row.get("type") == "run":
            runs.append(row)
        elif row.get("type") == "container":
            container = row
    return runs, container


def spread(values, digits=1):
    if not values:
        return "-"
    return f"{statistics.median(values):.{digits}f} ({min(values):.{digits}f}-{max(values):.{digits}f})"


def main() -> None:
    directory = Path(sys.argv[1])
    print("| profile | workload | mode | c | audio s | runs ok/total | warm-up wall s | wall s median (min-max) "
          "| CPU-s per job | peak RSS python+ffmpeg MB | of which ffmpeg MB | peak temp disk MB | MP3 MB | state |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for path in sorted(directory.glob("audio-*.jsonl")):
        runs, container = load(path)
        if not runs:
            print(f"| {path.stem} | - | - | - | - | 0/0 | - | - | - | - | - | - | - | {container.get('state')} |")
            continue
        first = runs[0]
        rest = runs[1:] or runs
        ok = sum(1 for r in runs if all(s == "completed" for s in r["status"]) and all(r["mp3_matches_target_samples"]))
        conc = first["concurrency"]
        cpu = [r["container_cpu_seconds"] / conc for r in rest if r["container_cpu_seconds"] is not None]
        print(
            f"| {container.get('profile')} | {first['workload']} | {first['mode']} | {conc} | {first['audio_seconds']} "
            f"| {ok}/{len(runs)} | {first['wall_s']:.1f} | {spread([r['wall_s'] for r in rest])} "
            f"| {spread(cpu)} | {spread([r['peak_rss_total_mb'] for r in rest], 0)} "
            f"| {spread([r['peak_rss_ffmpeg_mb'] for r in rest], 0)} | {spread([r['peak_temp_disk_mb'] for r in rest], 0)} "
            f"| {statistics.median(b for r in rest for b in r['output_bytes']) / 1e6 if any(r['output_bytes'] for r in rest) else 0:.2f} "
            f"| {container.get('state')} |"
        )


main()
