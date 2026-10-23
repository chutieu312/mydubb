import threading

import pytest

from app.speech.rate_limit import WINDOW_MARGIN_SECONDS, RateLimiterClosed, RequestRateLimiter


class FakeTime:
    def __init__(self) -> None:
        self.now = 1000.0
        self.waits: list[float] = []

    def clock(self) -> float:
        return self.now

    def wait(self, seconds: float) -> bool:
        self.waits.append(seconds)
        self.now += seconds
        return False


def test_requests_within_the_limit_do_not_wait():
    fake = FakeTime()
    limiter = RequestRateLimiter(3, 60, clock=fake.clock, wait=fake.wait)
    for _ in range(3):
        limiter.acquire()
    assert fake.waits == []


def test_the_request_over_the_limit_waits_until_the_oldest_leaves_the_window():
    fake = FakeTime()
    limiter = RequestRateLimiter(2, 60, clock=fake.clock, wait=fake.wait)
    limiter.acquire()
    fake.now += 10
    limiter.acquire()
    limiter.acquire()  # third: must wait for the first (10 s ago) to age out
    assert fake.waits == [pytest.approx(60 + WINDOW_MARGIN_SECONDS - 10)]


def test_the_rate_never_exceeds_the_limit_in_any_window():
    fake = FakeTime()
    limiter = RequestRateLimiter(20, 60, clock=fake.clock, wait=fake.wait)
    starts = []
    for _ in range(100):
        limiter.acquire()
        starts.append(fake.now)
    for i, start in enumerate(starts):
        assert len([t for t in starts[i:] if t - start < 60]) <= 20


def test_one_limiter_shared_by_concurrent_jobs_is_not_exceeded():
    limiter = RequestRateLimiter(5, 60)
    granted = []

    def worker() -> None:
        try:
            limiter.acquire()
            granted.append(1)
        except RateLimiterClosed:
            pass

    threads = [threading.Thread(target=worker) for _ in range(12)]
    for thread in threads:
        thread.start()
    threading.Event().wait(0.3)
    assert len(granted) == 5  # the other seven are still waiting, not sent
    limiter.close()
    for thread in threads:
        thread.join(timeout=5)
    assert len(granted) == 5
    assert not any(thread.is_alive() for thread in threads)


def test_a_closed_limiter_refuses_and_wakes_waiters():
    limiter = RequestRateLimiter(1, 60)
    limiter.acquire()
    errors = []

    def waiter() -> None:
        try:
            limiter.acquire()
        except RateLimiterClosed as exc:
            errors.append(exc)

    thread = threading.Thread(target=waiter)
    thread.start()
    limiter.close()
    thread.join(timeout=5)
    assert len(errors) == 1
    with pytest.raises(RateLimiterClosed):
        limiter.acquire()


def test_invalid_settings_are_rejected():
    with pytest.raises(ValueError, match="positive"):
        RequestRateLimiter(0, 60)
    with pytest.raises(ValueError, match="positive"):
        RequestRateLimiter(1, 0)
