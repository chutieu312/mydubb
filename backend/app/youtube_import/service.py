"""Admission control in front of the caption provider.

An import holds one request thread while it waits for the provider, so only a few may run at
once; one more is refused straight away (`youtube_import_busy`) instead of waiting in a queue.
This bounds threads, not usage: there is no per-user or per-day import quota.
"""

import threading

from app.youtube_import.base import CaptionProvider, ImportFailure
from app.youtube_import.captions import CaptionTrack
from app.youtube_import.youtube_url import YouTubeVideo


class YouTubeImporter:
    def __init__(self, provider: CaptionProvider, *, max_concurrent: int) -> None:
        self.provider = provider
        self._slots = threading.BoundedSemaphore(max_concurrent)

    def import_captions(self, video: YouTubeVideo) -> CaptionTrack:
        if not self._slots.acquire(blocking=False):
            raise ImportFailure("youtube_import_busy")
        try:
            return self.provider.english_captions(video)
        finally:
            self._slots.release()

    def close(self) -> None:
        self.provider.close()
