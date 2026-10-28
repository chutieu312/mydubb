"""Admission control in front of the caption provider.

An import holds a provider connection (and briefly a thread for the rate limiter and for parsing)
while it waits, so only a few may run at once; one more is refused straight away
(`youtube_import_busy`) instead of waiting in a queue. This bounds resources, not usage: accounts
have no import quota; guests have one of their own (guest/imports.py), checked after admission so
a refused import writes nothing.
"""

import contextlib
import threading
from collections.abc import Iterator

from app.youtube_import.base import CaptionProvider, ImportFailure
from app.youtube_import.captions import CaptionTrack
from app.youtube_import.youtube_url import YouTubeVideo


class ImportSlot:
    """One admitted import; `release` may be called more than once."""

    def __init__(self, slots: threading.BoundedSemaphore) -> None:
        self._slots = slots
        self._lock = threading.Lock()
        self._released = False

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._slots.release()


class YouTubeImporter:
    def __init__(self, provider: CaptionProvider, *, max_concurrent: int) -> None:
        self.provider = provider
        self._slots = threading.BoundedSemaphore(max_concurrent)

    def admit(self) -> ImportSlot:
        """Take one import slot, or raise `youtube_import_busy` at once."""
        # Non-blocking, so it is safe on the event loop.
        if not self._slots.acquire(blocking=False):
            raise ImportFailure("youtube_import_busy")
        return ImportSlot(self._slots)

    @contextlib.contextmanager
    def admitted(self) -> Iterator[None]:
        slot = self.admit()
        try:
            yield
        finally:
            slot.release()

    async def import_captions(self, video: YouTubeVideo) -> CaptionTrack:
        with self.admitted():
            return await self.provider.english_captions(video)

    def close(self) -> None:
        self.provider.close()
