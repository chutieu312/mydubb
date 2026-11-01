"""Unit tests for the benchmark harness logic. No Docker, no database, no FFmpeg; every wait is
bounded (a few seconds). Run: python -I -m unittest discover -s benchmarks/infra/tests -v
(-I: add the parent directory through PYTHONPATH is not needed, the tests insert it themselves.)
"""

import io
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path

INFRA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INFRA))

from checks import validate_case, validate_run  # noqa: E402
from supervise import DiskGuard, supervise  # noqa: E402


def good_run(n=1, conc=1, **over):
    record = {
        "type": "run", "schema": 2, "run": n, "concurrency": conc,
        "status": ["completed"] * conc, "stop_reason": None, "timed_out": False,
        "disk_guard_aborted": False, "stuck_threads": False, "errors": [],
        "stray_processes": 0, "output_bytes": [1000] * conc,
        "mp3_samples": [{"decoded": 5, "target": 5}] * conc, "work_dirs_left": [],
        "oom_kill_events_delta": 0,
    }
    record.update(over)
    return record


def good_case(runs=2, conc=1):
    return [
        *[good_run(n, conc) for n in range(1, runs + 1)],
        {"type": "summary", "schema": 2, "ok": True, "expected_runs": runs},
        {"type": "container", "exit_code": 0, "oom_killed": False},
    ]


class SuperviseTests(unittest.TestCase):
    def test_disk_guard_stops_work_before_the_deadline_and_writes_stop(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            halt = threading.Event()

            def writer():  # writes 64 KiB every 5 ms until told to stop
                index = 0
                while not halt.is_set():
                    (root / f"f{index}").write_bytes(b"x" * 65536)
                    index += 1
                    time.sleep(0.005)

            thread = threading.Thread(target=writer, daemon=True)
            guard = DiskGuard([root], limit_bytes=1024 * 1024, period=0.02)
            guard.start()
            thread.start()
            outcome = supervise(
                [thread], timeout_s=20, tripped=guard.is_tripped, stop=halt.set, grace_s=3
            )
            guard.finish()
            self.assertEqual(outcome.reason, "disk_guard")
            self.assertFalse(outcome.stuck)
            self.assertLess(outcome.elapsed, 5, "must stop long before the 20 s deadline")
            size = sum(f.stat().st_size for f in root.iterdir())
            # periodic check: it may overshoot the 1 MiB limit, but only by a bounded amount
            self.assertLess(size, 8 * 1024 * 1024)
            time.sleep(0.3)  # nothing is written after the run was stopped
            self.assertEqual(size, sum(f.stat().st_size for f in root.iterdir()))
            self.assertFalse(thread.is_alive())

    def test_the_old_join_loop_did_not_stop_in_time(self):
        """Regression contrast: the first version joined each thread up to the deadline and only
        then looked at the guard, so a tripped guard changed nothing until the deadline."""
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            halt = threading.Event()

            def writer():
                index = 0
                while not halt.is_set():
                    (root / f"f{index}").write_bytes(b"x" * 65536)
                    index += 1
                    time.sleep(0.005)

            thread = threading.Thread(target=writer, daemon=True)
            guard = DiskGuard([root], limit_bytes=1024 * 1024, period=0.02)
            guard.start()
            thread.start()
            started = time.monotonic()
            deadline = started + 1.5
            thread.join(max(0.0, deadline - time.monotonic()))  # the old loop
            if guard.is_tripped():
                halt.set()
            elapsed = time.monotonic() - started
            guard.finish()
            halt.set()
            self.assertGreaterEqual(elapsed, 1.4, "old loop only reacted at the deadline")
            self.assertGreater(sum(f.stat().st_size for f in root.iterdir()), 4 * 1024 * 1024)

    def test_timeout_ends_a_cooperative_worker(self):
        halt = threading.Event()
        thread = threading.Thread(target=halt.wait, daemon=True)
        thread.start()
        outcome = supervise(
            [thread], timeout_s=0.3, tripped=lambda: False, stop=halt.set, grace_s=2
        )
        self.assertEqual(outcome.reason, "timeout")
        self.assertFalse(outcome.stuck)
        self.assertFalse(thread.is_alive())

    def test_stuck_worker_is_reported_after_the_grace_period(self):
        never = threading.Event()  # nobody sets it: a worker that ignores stop()
        thread = threading.Thread(target=never.wait, daemon=True)
        thread.start()
        started = time.monotonic()
        outcome = supervise(
            [thread], timeout_s=0.3, tripped=lambda: False, stop=lambda: None, grace_s=0.4
        )
        self.assertEqual(outcome.reason, "timeout")
        self.assertTrue(outcome.stuck)
        self.assertLess(time.monotonic() - started, 3)
        never.set()

    def test_finished_work_is_not_a_trip(self):
        thread = threading.Thread(target=lambda: None)
        thread.start()
        outcome = supervise([thread], timeout_s=5, tripped=lambda: False, stop=lambda: None)
        self.assertIsNone(outcome.reason)

    def test_a_failing_stop_callback_does_not_hide_the_trip(self):
        halt = threading.Event()
        thread = threading.Thread(target=halt.wait, daemon=True)
        thread.start()

        def broken():
            raise RuntimeError("boom")

        outcome = supervise([thread], timeout_s=0.2, tripped=lambda: False, stop=broken, grace_s=0.3)
        self.assertEqual(outcome.reason, "timeout")
        self.assertTrue(outcome.stuck)
        halt.set()


class ValidationTests(unittest.TestCase):
    def test_a_good_case_is_valid(self):
        self.assertEqual(validate_case(good_case(), 2, 1), [])
        self.assertEqual(validate_case(good_case(3, 2), 3, 2), [])

    def test_missing_sample_fields_are_not_equal(self):
        for item in ({"decoded": None, "target": None}, {}, {"decoded": 4, "target": 5},
                     {"decoded": True, "target": True}, {"decoded": "5", "target": "5"}):
            run = good_run(mp3_samples=[item])
            self.assertTrue(validate_run(run, 1), item)

    def test_each_failure_kind_is_detected(self):
        cases = {
            "job failed": good_run(status=["failed"]),
            "job missing": good_run(status=[]),
            "timeout": good_run(stop_reason="timeout", timed_out=True),
            "disk guard": good_run(stop_reason="disk_guard", disk_guard_aborted=True),
            "stuck": good_run(stuck_threads=True),
            "exception": good_run(errors=["RuntimeError"]),
            "no output": good_run(output_bytes=[]),
            "empty output": good_run(output_bytes=[0]),
            "leftover work dir": good_run(work_dirs_left=["bench-job"]),
            "stray ffmpeg": good_run(stray_processes=1),
            "oom": good_run(oom_kill_events_delta=1),
            "oom unknown": good_run(oom_kill_events_delta=None),
        }
        for label, run in cases.items():
            self.assertTrue(validate_run(run, 1), label)

    def test_case_level_failures(self):
        good = good_case()
        self.assertTrue(validate_case(good[1:], 2, 1), "a run is missing")
        self.assertTrue(validate_case([r for r in good if r["type"] != "summary"], 2, 1))
        self.assertTrue(validate_case([r for r in good if r["type"] != "container"], 2, 1))
        bad_container = [*good[:-1], {"type": "container", "exit_code": 137, "oom_killed": True}]
        self.assertTrue(validate_case(bad_container, 2, 1))
        not_ok = [*good[:2], {"type": "summary", "ok": False, "expected_runs": 2}, good[-1]]
        self.assertTrue(validate_case(not_ok, 2, 1))
        legacy = [{**good_run(), "schema": None}, *good[1:]]
        self.assertTrue(validate_case(legacy, 2, 1))
        self.assertTrue(validate_case([], 2, 1))


class SummarizeTests(unittest.TestCase):
    def run_summarize(self, files: dict[str, list[dict]]):
        with tempfile.TemporaryDirectory() as name:
            for filename, records in files.items():
                (Path(name) / filename).write_text("\n".join(json.dumps(r) for r in records) + "\n")
            proc = subprocess.run(
                [sys.executable, "-I", str(INFRA / "summarize.py"), name],
                capture_output=True, text=True, timeout=30,
            )
        return proc

    @staticmethod
    def with_metrics(records):
        out = []
        for r in records:
            if r["type"] == "run":
                r = {**r, "workload": "short", "mode": "plain", "audio_seconds": 59, "wall_s": 1.0,
                     "peak_rss_total_mb": 100.0, "peak_rss_ffmpeg_mb": 50.0, "peak_temp_disk_mb": 1.0,
                     "container_cpu_seconds": 1.0}
            out.append(r)
        return out

    def test_all_valid_exits_zero(self):
        proc = self.run_summarize({"audio-unlimited-short-plain-c1.jsonl": self.with_metrics(good_case())})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("FAILED", proc.stdout)

    def test_failed_case_is_shown_and_excluded_and_exit_is_nonzero(self):
        broken = self.with_metrics(good_case())
        broken[0] = {**broken[0], "status": ["failed"]}
        proc = self.run_summarize({
            "audio-unlimited-short-plain-c1.jsonl": self.with_metrics(good_case()),
            "audio-unlimited-short-timed-c1.jsonl": broken,
            "audio-unlimited-long-plain-c1.jsonl": [{"type": "container", "exit_code": 1}],
        })
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(proc.stdout.count("**FAILED**"), 2)
        self.assertIn("2 case(s) FAILED", proc.stdout)
        failed_lines = [line for line in proc.stdout.splitlines() if "FAILED**" in line]
        self.assertTrue(all(" | - | - | - |" in line for line in failed_lines), "no statistics for failures")


if __name__ == "__main__":
    unittest.main()
