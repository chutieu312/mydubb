"""In-process job execution with bounded concurrency and a bounded queue.

Jobs run in a small worker-thread pool so blocking provider/FFmpeg work never runs on
the asyncio event loop. Admission is limited to `max_concurrency + max_queued` jobs;
beyond that, callers get ExecutorAtCapacity and the API reports the server as busy.

Limitation: execution state lives in this process only. One application instance must
own all jobs (see docs/ARCHITECTURE.md).
"""

import logging
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol

logger = logging.getLogger(__name__)


class ExecutorAtCapacity(Exception):
    pass


class JobSlot(Protocol):
    def start(self, work: Callable[[], None]) -> None: ...

    def cancel(self) -> None: ...


class JobExecutor(Protocol):
    def reserve(self) -> JobSlot:
        """Reserve capacity for one job or raise ExecutorAtCapacity."""
        ...

    def shutdown(self) -> None: ...


class _ThreadSlot:
    def __init__(self, executor: "BoundedThreadJobExecutor") -> None:
        self._executor = executor
        self._used = False

    def start(self, work: Callable[[], None]) -> None:
        self._mark_used()
        self._executor._run(work)

    def cancel(self) -> None:
        self._mark_used()
        self._executor._slots.release()

    def _mark_used(self) -> None:
        if self._used:
            raise RuntimeError("Job slot already used")
        self._used = True


class BoundedThreadJobExecutor:
    def __init__(self, *, max_concurrency: int, max_queued: int) -> None:
        self._pool = ThreadPoolExecutor(max_workers=max_concurrency, thread_name_prefix="job")
        self._slots = threading.BoundedSemaphore(max_concurrency + max_queued)

    def reserve(self) -> JobSlot:
        if not self._slots.acquire(blocking=False):
            raise ExecutorAtCapacity
        return _ThreadSlot(self)

    def shutdown(self) -> None:
        # Queued work is dropped; running threads finish their current stage. Startup
        # recovery marks any job left in an active state as failed.
        self._pool.shutdown(wait=False, cancel_futures=True)

    def _run(self, work: Callable[[], None]) -> None:
        def wrapped() -> None:
            try:
                work()
            except Exception:
                logger.exception("Job work raised unexpectedly")
            finally:
                self._slots.release()

        try:
            self._pool.submit(wrapped)
        except RuntimeError:
            # Pool already shut down.
            self._slots.release()
            raise
