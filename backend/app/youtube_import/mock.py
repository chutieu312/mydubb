"""Fixed captions for development and the browser E2E suite (YOUTUBE_IMPORT_PROVIDER=mock).

Not allowed in production: whatever the link, the same captions come back. They include what a
real track has: millisecond start times, two captions starting together, an empty caption and
Unicode. One video ID behaves like a video without English captions, so the error path can be
exercised without a provider.
"""

import threading

from app.youtube_import.base import ImportFailure
from app.youtube_import.captions import CaptionTrack, RawCaption, build_track
from app.youtube_import.youtube_url import YouTubeVideo

MOCK_NO_ENGLISH_VIDEO_ID = "noEnglish00"

MOCK_CAPTIONS = (
    RawCaption("Welcome back. Today we look at gradient descent.", 480, 2480),
    RawCaption("It minimizes the loss function", 2960, 2140),
    RawCaption("of a neural network, step by step.", 5100, 1900),
    RawCaption("[Music]", 5100, 600),
    RawCaption("", 7000, 0),
    RawCaption("Spring Boot's REST API returns JSON, naïve café style.", 9250, 2000),
)


class MockCaptionProvider:
    name = "mock"

    def __init__(self, *, delay: float = 0.0) -> None:
        self._delay = delay
        self._closed = threading.Event()

    def english_captions(self, video: YouTubeVideo) -> CaptionTrack:
        if self._delay and self._closed.wait(self._delay):
            raise ImportFailure("youtube_import_cancelled")
        if video.video_id == MOCK_NO_ENGLISH_VIDEO_ID:
            raise ImportFailure("youtube_import_no_english_captions")
        return build_track("en", MOCK_CAPTIONS)

    def close(self) -> None:
        self._closed.set()
