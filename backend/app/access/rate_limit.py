"""Brute-force protection for Access Code validation.

Counts *failed* attempts in a sliding window, per client and globally. This is
authentication protection only; it never limits how many dubbing jobs a valid
session may create.

State is in memory, which matches the single-instance deployment. A process restart
resets the counters (documented limitation).
"""

import threading
import time
from collections import deque
from collections.abc import Callable


class FailedAttemptLimiter:
    def __init__(
        self,
        *,
        max_per_client: int,
        max_global: int,
        window_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_per_client = max_per_client
        self._max_global = max_global
        self._window = window_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._per_client: dict[str, deque[float]] = {}
        self._global: deque[float] = deque()

    def retry_after(self, client: str) -> int | None:
        """Seconds until the client may try again, or None if not blocked."""
        with self._lock:
            now = self._clock()
            self._prune(now)
            waits: list[float] = []
            attempts = self._per_client.get(client)
            if attempts and len(attempts) >= self._max_per_client:
                waits.append(attempts[0] + self._window - now)
            if len(self._global) >= self._max_global:
                waits.append(self._global[0] + self._window - now)
            if not waits:
                return None
            return max(1, int(max(waits) + 0.999))

    def record_failure(self, client: str) -> None:
        with self._lock:
            now = self._clock()
            self._per_client.setdefault(client, deque()).append(now)
            self._global.append(now)

    def _prune(self, now: float) -> None:
        cutoff = now - self._window
        while self._global and self._global[0] <= cutoff:
            self._global.popleft()
        for key in list(self._per_client):
            attempts = self._per_client[key]
            while attempts and attempts[0] <= cutoff:
                attempts.popleft()
            if not attempts:
                del self._per_client[key]
