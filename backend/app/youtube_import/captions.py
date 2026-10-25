"""Captions of a video, checked and written as a timestamped transcript for the form.

The handoff format (docs/API.md, "Timestamped transcript format") is the YouTube transcript panel
layout that `app/transcript/cleaning.py` already understands: every caption is a line holding only
its start time, followed by a line with its text.

    0:00.480
    Welcome back. Today we look at gradient descent.
    0:02.960
    It minimizes the loss function

Times are `M:SS.mmm` below one hour and `H:MM:SS.mmm` from one hour on (hours not zero-padded,
minutes and seconds two digits, always three millisecond digits). Milliseconds are the provider's
own precision, so nothing is rounded to whole seconds. Caption text is kept as the provider sent
it: same words, punctuation, spelling, Unicode and repetitions, captions are not merged into
sentences, sorted or deduplicated. The only change is that line breaks inside one caption become a
single space (the format needs the text on one line), with the spaces around them removed.

Rules that make a response unusable instead of being repaired silently (`CaptionError`):

* a start time that is not a finite, non-negative number of milliseconds, or that reaches 100
  hours (the time format has at most two hour digits);
* start times that decrease (equal start times are kept, in the provider's order);
* a caption whose whole text would itself read as a timestamp line (`10:30`, `[0:05]`), because
  the transcript could then not be read back unambiguously;
* no caption with text at all.

A caption whose text is empty (or only whitespace) carries no words; it is left out and counted
in `skipped_empty`, which the UI reports. The two time-field suggestions are the start of the
first and of the last caption with text, truncated to whole seconds (`HH:MM:SS`, the format of
the fields); never the end of the last caption, the video length or an added tail. When both
truncate to the same second there is no baseline to suggest and both are None.
"""

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise

from app.transcript.timestamps import format_seconds

# One more digit than hours have in the format would no longer be read as a timestamp line.
MAX_START_MS = 100 * 3600 * 1000
# Text that a reader of the format (cleaning.py, or a timed parser) takes for a timestamp line.
_TIMESTAMP_LIKE = re.compile(r"^[\[(]?\d{1,2}(?::\d{1,2}){1,2}(?:[.,]\d+)?[\])]?$")


class CaptionError(ValueError):
    """The captions cannot be imported as they are. `code` is a youtube_import_* error code."""

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class RawCaption:
    """One caption as the provider described it, before any check."""

    text: object
    offset_ms: object
    duration_ms: object


@dataclass(frozen=True)
class Caption:
    start_ms: int
    duration_ms: int
    text: str


@dataclass(frozen=True)
class CaptionTrack:
    language: str
    captions: tuple[Caption, ...]
    skipped_empty: int

    @property
    def transcript(self) -> str:
        return "\n".join(
            f"{format_caption_time(caption.start_ms)}\n{caption.text}" for caption in self.captions
        )

    @property
    def first_start_ms(self) -> int:
        return self.captions[0].start_ms

    @property
    def last_start_ms(self) -> int:
        return self.captions[-1].start_ms

    def suggested_starts(self) -> tuple[str, str] | None:
        """First and Last Sentence Start Time for the form, or None without a baseline."""
        first = self.first_start_ms // 1000
        last = self.last_start_ms // 1000
        if last <= first:
            return None
        return format_seconds(first), format_seconds(last)


def format_caption_time(milliseconds: int) -> str:
    """`M:SS.mmm`, or `H:MM:SS.mmm` from one hour on."""
    hours, rest = divmod(milliseconds, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    seconds, millis = divmod(rest, 1000)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}.{millis:03d}"
    return f"{minutes}:{seconds:02d}.{millis:03d}"


def caption_text(text: str) -> str:
    """The caption on one line: line breaks (and the spaces around them) become one space."""
    return " ".join(part for line in text.splitlines() if (part := line.strip()))


def build_track(language: str, raw_captions: Sequence[RawCaption]) -> CaptionTrack:
    captions: list[Caption] = []
    skipped = 0
    for raw in raw_captions:
        if not isinstance(raw.text, str):
            raise CaptionError("youtube_import_invalid_response", "caption text is not a string")
        start = _milliseconds(raw.offset_ms, "offset")
        duration = _milliseconds(raw.duration_ms, "duration")
        if start >= MAX_START_MS:
            raise CaptionError("youtube_import_invalid_response", "offset beyond 100 hours")
        text = caption_text(raw.text)
        if not text:
            skipped += 1
            continue
        if _TIMESTAMP_LIKE.match(text):
            raise CaptionError("youtube_import_ambiguous_caption", "caption text is a timestamp")
        captions.append(Caption(start, duration, text))
    if not captions:
        raise CaptionError("youtube_import_empty_captions", "no caption has text")
    for previous, current in pairwise(captions):
        if current.start_ms < previous.start_ms:
            raise CaptionError("youtube_import_invalid_response", "offsets decrease")
    return CaptionTrack(language, tuple(captions), skipped)


def _milliseconds(value: object, name: str) -> int:
    # bool is an int in Python; a JSON true/false is never a time.
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise CaptionError("youtube_import_invalid_response", f"{name} is not a number")
    # isfinite() is only asked about floats: a huge JSON integer (10**400) cannot become one.
    if value < 0 or (isinstance(value, float) and not math.isfinite(value)):
        raise CaptionError("youtube_import_invalid_response", f"{name} is negative or not finite")
    # The provider documents whole milliseconds; a fraction is rounded half up to one.
    return value if isinstance(value, int) else math.floor(value + 0.5)
