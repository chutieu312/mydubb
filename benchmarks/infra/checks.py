"""Validation of benchmark records. Pure functions shared by the harness, check_case.py and
summarize.py. A case counts as valid only if every expected run, job and output is present and
every check passes; a missing field is a failure, never a pass."""

import json
from pathlib import Path


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_run(run: dict, concurrency: int) -> list[str]:
    """Reasons this run is not valid (empty list: valid)."""
    bad = []
    status = run.get("status")
    if not isinstance(status, list) or len(status) != concurrency:
        bad.append("status list missing or wrong length")
    elif any(s != "completed" for s in status):
        bad.append(f"job status not completed: {status}")
    for key in ("timed_out", "disk_guard_aborted", "stuck_threads"):
        if run.get(key) is not False:
            bad.append(f"{key} is {run.get(key)!r}")
    if run.get("stop_reason") is not None:
        bad.append(f"stopped: {run.get('stop_reason')}")
    if run.get("errors") != []:
        bad.append(f"errors: {run.get('errors')!r}")
    sizes = run.get("output_bytes")
    if (
        not isinstance(sizes, list)
        or len(sizes) != concurrency
        or not all(_is_int(s) and s > 0 for s in sizes)
    ):
        bad.append("output bytes missing, wrong count or empty")
    samples = run.get("mp3_samples")
    if not isinstance(samples, list) or len(samples) != concurrency:
        bad.append("mp3 sample report missing or wrong count")
    else:
        for item in samples:
            decoded = item.get("decoded") if isinstance(item, dict) else None
            target = item.get("target") if isinstance(item, dict) else None
            if not (_is_int(decoded) and _is_int(target) and decoded == target):
                bad.append(f"mp3 samples decoded={decoded!r} target={target!r}")
                break
    if run.get("work_dirs_left") != []:
        bad.append("work directories left behind")
    if run.get("stray_processes") != 0:
        bad.append(f"stray ffmpeg/ffprobe processes: {run.get('stray_processes')!r}")
    if run.get("oom_kill_events_delta") != 0:
        bad.append(f"oom kill events: {run.get('oom_kill_events_delta')!r}")
    return bad


def validate_case(records: list[dict], expected_runs: int, concurrency: int) -> list[str]:
    """Reasons the whole case (all records of one jsonl file) is not valid."""
    bad = []
    runs = [r for r in records if r.get("type") == "run"]
    summaries = [r for r in records if r.get("type") == "summary"]
    container = [r for r in records if r.get("type") == "container"]
    if len(runs) != expected_runs:
        bad.append(f"{len(runs)} of {expected_runs} runs recorded")
    for run in runs:
        if run.get("schema") != 2:
            bad.append(f"run {run.get('run')}: not a schema 2 record")
            continue
        bad += [f"run {run.get('run')}: {m}" for m in validate_run(run, concurrency)]
    if any(r.get("type") in ("error", "unreadable") for r in records):
        bad.append("harness recorded an exception or the file has an unreadable line")
    if len(summaries) != 1 or summaries[0].get("ok") is not True:
        bad.append("harness summary missing or not ok")
    if (
        len(container) != 1
        or container[0].get("exit_code") != 0
        or container[0].get("oom_killed") is not False
    ):
        bad.append(f"container record not clean: {container[0] if container else 'missing'}")
    return bad


def load_records(path: Path) -> list[dict]:
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            records.append(json.loads(line))
        except ValueError:
            records.append({"type": "unreadable"})
    return records
