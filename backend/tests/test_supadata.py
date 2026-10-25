"""Supadata caption provider against a fake HTTP transport (no network, no credentials)."""

import json
import logging
import threading
from collections.abc import Callable

import httpx
import pytest
from pydantic import SecretStr

from app.speech.rate_limit import RequestRateLimiter
from app.youtube_import.base import ImportFailure
from app.youtube_import.supadata import MAX_RESPONSE_BYTES, SupadataCaptionProvider
from app.youtube_import.youtube_url import YouTubeVideo

KEY = "supadata-test-key-0123456789"
VIDEO = YouTubeVideo("dQw4w9WgXcQ")
JOB_ID = "123e4567-e89b-12d3-a456-426614174000"
CAPTIONS = [
    {"text": "Welcome back.", "offset": 480, "duration": 2000, "lang": "en"},
    {"text": "Gradient descent, step by step.", "offset": 2960, "duration": 1500, "lang": "en"},
    {"text": "Bye!", "offset": 3_723_004, "duration": 900, "lang": "en"},
]
TRANSCRIPT = {"content": CAPTIONS, "lang": "en", "availableLangs": ["en", "vi"]}


def ok(body: object = TRANSCRIPT, status: int = 200, **headers: str) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


def error(status: int, code: str, details: str = "Something happened.") -> httpx.Response:
    body = {"error": code, "message": "Message", "details": details}
    return httpx.Response(status, json=body)


class Fake:
    """Answers the initial request, then each status poll, in order."""

    def __init__(self, initial: httpx.Response, polls: list[httpx.Response] | None = None):
        self.initial = initial
        self.polls = list(polls or [])
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/v1/transcript":
            return self.initial
        assert request.url.path == f"/v1/transcript/{JOB_ID}"
        if len(self.polls) > 1:
            return self.polls.pop(0)
        return self.polls[0]  # the last answer repeats

    @property
    def initial_requests(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path == "/v1/transcript"]


class CountingLimiter(RequestRateLimiter):
    def __init__(self) -> None:
        super().__init__(1000, 1)
        self.acquired = 0

    def acquire(self, *, deadline: float | None = None) -> None:
        super().acquire(deadline=deadline)
        self.acquired += 1


def provider(
    handler: Callable[[httpx.Request], httpx.Response] | httpx.MockTransport,
    *,
    limiter: RequestRateLimiter | None = None,
    deadline: float = 5,
    poll: float = 0.01,
    timeout: float = 5,
) -> SupadataCaptionProvider:
    transport = (
        handler if isinstance(handler, httpx.MockTransport) else httpx.MockTransport(handler)
    )
    return SupadataCaptionProvider(
        key=SecretStr(KEY),
        limiter=limiter or RequestRateLimiter(1000, 1),
        timeout_seconds=timeout,
        deadline_seconds=deadline,
        poll_interval_seconds=poll,
        transport=transport,
    )


def failure_code(fake: Callable[[httpx.Request], httpx.Response], **kwargs) -> str:
    with pytest.raises(ImportFailure) as raised:
        provider(fake, **kwargs).english_captions(VIDEO)
    return raised.value.code


# --- the request ----------------------------------------------------------------------------------


def test_the_request_asks_for_existing_english_captions_with_times():
    fake = Fake(ok())
    provider(fake).english_captions(VIDEO)
    (request,) = fake.requests
    assert request.method == "GET"
    assert (request.url.scheme, request.url.host, request.url.path) == (
        "https",
        "api.supadata.ai",
        "/v1/transcript",
    )
    assert dict(request.url.params) == {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "lang": "en",
        "text": "false",
        "mode": "native",
    }
    # No regrouping by the provider, and never AI generation.
    assert "chunkSize" not in request.url.params
    assert request.headers["x-api-key"] == KEY
    assert request.headers["accept"] == "application/json"


def test_an_immediate_answer_becomes_the_caption_track():
    track, stats = provider(Fake(ok(**{"x-billable-requests": "1"}))).fetch(VIDEO)
    assert [c.text for c in track.captions] == [c["text"] for c in CAPTIONS]
    assert [c.start_ms for c in track.captions] == [480, 2960, 3_723_004]
    assert track.transcript.splitlines()[0::2] == ["0:00.480", "0:02.960", "1:02:03.004"]
    assert (stats.requests, stats.polls, stats.billed_credits) == (1, 0, 1)


@pytest.mark.parametrize("language", ["en", "EN", "en-US", "en-GB", "en_US"])
def test_english_variants_are_english(language):
    body = {**TRANSCRIPT, "lang": language}
    assert provider(Fake(ok(body))).english_captions(VIDEO).language == language


def test_captions_without_a_chunk_language_are_accepted():
    body = {**TRANSCRIPT, "content": [{"text": "hi", "offset": 0, "duration": 1}]}
    assert provider(Fake(ok(body))).english_captions(VIDEO).captions[0].text == "hi"


# --- language -------------------------------------------------------------------------------------


@pytest.mark.parametrize("language", ["vi", "es", "eng", "fr-CA", "", "zh-TW"])
def test_another_language_is_never_taken_for_english(language):
    # Supadata returns the first available language when English is missing.
    body = {**TRANSCRIPT, "lang": language}
    assert failure_code(Fake(ok(body))) == "youtube_import_no_english_captions"


def test_one_caption_in_another_language_refuses_the_track():
    content = [*CAPTIONS[:2], {**CAPTIONS[2], "lang": "es"}]
    assert failure_code(Fake(ok({**TRANSCRIPT, "content": content}))) == (
        "youtube_import_no_english_captions"
    )


def test_no_transcript_at_all_is_no_english_captions():
    fake = Fake(error(206, "transcript-unavailable"))
    assert failure_code(fake) == "youtube_import_no_english_captions"
    assert len(fake.requests) == 1


# --- asynchronous jobs ----------------------------------------------------------------------------


def test_a_job_is_polled_until_completed_without_sending_the_request_again():
    limiter = CountingLimiter()
    fake = Fake(
        ok({"jobId": JOB_ID}, status=202, **{"x-billable-requests": "1"}),
        [
            ok({"status": "queued"}),
            ok({"status": "active"}),
            ok({"status": "completed", **TRANSCRIPT}),
        ],
    )
    track, stats = provider(fake, limiter=limiter).fetch(VIDEO)
    assert [c.text for c in track.captions] == [c["text"] for c in CAPTIONS]
    assert len(fake.initial_requests) == 1
    assert (stats.requests, stats.polls) == (4, 3)
    # Every request, polls included, went through the shared limiter.
    assert limiter.acquired == 4
    for poll in fake.requests[1:]:
        assert poll.method == "GET"
        assert poll.headers["x-api-key"] == KEY
        assert not poll.url.params


def test_a_job_that_never_finishes_stops_at_the_deadline():
    fake = Fake(ok({"jobId": JOB_ID}, status=202), [ok({"status": "active"})])
    assert failure_code(fake, deadline=0.3, poll=0.02) == "youtube_import_timeout"
    assert len(fake.initial_requests) == 1
    assert len(fake.requests) > 2


@pytest.mark.parametrize(
    ("job_error", "code"),
    [
        ({"error": "transcript-unavailable"}, "youtube_import_no_english_captions"),
        ({"error": "not-found"}, "youtube_import_video_unavailable"),
        ({"error": "forbidden"}, "youtube_import_video_unavailable"),
        ({"error": "unauthorized"}, "youtube_import_auth_failed"),
        ({"error": "upgrade-required"}, "youtube_import_rejected"),
        (
            {"error": "limit-exceeded", "details": "Plan usage limit was exceeded."},
            "youtube_import_quota_exceeded",
        ),
        ({"error": "limit-exceeded", "details": "Rate limit"}, "youtube_import_rate_limited"),
        ({"error": "internal-error"}, "youtube_import_service_error"),
        ({"error": ["unhashable"]}, "youtube_import_service_error"),
        (None, "youtube_import_service_error"),
        ("text", "youtube_import_service_error"),
    ],
)
def test_a_failed_job_is_reported_by_its_error_code(job_error, code):
    fake = Fake(ok({"jobId": JOB_ID}, status=202), [ok({"status": "failed", "error": job_error})])
    assert failure_code(fake) == code


@pytest.mark.parametrize(
    "body", [{}, {"jobId": ""}, {"jobId": 123}, {"jobId": "../../me"}, {"jobId": "a" * 129}, []]
)
def test_a_missing_or_unsafe_job_id_is_an_invalid_answer(body):
    fake = Fake(ok(body, status=202))
    assert failure_code(fake) == "youtube_import_invalid_response"
    assert len(fake.requests) == 1


def test_a_completed_job_without_captions_is_not_a_transcript():
    for result in ({"status": "completed"}, {"status": "completed", "content": CAPTIONS}):
        fake = Fake(ok({"jobId": JOB_ID}, status=202), [ok(result)])
        assert failure_code(fake) == "youtube_import_invalid_response"


def test_an_unknown_job_status_is_an_invalid_answer():
    fake = Fake(ok({"jobId": JOB_ID}, status=202), [ok({"status": "paused"})])
    assert failure_code(fake) == "youtube_import_invalid_response"


def test_a_rate_limited_poll_is_polled_again_but_a_used_up_quota_stops():
    fake = Fake(
        ok({"jobId": JOB_ID}, status=202),
        [
            error(429, "limit-exceeded", "Request rate limit on current plan was exceeded."),
            ok({"status": "completed", **TRANSCRIPT}),
        ],
    )
    assert len(provider(fake).english_captions(VIDEO).captions) == 3
    assert len(fake.initial_requests) == 1
    fake = Fake(
        ok({"jobId": JOB_ID}, status=202),
        [error(429, "limit-exceeded", "Plan usage limit was exceeded.")],
    )
    assert failure_code(fake) == "youtube_import_quota_exceeded"


@pytest.mark.parametrize("status", [404, 500, 401, 302])
def test_a_failing_poll_stops_the_import(status):
    fake = Fake(ok({"jobId": JOB_ID}, status=202), [error(status, "not-found")])
    code = failure_code(fake)
    assert code == (
        "youtube_import_auth_failed" if status == 401 else "youtube_import_service_error"
    )
    assert len(fake.initial_requests) == 1


def test_closing_the_provider_stops_a_waiting_import():
    fake = Fake(ok({"jobId": JOB_ID}, status=202), [ok({"status": "active"})])
    instance = provider(fake, deadline=30, poll=0.05)
    outcome: list[str] = []

    def run() -> None:
        try:
            instance.english_captions(VIDEO)
        except ImportFailure as exc:
            outcome.append(exc.code)

    thread = threading.Thread(target=run)
    thread.start()
    threading.Event().wait(0.2)
    instance.close()
    thread.join(timeout=5)
    assert outcome == ["youtube_import_cancelled"]


# --- rate limit and deadline ----------------------------------------------------------------------


def test_no_request_is_sent_when_no_slot_is_free_before_the_deadline():
    limiter = RequestRateLimiter(1, 60)
    limiter.acquire()  # another import used the only slot of the window
    fake = Fake(ok())
    assert failure_code(fake, limiter=limiter, deadline=10) == "youtube_import_timeout"
    assert fake.requests == []


def test_imports_share_the_limiter_so_the_rate_is_never_exceeded():
    # 1 request per second (+1 s margin): a second import must wait for the next window.
    limiter = RequestRateLimiter(1, 1)
    first, second = Fake(ok()), Fake(ok())
    provider(first, limiter=limiter).english_captions(VIDEO)
    assert failure_code(second, limiter=limiter, deadline=1) == "youtube_import_timeout"
    assert second.requests == []


# --- status codes ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (error(400, "invalid-request"), "youtube_import_rejected"),
        (error(401, "unauthorized"), "youtube_import_auth_failed"),
        (error(402, "upgrade-required"), "youtube_import_rejected"),
        (error(403, "forbidden"), "youtube_import_video_unavailable"),
        (error(404, "not-found"), "youtube_import_video_unavailable"),
        (
            error(429, "limit-exceeded", "Request rate limit on current plan was exceeded."),
            "youtube_import_rate_limited",
        ),
        (
            error(429, "limit-exceeded", "Global request rate limit was exceeded."),
            "youtube_import_rate_limited",
        ),
        (
            error(429, "limit-exceeded", "Plan usage limit was exceeded."),
            "youtube_import_quota_exceeded",
        ),
        (httpx.Response(429, text="Too Many Requests"), "youtube_import_rate_limited"),
        (error(500, "internal-error"), "youtube_import_service_error"),
        (httpx.Response(503, text="<html>down</html>"), "youtube_import_service_error"),
        (
            httpx.Response(302, headers={"Location": "https://evil.example/"}),
            "youtube_import_service_error",
        ),
        (httpx.Response(204), "youtube_import_service_error"),
    ],
)
def test_status_codes_map_to_safe_errors_and_nothing_is_retried(response, code):
    fake = Fake(response)
    assert failure_code(fake) == code
    # Never re-sent (each request may cost a credit), and a redirect is not followed.
    assert len(fake.requests) == 1


def test_a_provider_401_or_403_is_never_reported_as_unauthenticated():
    for status in (401, 403):
        with pytest.raises(ImportFailure) as raised:
            provider(Fake(error(status, "unauthorized"))).english_captions(VIDEO)
        assert raised.value.status_code not in (401, 403)


def test_a_timeout_is_reported_and_not_retried():
    calls = []

    def slow(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        raise httpx.ReadTimeout("timed out", request=request)

    assert failure_code(slow) == "youtube_import_timeout"
    assert len(calls) == 1


def test_a_network_error_is_reported_and_not_retried():
    calls = []

    def broken(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        raise httpx.ConnectError("refused", request=request)

    assert failure_code(broken) == "youtube_import_service_error"
    assert len(calls) == 1


# --- invalid or partial answers -------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b'"text"',
        json.dumps({"lang": "en", "availableLangs": ["en"]}).encode(),
        json.dumps({**TRANSCRIPT, "content": "Plain text transcript"}).encode(),
        json.dumps({**TRANSCRIPT, "content": {"0": CAPTIONS[0]}}).encode(),
        json.dumps({"content": CAPTIONS, "availableLangs": ["en"]}).encode(),
        json.dumps({**TRANSCRIPT, "lang": ["en"]}).encode(),
        json.dumps({**TRANSCRIPT, "availableLangs": "en"}).encode(),
        json.dumps({**TRANSCRIPT, "content": [*CAPTIONS, "caption"]}).encode(),
        json.dumps({**TRANSCRIPT, "content": [{"text": "a", "offset": 1}]}).encode(),
        json.dumps({**TRANSCRIPT, "content": [{"offset": 1, "duration": 1}]}).encode(),
        json.dumps({**TRANSCRIPT, "content": [{**CAPTIONS[0], "lang": 7}]}).encode(),
        json.dumps({**TRANSCRIPT, "content": [{**CAPTIONS[0], "offset": True}]}).encode(),
        json.dumps({**TRANSCRIPT, "content": [{**CAPTIONS[0], "offset": "480"}]}).encode(),
        json.dumps({**TRANSCRIPT, "content": [{**CAPTIONS[0], "duration": -1}]}).encode(),
        json.dumps({**TRANSCRIPT, "content": [{**CAPTIONS[0], "text": None}]}).encode(),
        b'{"content": [{"text": "a", "offset": NaN, "duration": 1}], "lang": "en"}',
        b'{"content": [{"text": "a", "offset": Infinity, "duration": 1}], "lang": "en"}',
        # Out of order: refused, never sorted.
        json.dumps({**TRANSCRIPT, "content": [CAPTIONS[1], CAPTIONS[0]]}).encode(),
    ],
)
def test_malformed_answers_import_nothing(body):
    fake = Fake(httpx.Response(200, content=body))
    assert failure_code(fake) == "youtube_import_invalid_response"


def test_no_captions_or_only_empty_ones_import_nothing():
    for content in ([], [{"text": "  ", "offset": 0, "duration": 1}]):
        fake = Fake(ok({**TRANSCRIPT, "content": content}))
        assert failure_code(fake) == "youtube_import_empty_captions"


def test_an_oversized_answer_is_refused():
    big = b'{"content": [' + b" " * (MAX_RESPONSE_BYTES + 1) + b"]}"
    fake = Fake(httpx.Response(200, content=big))
    assert failure_code(fake) == "youtube_import_too_large"


def test_equal_offsets_and_milliseconds_survive_the_provider_answer():
    content = [
        {"text": "a", "offset": 1001, "duration": 10},
        {"text": "b", "offset": 1001, "duration": 10},
        {"text": "c", "offset": 59_999, "duration": 10},
    ]
    track = provider(Fake(ok({**TRANSCRIPT, "content": content}))).english_captions(VIDEO)
    assert track.transcript == "0:01.001\na\n0:01.001\nb\n0:59.999\nc"


# --- logging --------------------------------------------------------------------------------------


def test_logs_hold_no_key_video_link_or_caption_text(caplog):
    caplog.set_level(logging.DEBUG)
    provider(Fake(ok())).english_captions(VIDEO)
    for fake in (Fake(error(401, "unauthorized", KEY)), Fake(ok({**TRANSCRIPT, "lang": "es"}))):
        with pytest.raises(ImportFailure):
            provider(fake).english_captions(VIDEO)
    text = caplog.text
    assert "Supadata import ok" in text
    for secret in (KEY, VIDEO.video_id, "Welcome back", "Gradient descent", "youtube.com"):
        assert secret not in text
