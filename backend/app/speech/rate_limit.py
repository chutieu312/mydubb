"""Request-rate coordination for Azure Speech, shared by every job of the process.

The Free (F0) resource allows 20 transactions per 60 seconds (documented, not adjustable)
for the whole resource, so the limit is enforced across concurrent jobs rather than per job.
Callers block until a slot is free; `close()` wakes them for shutdown. The YouTube caption import
uses the same class for Supadata's per-plan request rate, with a deadline on the wait.
"""

import threading
import time
from collections import deque
from collections.abc import Callable

# Added to the window to absorb network delay between our clock and the service's count.
WINDOW_MARGIN_SECONDS = 1.0


class RateLimiterClosed(Exception):
    """The limiter was closed (application shutdown) while waiting for a slot."""


class RateLimiterDeadline(Exception):
    """No slot is free before the caller's deadline. Nothing was counted."""


class RequestRateLimiter:
    def __init__(
        self,
        max_requests: int,
        window_seconds: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        wait: Callable[[float], bool] | None = None,
    ) -> None:
        if max_requests < 1 or window_seconds <= 0:
            raise ValueError("max_requests and window_seconds must be positive")
        self._max = max_requests
        self._window = window_seconds + WINDOW_MARGIN_SECONDS
        self._clock = clock
        self._lock = threading.Lock()
        self._closed = threading.Event()
        # `wait(seconds)` sleeps and returns True if the limiter was closed meanwhile.
        self._wait = wait or self._closed.wait
        self._starts: deque[float] = deque()

    def acquire(self, *, deadline: float | None = None) -> None:
        """Block until one more request may start, then count it.

        With a `deadline` (on this limiter's clock), raise RateLimiterDeadline at once when the
        next free slot comes later than that, instead of waiting for it.
        """
        while True:
            with self._lock:
                if self._closed.is_set():
                    raise RateLimiterClosed
                now = self._clock()
                while self._starts and now - self._starts[0] >= self._window:
                    self._starts.popleft()
                if len(self._starts) < self._max:
                    self._starts.append(now)
                    return
                delay = self._window - (now - self._starts[0])
                if deadline is not None and now + delay > deadline:
                    raise RateLimiterDeadline
            if self._wait(delay):
                raise RateLimiterClosed

    def close(self) -> None:
        self._closed.set()
