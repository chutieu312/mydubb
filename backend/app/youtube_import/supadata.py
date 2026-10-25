"""Supadata transcript API: the existing English captions of one YouTube video.

Checked against the official documentation (docs.supadata.ai, the v1 OpenAPI document, "Get
transcript", "Transcript result", error pages) and supadata.ai/pricing on 2026-10-25:

* `GET https://api.supadata.ai/v1/transcript?url=...&lang=en&text=false&mode=native` with the key
  in `x-api-key`. `mode=native` only fetches a transcript the video already has (`auto` falls back
  to AI generation and `generate` always generates; neither is used). `text=false` returns timed
  chunks; `chunkSize` is not sent, so captions are not regrouped by the provider.
* 200: `{"content": [{"text", "offset", "duration", "lang"?}], "lang", "availableLangs"}`,
  `offset` and `duration` in **milliseconds**. If English is unavailable the API returns the
  first available language instead, so the returned `lang` is checked, never assumed.
* 202: `{"jobId"}`; poll `GET /v1/transcript/{jobId}` (1 second recommended) for
  `{"status": "queued" | "active" | "completed" | "failed", "content"?, "lang"?, "error"?}`. Job
  results expire one hour after completion (404 afterwards).
* 206 transcript-unavailable; 400 invalid-request; 401 unauthorized (key); 402 upgrade-required;
  403 forbidden (private or restricted content); 404 not-found; 429 limit-exceeded, whose
  `details` tells a rate limit from a used-up monthly quota; 5xx.
* Credits: 1 per native transcript request, also when it ends in 206; status polls are free.
  The Free plan has 100 credits a month and 1 request per second, and the rate limit counts every
  endpoint, polls included, so all requests of the process share one limiter.

The initial request is never repeated: each one can cost a credit, and the outcome of a timed-out
one is unknown. Only status polls are sent again, at the poll interval, until the job finishes or
the import's deadline passes. Redirects are not followed, the body is read within a size and time
limit, and the URL sent is the canonical one built from the video ID (`youtube_url.py`), never the
user's text. Logs hold status codes, the provider's error code, counts, latency and billed
credits; never the key, the video, the response body or caption text.
"""

import json
import logging
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

import httpx
from pydantic import SecretStr

from app.speech.rate_limit import RateLimiterClosed, RateLimiterDeadline, RequestRateLimiter
from app.youtube_import.base import ImportFailure
from app.youtube_import.captions import CaptionError, CaptionTrack, RawCaption, build_track
from app.youtube_import.youtube_url import YouTubeVideo

logger = logging.getLogger(__name__)

TRANSCRIPT_URL = "https://api.supadata.ai/v1/transcript"
LANGUAGE = "en"
# A ten-hour video has some tens of thousands of captions, a few megabytes of JSON.
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
USER_AGENT = "MyDubb"

_JOB_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_PENDING = frozenset({"queued", "active"})
_ERROR_CODES = frozenset(
    {
        "invalid-request",
        "internal-error",
        "forbidden",
        "unauthorized",
        "upgrade-required",
        "transcript-unavailable",
        "not-found",
        "limit-exceeded",
        "upstream-error",
    }
)
# `details` of a 429 when the monthly credits are used up (errors/limit-exceeded).
_QUOTA_DETAILS = "plan usage limit"


@dataclass(frozen=True)
class ImportStats:
    requests: int  # sent to Supadata, polls included
    polls: int
    # The x-billable-requests header of the initial answer (a precharge estimate for a 202).
    billed_credits: int | None
    latency_seconds: float


def is_english(code: object) -> bool:
    if not isinstance(code, str):
        return False
    code = code.strip().lower()
    return code == LANGUAGE or code.startswith((f"{LANGUAGE}-", f"{LANGUAGE}_"))


class SupadataCaptionProvider:
    name = "supadata"

    def __init__(
        self,
        *,
        key: SecretStr,
        limiter: RequestRateLimiter,
        timeout_seconds: float,
        deadline_seconds: float,
        poll_interval_seconds: float,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._key = key
        self._limiter = limiter
        self._timeout = timeout_seconds
        self._deadline = deadline_seconds
        self._poll_interval = poll_interval_seconds
        self._transport = transport
        self._clock = clock
        self._closed = threading.Event()
        # The HTTP client library logs every request URL at INFO, and this one holds the video.
        logging.getLogger("httpx").setLevel(logging.WARNING)

    def english_captions(self, video: YouTubeVideo) -> CaptionTrack:
        return self.fetch(video)[0]

    def close(self) -> None:
        self._closed.set()
        self._limiter.close()

    def fetch(self, video: YouTubeVideo) -> tuple[CaptionTrack, ImportStats]:
        """The captions and what it took to get them (the smoke script prints the stats)."""
        started = self._clock()
        deadline = started + self._deadline
        params = {"url": video.canonical_url, "lang": LANGUAGE, "text": "false", "mode": "native"}
        with httpx.Client(transport=self._transport, follow_redirects=False) as client:
            status, body, billed = self._get(client, TRANSCRIPT_URL, params, deadline)
            requests, polls = 1, 0
            if status == 200:
                track = _track(_json_object(body))
            elif status == 202:
                job_id = _json_object(body).get("jobId")
                if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
                    raise _invalid("job id missing or malformed")
                track, polls = self._wait_for_job(client, job_id, deadline)
                requests += polls
            else:
                raise _status_failure(status, body, polling=False)
        stats = ImportStats(requests, polls, billed, self._clock() - started)
        logger.info(
            "Supadata import ok: requests=%d polls=%d captions=%d skipped_empty=%d "
            "latency_ms=%d billed_credits=%s",
            stats.requests,
            stats.polls,
            len(track.captions),
            track.skipped_empty,
            round(stats.latency_seconds * 1000),
            "-" if billed is None else billed,
        )
        return track, stats

    def _wait_for_job(
        self, client: httpx.Client, job_id: str, deadline: float
    ) -> tuple[CaptionTrack, int]:
        """Poll an asynchronous job until it completes, fails or the deadline passes."""
        polls = 0
        while True:
            if self._clock() + self._poll_interval >= deadline:
                logger.warning("Supadata job did not finish before the deadline: polls=%d", polls)
                raise ImportFailure("youtube_import_timeout")
            if self._closed.wait(self._poll_interval):
                raise ImportFailure("youtube_import_cancelled")
            status, body, _ = self._get(client, f"{TRANSCRIPT_URL}/{job_id}", None, deadline)
            polls += 1
            if status == 429 and not _is_quota(body):
                # A rate-limited status read; the next one waits for the shared limiter.
                continue
            if status != 200:
                raise _status_failure(status, body, polling=True)
            data = _json_object(body)
            job_status = data.get("status")
            if job_status in _PENDING:
                continue
            if job_status == "completed":
                return _track(data), polls
            if job_status == "failed":
                raise _job_failure(data.get("error"))
            raise _invalid("unknown job status")

    def _get(
        self, client: httpx.Client, url: str, params: dict[str, str] | None, deadline: float
    ) -> tuple[int, bytes, int | None]:
        try:
            self._limiter.acquire(deadline=deadline)
        except RateLimiterDeadline:
            logger.warning("Supadata request slot not free before the deadline")
            raise ImportFailure("youtube_import_timeout") from None
        except RateLimiterClosed:
            raise ImportFailure("youtube_import_cancelled") from None
        started = self._clock()
        limit = min(self._timeout, deadline - started)
        if limit <= 0:
            raise ImportFailure("youtube_import_timeout")
        headers = {
            "x-api-key": self._key.get_secret_value(),
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        try:
            with client.stream(
                "GET",
                url,
                params=params,
                headers=headers,
                timeout=httpx.Timeout(limit, connect=min(10.0, limit)),
            ) as response:
                body = self._read_body(response, started, limit)
                status = response.status_code
                billed = response.headers.get("x-billable-requests", "")
        except httpx.TimeoutException:
            logger.warning("Supadata request timed out")
            raise ImportFailure("youtube_import_timeout") from None
        except httpx.HTTPError as exc:
            logger.warning("Supadata request failed: %s", type(exc).__name__)
            raise ImportFailure("youtube_import_service_error") from None
        return status, body, int(billed) if billed.isdigit() else None

    def _read_body(self, response: httpx.Response, started: float, limit: float) -> bytes:
        chunks: list[bytes] = []
        size = 0
        for chunk in response.iter_bytes():
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                logger.warning("Supadata response exceeded the size limit")
                raise ImportFailure("youtube_import_too_large")
            if self._clock() - started > limit:
                raise httpx.ReadTimeout("total time limit exceeded")
            chunks.append(chunk)
        return b"".join(chunks)


def _invalid(reason: str) -> ImportFailure:
    # The reason is a fixed phrase from this module, never provider text.
    logger.warning("Supadata response rejected: %s", reason)
    return ImportFailure("youtube_import_invalid_response")


def _json_object(body: bytes) -> dict:
    try:
        data = json.loads(body)
    except ValueError:
        raise _invalid("not JSON") from None
    if not isinstance(data, dict):
        raise _invalid("not a JSON object")
    return data


def _track(data: dict) -> CaptionTrack:
    """Captions of a completed answer (immediate or job result), checked completely."""
    content = data.get("content")
    language = data.get("lang")
    if not isinstance(content, list):
        # A string would be a plain-text transcript without times: not what was asked for.
        raise _invalid("content is not a list of captions")
    if not isinstance(language, str):
        raise _invalid("lang missing")
    available = data.get("availableLangs")
    if available is not None and not isinstance(available, list):
        raise _invalid("availableLangs is not a list")
    if not is_english(language):
        logger.info("Supadata returned no English captions")
        raise ImportFailure("youtube_import_no_english_captions")
    raw: list[RawCaption] = []
    for item in content:
        if not isinstance(item, dict):
            raise _invalid("caption is not an object")
        if any(key not in item for key in ("text", "offset", "duration")):
            raise _invalid("caption field missing")
        chunk_language = item.get("lang")
        if chunk_language is not None:
            if not isinstance(chunk_language, str):
                raise _invalid("caption lang is not a string")
            if not is_english(chunk_language):
                logger.info("Supadata returned captions in another language")
                raise ImportFailure("youtube_import_no_english_captions")
        raw.append(RawCaption(item["text"], item["offset"], item["duration"]))
    try:
        return build_track(language, raw)
    except CaptionError as exc:
        logger.warning("Supadata captions rejected: %s", exc.reason)
        raise ImportFailure(exc.code) from None


def _error_code(body: bytes) -> str | None:
    try:
        code = json.loads(body).get("error")
    except (ValueError, AttributeError):
        return None
    return _known_code(code)


def _known_code(code: object) -> str | None:
    # Only a documented code is logged or used; anything else (even a list) is ignored.
    return code if isinstance(code, str) and code in _ERROR_CODES else None


def _is_quota(body: bytes) -> bool:
    try:
        details = json.loads(body).get("details")
    except (ValueError, AttributeError):
        return False
    return isinstance(details, str) and _QUOTA_DETAILS in details.lower()


def _status_failure(status: int, body: bytes, *, polling: bool) -> ImportFailure:
    logger.warning(
        "Supadata returned http_status=%d supadata_code=%s polling=%s",
        status,
        _error_code(body) or "-",
        polling,
    )
    if status == 206:
        return ImportFailure("youtube_import_no_english_captions")
    if status == 401:
        return ImportFailure("youtube_import_auth_failed")
    if status in (400, 402):
        return ImportFailure("youtube_import_rejected")
    if status in (403, 404) and not polling:
        return ImportFailure("youtube_import_video_unavailable")
    if status == 429:
        return ImportFailure(
            "youtube_import_quota_exceeded" if _is_quota(body) else "youtube_import_rate_limited"
        )
    # 5xx, a redirect, a 404 for an expired job, or any status the contract does not list.
    return ImportFailure("youtube_import_service_error")


def _job_failure(error: object) -> ImportFailure:
    code = _known_code(error.get("error")) if isinstance(error, dict) else None
    logger.warning("Supadata job failed: supadata_code=%s", code or "-")
    details = error.get("details") if isinstance(error, dict) else None
    if code == "transcript-unavailable":
        return ImportFailure("youtube_import_no_english_captions")
    if code in ("forbidden", "not-found"):
        return ImportFailure("youtube_import_video_unavailable")
    if code == "unauthorized":
        return ImportFailure("youtube_import_auth_failed")
    if code in ("invalid-request", "upgrade-required"):
        return ImportFailure("youtube_import_rejected")
    if code == "limit-exceeded":
        quota = isinstance(details, str) and _QUOTA_DETAILS in details.lower()
        return ImportFailure(
            "youtube_import_quota_exceeded" if quota else "youtube_import_rate_limited"
        )
    return ImportFailure("youtube_import_service_error")
