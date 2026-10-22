from app.access.rate_limit import FailedAttemptLimiter


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def make_limiter(clock: FakeClock, per_client: int = 3, global_max: int = 10):
    return FailedAttemptLimiter(
        max_per_client=per_client, max_global=global_max, window_seconds=60, clock=clock
    )


def test_client_is_blocked_after_max_failures_until_window_passes():
    clock = FakeClock()
    limiter = make_limiter(clock)
    for _ in range(3):
        assert limiter.retry_after("a") is None
        limiter.record_failure("a")
    assert limiter.retry_after("a") == 60
    assert limiter.retry_after("b") is None  # other clients unaffected

    clock.now += 61
    assert limiter.retry_after("a") is None


def test_global_limit_blocks_distributed_guessing():
    clock = FakeClock()
    limiter = make_limiter(clock, per_client=100, global_max=4)
    for i in range(4):
        limiter.record_failure(f"client-{i}")
    assert limiter.retry_after("fresh-client") is not None
