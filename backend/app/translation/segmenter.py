"""Splits a transcript into translation segments that fit a provider's request limits.

Every transcript line becomes one or more segments (array elements of a translate request).
A line that does not fit in `max_chars` is cut at sentence boundaries, then at any
whitespace, but never inside a protected glossary term and never inside a word. Sizes are
those of the final markup (escaped text plus no-translate wrappers) in UTF-16 code units, the
conservative way to count characters. Whitespace that separates pieces is kept, so joining the
translated segments reproduces the original line and paragraph structure.
"""

import re
from bisect import bisect_left, bisect_right
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from itertools import pairwise

from app.translation.glossary import Glossary, TermMatch
from app.translation.notranslate_markup import WRAPPER_OVERHEAD, to_markup

_WHITESPACE = re.compile(r"\s+")
# Sentence-ending punctuation, optionally followed by closing quotes or brackets.
_SENTENCE_END = re.compile(r"[.!?…][\"'”’)\]}»]*$")  # noqa: RUF001 (typographic quotes are intended)
# Characters that grow when escaped: "&" -> "&amp;", "<" -> "&lt;", ">" -> "&gt;".
_ESCAPED_SIZE = {"&": 5, "<": 4, ">": 4}


class SegmentTooLongError(ValueError):
    """A run of text without whitespace (or a protected term) is longer than the limit."""


@dataclass(frozen=True)
class Segment:
    markup: str
    terms: tuple[str, ...]  # protected terms inside, as written in the input

    @property
    def size(self) -> int:
        return utf16_length(self.markup)


@dataclass(frozen=True)
class _Line:
    prefix: str  # leading whitespace, kept as is
    suffix: str  # trailing whitespace (e.g. "\r"), kept as is
    segments: tuple[Segment, ...]  # empty for blank lines
    separators: tuple[str, ...]  # whitespace between consecutive segments


@dataclass(frozen=True)
class TranslationPlan:
    lines: tuple[_Line, ...]

    @property
    def segments(self) -> list[Segment]:
        return [segment for line in self.lines for segment in line.segments]

    def batches(self, max_chars: int, max_elements: int) -> Iterator[list[Segment]]:
        """Consecutive segments grouped into requests within both limits."""
        batch: list[Segment] = []
        size = 0
        for segment in self.segments:
            if batch and (size + segment.size > max_chars or len(batch) >= max_elements):
                yield batch
                batch, size = [], 0
            batch.append(segment)
            size += segment.size
        if batch:
            yield batch

    def assemble(self, translated: Sequence[str]) -> str:
        """Rebuild the full text from one translated string per segment, in plan order."""
        if len(translated) != len(self.segments):
            raise ValueError("translated segment count does not match the plan")
        pieces = iter(translated)
        out_lines: list[str] = []
        for line in self.lines:
            body = ""
            for index, _ in enumerate(line.segments):
                if index:
                    body += line.separators[index - 1]
                body += next(pieces)
            out_lines.append(f"{line.prefix}{body}{line.suffix}" if line.segments else line.prefix)
        return "\n".join(out_lines)


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def plan_translation(text: str, glossary: Glossary, max_chars: int) -> TranslationPlan:
    """Plan the segments for `text`. Raises SegmentTooLongError if it cannot be split safely."""
    lines = []
    for raw in text.split("\n"):
        content = raw.strip()
        if not content:
            lines.append(_Line(prefix=raw, suffix="", segments=(), separators=()))
            continue
        prefix = raw[: len(raw) - len(raw.lstrip())]
        suffix = raw[len(raw.rstrip()) :]
        segments, separators = _plan_line(content, glossary, max_chars)
        lines.append(_Line(prefix, suffix, tuple(segments), tuple(separators)))
    return TranslationPlan(tuple(lines))


def _plan_line(content: str, glossary: Glossary, max_chars: int) -> tuple[list[Segment], list[str]]:
    matches = glossary.find_matches(content)
    sizer = _Sizer(content, matches)
    ranges = _fit(content, sizer, 0, len(content), max_chars, level=0)
    segments = [_segment(content, sizer, start, end) for start, end in ranges]
    separators = [content[a_end:b_start] for (_, a_end), (b_start, _) in pairwise(ranges)]
    return segments, separators


def _segment(content: str, sizer: "_Sizer", start: int, end: int) -> Segment:
    inside = [
        TermMatch(m.start - start, m.end - start, m.text) for m in sizer.matches_within(start, end)
    ]
    return Segment(to_markup(content[start:end], inside), tuple(m.text for m in inside))


class _Sizer:
    """Term lookups and marked-up size (UTF-16 units) of slices that do not cut a term."""

    def __init__(self, content: str, matches: list[TermMatch]) -> None:
        self._matches = matches  # non-overlapping, sorted by start (so ends are sorted too)
        self._starts = [m.start for m in matches]
        self._ends = [m.end for m in matches]
        self._prefix = [0]
        for char in content:
            self._prefix.append(self._prefix[-1] + _ESCAPED_SIZE.get(char, utf16_length(char)))

    def matches_within(self, start: int, end: int) -> list[TermMatch]:
        return self._matches[bisect_left(self._starts, start) : bisect_right(self._ends, end)]

    def inside_term(self, start: int, end: int) -> bool:
        """Whether [start, end) lies within a single protected term."""
        index = bisect_right(self._starts, start) - 1
        return index >= 0 and self._ends[index] >= end

    def size(self, start: int, end: int) -> int:
        terms = len(self.matches_within(start, end))
        return self._prefix[end] - self._prefix[start] + terms * WRAPPER_OVERHEAD


def _fit(
    content: str,
    sizer: _Sizer,
    start: int,
    end: int,
    max_chars: int,
    level: int,
) -> list[tuple[int, int]]:
    if sizer.size(start, end) <= max_chars:
        return [(start, end)]
    if level >= 2:
        raise SegmentTooLongError("text without whitespace exceeds the request limit")
    units = _units(content, sizer, start, end, sentence_level=level == 0)
    if len(units) == 1:
        return _fit(content, sizer, start, end, max_chars, level + 1)
    out: list[tuple[int, int]] = []
    group_start, group_end = units[0]
    for unit_start, unit_end in units[1:]:
        if sizer.size(group_start, unit_end) <= max_chars:
            group_end = unit_end
        else:
            out += _fit(content, sizer, group_start, group_end, max_chars, level + 1)
            group_start, group_end = unit_start, unit_end
    out += _fit(content, sizer, group_start, group_end, max_chars, level + 1)
    return out


def _units(
    content: str, sizer: _Sizer, start: int, end: int, *, sentence_level: bool
) -> list[tuple[int, int]]:
    """Split [start, end) at whitespace runs that are outside protected terms."""
    units = []
    unit_start = start
    for gap in _WHITESPACE.finditer(content, start, end):
        gap_start, gap_end = gap.span()
        if gap_start == start or gap_end == end or sizer.inside_term(gap_start, gap_end):
            continue
        if sentence_level and not _SENTENCE_END.search(
            content[max(unit_start, gap_start - 8) : gap_start]
        ):
            continue
        units.append((unit_start, gap_start))
        unit_start = gap_end
    units.append((unit_start, end))
    return units
