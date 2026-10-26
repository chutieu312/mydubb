"""Admission control in front of the caption provider.

An import holds a provider connection (and briefly a thread for the rate limiter and for parsing)
while it waits, so only a few may run at once; one more is refused straight away
(`youtube_import_busy`) instead of waiting in a queue. This bounds resources, not usage: there is
no per-user or per-day import quota.
"""

import threading

from app.youtube_import.base import CaptionProvider, ImportFailure
from app.youtube_import.captions import CaptionTrack
from app.youtube_import.youtube_url import YouTubeVideo


class YouTubeImporter:
    def __init__(self, provider: CaptionProvider, *, max_concurrent: int) -> None:
        self.provider = provider
        self._slots = threading.BoundedSemaphore(max_concurrent)

    async def import_captions(self, video: YouTubeVideo) -> CaptionTrack:
        # Non-blocking, so it is safe on the event loop.
        if not self._slots.acquire(blocking=False):
            raise ImportFailure("youtube_import_busy")
        try:
            return await self.provider.english_captions(video)
        finally:
            self._slots.release()

    def close(self) -> None:
        self.provider.close()
