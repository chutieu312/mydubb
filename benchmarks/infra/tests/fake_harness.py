"""Stand-in for audio_bench.py in tests (BENCH_HARNESS=/bench/tests/fake_harness.py).

Takes the same arguments; FAKE_MODE chooses what it does. It makes no database or FFmpEG use, so a
case takes about a second. Modes:
  ok            valid schema 2 records, exit 0
  crash         exit 1, no output file
  noout         exit 0, no output file
  jobfail       a run whose job failed + summary ok=false, exit 1
  jobfail0      the same bad run but the harness claims ok and exits 0 (the wrapper must catch it)
  samples_none  exit 0, decoded and target sample counts both missing (None == None)
  samples_off   exit 0, decoded != target
  short_runs    exit 0, fewer runs than requested
  stuck         a worker that never ends: supervise() times out, hard_stop(3)
  crash_c2      like crash, but only for --concurrency 2 (matrix test)
"""

import argparse
import json
import os
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from supervise import hard_stop, supervise  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--workload")
parser.add_argument("--mode")
parser.add_argument("--concurrency", type=int, default=1)
parser.add_argument("--repeats", type=int, default=2)
parser.add_argument("--out", required=True)
args = parser.parse_args()
mode = os.environ.get("FAKE_MODE", "ok")


def run_record(n: int, **over) -> dict:
    conc = args.concurrency
    record = {
        "type": "run", "schema": 2, "run": n, "workload": args.workload, "mode": args.mode,
        "concurrency": conc, "audio_seconds": 59, "wall_s": 1.0,
        "status": ["completed"] * conc, "stop_reason": None, "timed_out": False,
        "disk_guard_aborted": False, "stuck_threads": False, "errors": [],
        "stray_processes": 0, "output_bytes": [1000] * conc,
        "mp3_samples": [{"decoded": 5, "target": 5}] * conc, "work_dirs_left": [],
        "oom_kill_events_delta": 0, "peak_rss_total_mb": 100.0, "peak_rss_ffmpeg_mb": 50.0,
        "peak_temp_disk_mb": 1.0, "container_cpu_seconds": 1.0,
    }
    record.update(over)
    return record


def write(*records: dict) -> None:
    with open(args.out, "a") as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")


def summary(ok: bool, done: int) -> dict:
    return {"type": "summary", "schema": 2, "ok": ok, "failures": [] if ok else ["x"],
            "expected_runs": args.repeats, "runs_done": done, "cleanup_ok": True}


if mode == "crash" or (mode == "crash_c2" and args.concurrency == 2):
    print("fake harness crashed on purpose (password=hunter2 postgresql://u:pw@db/x)", file=sys.stderr)
    sys.exit(1)
if mode == "noout":
    sys.exit(0)
if mode == "jobfail":
    write(run_record(1, status=["failed"] * args.concurrency), summary(False, 1))
    sys.exit(1)
if mode == "jobfail0":
    write(run_record(1, status=["failed"] * args.concurrency), summary(True, 1))
    sys.exit(0)
if mode in ("samples_none", "samples_off"):
    item = {"decoded": None, "target": None} if mode == "samples_none" else {"decoded": 4, "target": 5}
    runs = [run_record(n, mp3_samples=[item] * args.concurrency) for n in range(1, args.repeats + 1)]
    write(*runs, summary(True, args.repeats))
    sys.exit(0)
if mode == "short_runs":
    write(run_record(1), summary(True, 1))
    sys.exit(0)
if mode == "stuck":
    release = threading.Event()
    worker = threading.Thread(target=release.wait, daemon=True)  # never released
    worker.start()
    outcome = supervise([worker], timeout_s=0.5, tripped=lambda: False, stop=lambda: None, grace_s=0.5)
    write(run_record(1, stop_reason=outcome.reason, timed_out=True, stuck_threads=outcome.stuck),
          summary(False, 1))
    if outcome.stuck:
        hard_stop(3)
    sys.exit(1)
write(*[run_record(n) for n in range(1, args.repeats + 1)], summary(True, args.repeats))
sys.exit(0)
