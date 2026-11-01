"""Run supervision for the audio benchmark: deadline, disk guard, stopping stuck work.

No application imports, so it is unit-testable anywhere (tests/test_harness.py).

The disk guard is a PERIODIC check of the size of the benchmark's temp directories, not a
filesystem quota: work can exceed the limit by whatever is written during one polling period
(and by data FFmpeg has already buffered) before the run is stopped.
"""

import os
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path


def tree_size(root: Path) -> int:
    total = 0
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                pass
    return total


class DiskGuard(threading.Thread):
    """Polls the total size of `roots`; `is_tripped()` turns true once it exceeds `limit_bytes`."""

    def __init__(self, roots: Sequence[Path], limit_bytes: int, period: float = 0.2) -> None:
        super().__init__(daemon=True)
        self.roots, self.limit, self.period = list(roots), limit_bytes, period
        self.peak = 0
        self._tripped = threading.Event()
        self._finished = threading.Event()

    def run(self) -> None:
        while not self._finished.is_set():
            size = sum(tree_size(r) for r in self.roots)
            self.peak = max(self.peak, size)
            if size > self.limit:
                self._tripped.set()
            self._finished.wait(self.period)

    def is_tripped(self) -> bool:
        return self._tripped.is_set()

    def finish(self) -> None:
        self._finished.set()
        self.join(5)


@dataclass
class Outcome:
    reason: str | None  # None: every thread finished; else "timeout" or "disk_guard"
    stuck: bool  # a thread was still alive after the stop grace period
    elapsed: float


def supervise(
    threads: Sequence[threading.Thread],
    *,
    timeout_s: float,
    tripped: Callable[[], bool],
    stop: Callable[[], None],
    grace_s: float = 10.0,
    poll_s: float = 0.05,
    clock: Callable[[], float] = time.monotonic,
) -> Outcome:
    """Wait for `threads`, checking the guard and the deadline every `poll_s` while they run.

    On a trip `stop()` is called once (it must make the work end, e.g. kill FFmpeg), then the
    threads get `grace_s` to finish. `stuck` tells the caller that work is still running and the
    process must not carry on (see `hard_stop`).
    """
    started = clock()
    reason = None
    while any(t.is_alive() for t in threads):
        if tripped():
            reason = "disk_guard"
        elif clock() - started >= timeout_s:
            reason = "timeout"
        if reason:
            break
        _wait_one(threads, poll_s)
    if reason is None:
        return Outcome(None, False, clock() - started)
    try:
        stop()
    except Exception:  # noqa: BLE001 (the run is being abandoned; report, do not raise)
        pass
    grace_end = clock() + grace_s
    while any(t.is_alive() for t in threads) and clock() < grace_end:
        _wait_one(threads, poll_s)
    return Outcome(reason, any(t.is_alive() for t in threads), clock() - started)


def _wait_one(threads: Sequence[threading.Thread], seconds: float) -> None:
    for t in threads:
        if t.is_alive():
            t.join(seconds)
            return


def kill_by_name(names: Sequence[str]) -> int:
    """SIGKILL every process (Linux /proc) whose name is in `names`, except this one."""
    killed = 0
    if not os.path.isdir("/proc"):
        return 0
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) == os.getpid():
            continue
        try:
            with open(f"/proc/{entry}/comm") as handle:
                if handle.read().strip() in names:
                    os.kill(int(entry), 9)
                    killed += 1
        except OSError:
            continue
    return killed


def hard_stop(code: int) -> None:
    """Stuck work cannot be killed thread by thread: kill the tools and end the process now."""
    kill_by_name(("ffmpeg", "ffprobe"))
    os._exit(code)
