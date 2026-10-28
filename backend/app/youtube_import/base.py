"""Caption provider interface and the import's user-safe errors."""

from dataclasses import dataclass
from typing import Protocol

from app.youtube_import.captions import CaptionTrack
from app.youtube_import.youtube_url import YouTubeVideo


@dataclass(frozen=True)
class _Failure:
    status: int
    message: str
    retry_after: int | None = None


# Status codes are MyDubb's own. A provider 401/403 is never a 401 here: that would read as the
# user's session having ended.
_FAILURES = {
    "youtube_import_disabled": _Failure(404, "YouTube import is not enabled on this server."),
    "youtube_import_busy": _Failure(
        503,
        "The server is already importing as many videos as it can. Please try again in a moment.",
        retry_after=10,
    ),
    "youtube_import_cancelled": _Failure(
        503, "The import was stopped because the server is restarting. Please try again."
    ),
    # A guest import that succeeded but could not be counted is not delivered (never charged).
    "youtube_import_not_recorded": _Failure(
        503,
        "The import could not be completed, so it was not counted and nothing was imported. "
        "Please try again.",
    ),
    "youtube_import_no_english_captions": _Failure(
        422,
        "This video has no English captions to import. MyDubb only imports captions the video "
        "already has; it does not transcribe audio. Paste a transcript instead.",
    ),
    "youtube_import_empty_captions": _Failure(
        422, "The English captions of this video contain no text. Paste a transcript instead."
    ),
    "youtube_import_video_unavailable": _Failure(
        422,
        "The captions of this video cannot be read: the video may not exist, be private, "
        "members-only, age-restricted, blocked in some regions or still live.",
    ),
    "youtube_import_not_representable": _Failure(
        422,
        "These captions cannot be imported with their timestamps without changing what is said "
        "(for example a video with a single caption, a caption that is only a time such as "
        "10:30, or captions that begin with a clock time such as 00:10:30). Nothing was "
        "imported. Paste the transcript instead.",
    ),
    "youtube_import_too_large": _Failure(
        422, "The captions of this video are too large to import. Paste a shorter transcript."
    ),
    "youtube_import_auth_failed": _Failure(
        502,
        "The caption service rejected this server's credentials. This is a server configuration "
        "problem, not an issue with your link. Please tell the administrator.",
    ),
    "youtube_import_rejected": _Failure(
        502,
        "The caption service refused the request. Please try again; if it keeps failing, tell "
        "the administrator.",
    ),
    "youtube_import_quota_exceeded": _Failure(
        503,
        "The caption service's monthly allowance for this server is used up, so videos cannot "
        "be imported for now. Paste a transcript instead, or tell the administrator.",
    ),
    "youtube_import_rate_limited": _Failure(
        503,
        "The caption service is receiving too many requests. Please try again in a moment.",
        retry_after=5,
    ),
    "youtube_import_timeout": _Failure(
        504, "The caption service did not answer in time. Please try again."
    ),
    "youtube_import_service_error": _Failure(
        502, "The caption service could not be reached or had a problem. Please try again."
    ),
    "youtube_import_invalid_response": _Failure(
        502,
        "The caption service returned captions that could not be used, so nothing was "
        "imported. Please try again, or paste a transcript.",
    ),
}


class ImportFailure(Exception):
    """An expected, user-reportable import failure. Never carries provider text or secrets."""

    def __init__(self, code: str) -> None:
        failure = _FAILURES[code]
        super().__init__(failure.message)
        self.code = code
        self.status_code = failure.status
        self.message = failure.message
        self.retry_after = failure.retry_after


class CaptionProvider(Protocol):
    # Reported by /api/meta and logged; never a secret.
    name: str

    async def english_captions(self, video: YouTubeVideo) -> CaptionTrack:
        """The video's existing English captions. Raises ImportFailure."""
        ...

    def close(self) -> None:
        """Application shutdown: stop waiting imports."""
        ...
