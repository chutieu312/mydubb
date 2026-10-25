"""YouTube video links: strict validation and one canonical form.

Only the canonical URL built here (`https://www.youtube.com/watch?v=<id>`) ever leaves the server,
and only to the caption provider; the link the user typed is never fetched or forwarded. Accepted:

* `https://youtube.com/watch?v=<id>` (also `www.` and `m.`), other query parameters such as `t`,
  `list` or `si` ignored, a fragment ignored;
* `https://youtu.be/<id>`;
* `https://youtube.com/shorts/<id>`, `/embed/<id>`, `/live/<id>` (same hosts as `watch`).

Rejected: anything that is not `https`, user info (`user@`), a port other than 443, a host that is
not exactly one of the YouTube hosts (`youtube.com.example.org`, `evilyoutube.com`, a trailing
dot), a playlist or channel without a video, several `v` parameters, and a video ID that is not
11 characters of `A-Z a-z 0-9 _ -`.
"""

import re
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlsplit

MAX_URL_LENGTH = 2048

_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_WATCH_HOSTS = frozenset({"youtube.com", "www.youtube.com", "m.youtube.com"})
_SHORT_HOST = "youtu.be"
_PATH_PREFIXES = ("/shorts/", "/embed/", "/live/")
# Whitespace, control characters and backslashes are never part of a link someone copied, and
# URL parsers disagree about them.
_UNSAFE_CHARACTERS = re.compile(r"[\s\x00-\x1f\x7f\\]")

INVALID_URL_MESSAGE = (
    "Enter the link of a YouTube video, for example https://www.youtube.com/watch?v=... or "
    "https://youtu.be/...."
)
NO_SINGLE_VIDEO_MESSAGE = (
    "This link has no single video (a playlist or channel cannot be imported). Open one video "
    "and copy its link."
)


class InvalidYouTubeUrl(ValueError):
    def __init__(self, message: str = INVALID_URL_MESSAGE) -> None:
        super().__init__(message)


@dataclass(frozen=True)
class YouTubeVideo:
    video_id: str

    @property
    def canonical_url(self) -> str:
        return f"https://www.youtube.com/watch?v={self.video_id}"


def parse_youtube_url(raw: str) -> YouTubeVideo:
    """The video a link points to; raises InvalidYouTubeUrl for anything else."""
    text = raw.strip()
    if not text or len(text) > MAX_URL_LENGTH or _UNSAFE_CHARACTERS.search(text):
        raise InvalidYouTubeUrl
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        raise InvalidYouTubeUrl from None
    if parts.scheme.lower() != "https":
        raise InvalidYouTubeUrl("Only https:// YouTube links can be imported.")
    if "@" in parts.netloc or port not in (None, 443):
        raise InvalidYouTubeUrl
    host = (parts.hostname or "").lower()
    path = parts.path

    if host == _SHORT_HOST:
        candidate = path.removeprefix("/").removesuffix("/")
    elif host in _WATCH_HOSTS:
        if path in ("/watch", "/watch/"):
            query = parse_qsl(parts.query, keep_blank_values=True)
            values = [value for key, value in query if key == "v"]
            if len(values) != 1:
                raise InvalidYouTubeUrl(NO_SINGLE_VIDEO_MESSAGE)
            candidate = values[0]
        else:
            prefix = next((p for p in _PATH_PREFIXES if path.startswith(p)), None)
            if prefix is None:
                raise InvalidYouTubeUrl(NO_SINGLE_VIDEO_MESSAGE)
            candidate = path.removeprefix(prefix).removesuffix("/")
    else:
        raise InvalidYouTubeUrl
    if not _VIDEO_ID.fullmatch(candidate):
        raise InvalidYouTubeUrl("The link does not contain a valid YouTube video ID.")
    return YouTubeVideo(candidate)
