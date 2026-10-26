"""Timed transcripts: captions with start times become text blocks placed on the output timeline.

Supported structure (YouTube's transcript panel, copied as text): a timestamp alone on a line,
followed by the caption text on the next line(s), repeated. Timestamps are `M:SS`, `MM:SS` or
`H:MM:SS` (also `HH:MM:SS`), whole seconds, or with a dot and 1-3 millisecond digits as the
YouTube caption import writes them (`0:10.480`, the handoff format in API.md):

    0:00
    Generally, if if somebody's trying to
    0:01
    make a company work, they should expect

SRT and WebVTT are still accepted as transcripts, but their timing is not used yet: they are
cleaned (`cleaning.py`) and processed as plain text with the two start times the user enters.

What happens here (pure functions, no I/O):

1. **Parse** the captions. A document with two or more standalone timestamp lines has the timed
   structure; it must then be valid as a whole (`TimedTranscriptError` otherwise, never a guess):
   every timestamp well formed, the text starting with a timestamp, text after every timestamp,
   times never decreasing and the last caption later than the first.
2. **Join** the caption texts with single spaces (words, punctuation and order unchanged; fillers
   and repeated words are kept) and split the result into **sentence units** at sentence-ending
   punctuation. A full stop is not a boundary after a known abbreviation (`Dr.`, `e.g.`), a
   single letter or a dotted acronym (`U.S.`), or when the next word starts in lower case; a
   decimal or `Node.js` has no space after its dot and is never one. A run without punctuation is
   closed at the first caption start after `MAX_UNIT_WORDS` words, so a unit is then a bounded
   group of captions, not a sentence that was identified.
3. **Estimate** where each unit starts. A timestamp is when its caption starts, not when each word
   is spoken, so a unit that starts inside a caption gets a time interpolated by word count
   between that caption's start and the next one's: "to grind super hard. Uh except that" from
   0:03 to 0:05 puts "Uh" at 3 + 2 x 4/7 s. This is an estimate, not forced alignment.
4. Form **blocks**: units that start at the same time are merged (a block has a positive length),
   and anything starting at or after the last caption's time is appended to the block before it,
   because the last caption starts exactly where the baseline ends. Units can also be grouped up
   to `min_block_seconds` (fewer, longer blocks).

The baseline is taken from the first and last **caption** timestamps (`source_first`,
`source_last`), never from the blocks, so merging the last caption into an earlier block does not
change it. No time is added for reading the last words, which are still part of the last block.

`TimedTranscript.boundaries` maps every block start to a sample of the output audio:

    ratio  = (source_start - source_first) / source_baseline
    sample = round_half_up(ratio * selected_baseline * sample_rate / speed)

with exact fractions, so the last boundary is exactly `audio/speed.py`'s target and nothing
accumulates. The selected baseline is what the two time fields say (filled from the captions, and
editable): editing them rescales the timeline, it never drops text.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction
from itertools import pairwise

from app.audio.speed import AudioSpeed, DurationTarget, TimelinePlan

# A line that looks like a timestamp at all (validated strictly afterwards, so that "0:75" or
# "1:2:03" in a timed transcript is an error instead of spoken text).
_LOOSE_STAMP = re.compile(r"^\d{1,2}(?::\d{1,2}){1,2}(?:[.,]\d+)?$")
# Whole seconds (YouTube's panel) or a dot and 1-3 millisecond digits (the caption import's
# handoff format, see youtube_import/captions.py).
_M_SS = re.compile(r"^(\d{1,2}):([0-5]\d)(?:\.(\d{1,3}))?$")
_H_MM_SS = re.compile(r"^(\d{1,2}):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$")
_WHITESPACE = re.compile(r"\s+")
_SENTENCE_END = re.compile(r"[.!?…][\"'”’)\]}»]*$")  # noqa: RUF001 (typographic quotes are intended)
_TRAILING_CLOSERS = re.compile(r"[\"'”’)\]}»]+$")  # noqa: RUF001
_DOTTED_ACRONYM = re.compile(r"^(?:[A-Za-z]\.){2,}$")
_ABBREVIATIONS = frozenset(
    {
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "e.g", "i.e", "approx",
        "inc", "ltd", "corp", "fig", "cf", "al",
    }
)  # fmt: skip
# Without sentence punctuation, a unit is closed at the next caption start after this many
# words. Captions hold a handful of words, so a unit stays a short group of captions.
MAX_UNIT_WORDS = 30
# Within the structure, the timestamps a document needs before it counts as timed (as in
# cleaning.py, where two standalone timestamps in order are removed as markup).
MIN_TIMESTAMPS = 2


class TimedTranscriptError(ValueError):
    """The transcript has timestamps but cannot be timed safely. Nothing is guessed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Caption:
    start: Fraction  # seconds, exact to the millisecond, from its timestamp
    text: str  # whitespace normalized to single spaces


@dataclass(frozen=True)
class _Word:
    text: str
    caption: int  # index of its caption
    position: int  # index of the word within its caption


@dataclass(frozen=True)
class TimedBlock:
    """Consecutive words read in one stretch of the timeline, starting at `start`."""

    text: str
    start: Fraction  # source seconds
    # True when the start lies inside a caption (interpolated by word count), not at a timestamp.
    estimated_start: bool
    first_caption: int  # caption indices covered (inclusive), the link back to the source
    last_caption: int
    units: int  # sentence units merged into the block
    # True when the block ends with sentence punctuation (False: a caption group or the
    # unfinished end of the transcript).
    ends_sentence: bool


@dataclass(frozen=True)
class TimedTranscript:
    captions: tuple[Caption, ...]
    blocks: tuple[TimedBlock, ...]

    @property
    def source_first(self) -> Fraction:
        return self.captions[0].start

    @property
    def source_last(self) -> Fraction:
        return self.captions[-1].start

    @property
    def source_baseline(self) -> Fraction:
        return self.source_last - self.source_first

    @property
    def text(self) -> str:
        """All spoken text, one block per line (what plain cleaning would keep, regrouped)."""
        return "\n".join(block.text for block in self.blocks)

    def ratios(self) -> list[Fraction]:
        """Each block's start as a fraction of the source baseline: 0 for the first, below 1."""
        return [(block.start - self.source_first) / self.source_baseline for block in self.blocks]

    def plan(self, selected_baseline: int, speed: AudioSpeed) -> TimelinePlan:
        """The output timeline for the baseline the user selected and the speed."""
        if selected_baseline <= 0:
            raise ValueError("the selected baseline must be positive")
        return TimelinePlan(self.ratios(), DurationTarget(selected_baseline, speed))

    def boundaries(self, selected_baseline: int, speed: AudioSpeed, sample_rate: int) -> list[int]:
        """Output sample at which each block starts, plus the total: len(blocks) + 1 values.

        The first is 0 and the last is exactly `DurationTarget(selected_baseline, speed)`'s
        target. Values never decrease; two can be equal when a block is shorter than a sample at
        this scale (the audio step then reads those blocks in one frame).
        """
        return self.plan(selected_baseline, speed).boundaries(sample_rate)


def has_timed_structure(raw: str) -> bool:
    """Whether the document has the timed (standalone timestamp line) structure at all.

    True does not mean it is valid: `parse_timed_transcript` decides that. SRT and WebVTT cue
    documents are not this structure.
    """
    lines = _lines(raw)
    if _is_cue_document(lines):
        return False
    return sum(1 for line in lines if _LOOSE_STAMP.match(line)) >= MIN_TIMESTAMPS


def parse_timed_transcript(raw: str, *, min_block_seconds: int = 0) -> TimedTranscript:
    """Captions and timed blocks of a YouTube-style transcript; raises TimedTranscriptError."""
    captions = _parse_captions(raw)
    words = [
        _Word(text, index, position)
        for index, caption in enumerate(captions)
        for position, text in enumerate(caption.text.split(" "))
    ]
    units = _sentence_units(words)
    blocks = _blocks(units, words, captions, min_block_seconds)
    return TimedTranscript(tuple(captions), tuple(blocks))


def _caption_clock(seconds: Fraction) -> str:
    """How transcripts write a caption time: "0:05", "1:02:03", "0:10.480"."""
    millis = int(seconds * 1000)
    whole, fraction = divmod(millis, 1000)
    hours, rest = divmod(whole, 3600)
    minutes, secs = divmod(rest, 60)
    clock = f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"
    return f"{clock}.{fraction:03d}" if fraction else clock


def _lines(raw: str) -> list[str]:
    return [line.strip() for line in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")]


def _is_cue_document(lines: Sequence[str]) -> bool:
    first = next((line for line in lines if line), "")
    return first.startswith("WEBVTT") or any("-->" in line for line in lines)


def _parse_stamp(text: str) -> Fraction | None:
    """Seconds, exact to the millisecond; None when the line is not a valid caption time."""
    if match := _H_MM_SS.match(text):
        hours, minutes, seconds, fraction = match.groups()
    elif match := _M_SS.match(text):
        hours, (minutes, seconds, fraction) = "0", match.groups()
    else:
        return None
    millis = int((fraction or "0").ljust(3, "0"))
    whole = (int(hours) * 60 + int(minutes)) * 60 + int(seconds)
    return whole + Fraction(millis, 1000)


def _parse_captions(raw: str) -> list[Caption]:
    lines = _lines(raw)
    if not has_timed_structure(raw):
        raise TimedTranscriptError(
            "timestamps_not_found",
            "The transcript has no timestamps on their own lines (for example 0:05 above each "
            "caption), so it cannot be timed. Process it as plain text instead.",
        )
    captions: list[Caption] = []
    pending: tuple[int, int] | None = None  # (line number, seconds) of a stamp without text yet
    text: list[str] = []

    def close() -> None:
        if pending is None:
            return
        if not text:
            raise TimedTranscriptError(
                "timestamp_without_text",
                f"The timestamp on line {pending[0]} has no caption text after it.",
            )
        captions.append(Caption(pending[1], _WHITESPACE.sub(" ", " ".join(text)).strip()))

    for number, line in enumerate(lines, start=1):
        if not line:
            continue
        if _LOOSE_STAMP.match(line):
            seconds = _parse_stamp(line)
            if seconds is None:
                raise TimedTranscriptError(
                    "invalid_timestamp",
                    f"Line {number} ({line}) is not a valid timestamp. Use M:SS or H:MM:SS with "
                    "minutes and seconds from 00 to 59, optionally with milliseconds (0:05.480).",
                )
            close()
            pending, text = (number, seconds), []
        elif pending is None:
            raise TimedTranscriptError(
                "text_before_first_timestamp",
                f"Line {number} has text before the first timestamp, so its time is unknown.",
            )
        else:
            text.append(line)
    close()

    for previous, current in pairwise(captions):
        if current.start < previous.start:
            raise TimedTranscriptError(
                "timestamps_decrease",
                f"The timestamps go backwards ({_caption_clock(previous.start)} is followed "
                f"by {_caption_clock(current.start)}).",
            )
    if captions[-1].start <= captions[0].start:
        raise TimedTranscriptError(
            "zero_baseline",
            "The last caption starts at the same time as the first one, so there is no time span "
            "to place the audio in.",
        )
    return captions


def _ends_sentence(words: Sequence[_Word], index: int) -> bool:
    word = words[index].text
    if not _SENTENCE_END.search(word):
        return False
    if index + 1 < len(words) and words[index + 1].text[:1].islower():
        return False
    core = _TRAILING_CLOSERS.sub("", word)
    if core.endswith(".") and not core.endswith(".."):
        stem = core[:-1].lstrip("\"'“‘([{«").lower()  # noqa: RUF001
        if stem in _ABBREVIATIONS or len(stem) == 1 or _DOTTED_ACRONYM.match(core):
            return False
    return True


def _sentence_units(words: Sequence[_Word]) -> list[tuple[int, int, bool]]:
    """(first word, end word exclusive, ends with sentence punctuation) for every unit."""
    units: list[tuple[int, int, bool]] = []
    start = 0
    for index in range(len(words)):
        if _ends_sentence(words, index):
            units.append((start, index + 1, True))
            start = index + 1
        elif (
            index + 1 < len(words)
            and words[index + 1].position == 0
            and index + 1 - start >= MAX_UNIT_WORDS
        ):
            units.append((start, index + 1, False))
            start = index + 1
    if start < len(words):
        units.append((start, len(words), False))
    return units


def _start_time(word: _Word, captions: Sequence[Caption], words_in: Sequence[int]) -> Fraction:
    caption = captions[word.caption]
    if word.position == 0:
        return Fraction(caption.start)
    following = captions[word.caption + 1].start
    span = following - caption.start
    return caption.start + Fraction(span * word.position, words_in[word.caption])


def _blocks(
    units: Sequence[tuple[int, int, bool]],
    words: Sequence[_Word],
    captions: Sequence[Caption],
    min_block_seconds: int,
) -> list[TimedBlock]:
    words_in = [len(caption.text.split(" ")) for caption in captions]
    last_caption = len(captions) - 1
    source_last = captions[-1].start
    # (start time, first word, end word, unit count, ends with punctuation, estimated)
    merged: list[list] = []
    for first, end, punctuated in units:
        word = words[first]
        inside_last = word.caption == last_caption
        start = None if inside_last else _start_time(word, captions, words_in)
        if merged and (
            start is None
            or start >= source_last
            or start == merged[-1][0]
            or start - merged[-1][0] < min_block_seconds
        ):
            # No positive span of its own (or grouped): read it in the block before.
            merged[-1][2] = end
            merged[-1][3] += 1
            merged[-1][4] = punctuated
            continue
        merged.append([start, first, end, 1, punctuated, word.position != 0])
    blocks = []
    for start, first, end, count, punctuated, estimated in merged:
        blocks.append(
            TimedBlock(
                text=" ".join(word.text for word in words[first:end]),
                start=start,
                estimated_start=estimated,
                first_caption=words[first].caption,
                last_caption=words[end - 1].caption,
                units=count,
                ends_sentence=punctuated,
            )
        )
    return blocks
