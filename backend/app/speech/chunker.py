"""Splits Vietnamese text into speech requests that stay within `max_chars`.

Chunks are whole lines and sentences whenever possible. A sentence longer than the limit is
cut at spaces, never inside a protected term (`TermMatcher.protected_matches`: glossary terms,
code and short English phrases detected for the job, see `pronunciation/`) and never inside a
word. A long English span is not protected and may be cut like any sentence; its language is
decided on the whole text (`ssml.chunk_language_spans`), not per chunk. Whitespace
inside a line is normalized to single spaces, blank lines are dropped and lines stay separated
by one line break (as in the audition the Product Owner accepted): `speech_text`. Nothing else
changes, so the chunks joined with their separators are exactly `speech_text(text)`, and no
text is lost, repeated or reordered.

The other target languages written with spaces between words (Hindi, Spanish, Arabic, French,
Russian) use this same chunker through `speech/spaced.py`, which passes their own sentence ends
(`sentence_end`); Vietnamese uses the default, unchanged.
"""

import re
from collections.abc import Callable, Iterator

from app.translation.glossary import TermMatch, TermMatcher

_WHITESPACE = re.compile(r"\s+")
_SPACE = " "
_LINE_BREAK = "\n"
# Sentence-ending punctuation, optionally followed by closing quotes or brackets.
_SENTENCE_END = re.compile(r"[.!?…][\"'”’)\]}»]*$")  # noqa: RUF001 (typographic quotes are intended)


class SpeechTextTooLongError(ValueError):
    """A run of text without usable spaces (or a protected term) exceeds the chunk limit."""


def speech_text(text: str) -> str:
    """The text speech reads: single spaces inside lines, no blank lines."""
    lines = (" ".join(raw_line.split()) for raw_line in text.splitlines())
    return _LINE_BREAK.join(line for line in lines if line)


def _ends_sentence(atom: str) -> bool:
    return bool(_SENTENCE_END.search(atom))


def split_for_speech(
    text: str,
    terms: TermMatcher,
    max_chars: int,
    sentence_end: Callable[[str], bool] = _ends_sentence,
) -> list[str]:
    """Chunks of at most `max_chars` characters, in order. Blank text gives no chunks.

    `sentence_end` tells whether a piece of text between spaces ends a sentence."""
    units: list[tuple[str, str]] = []  # (separator before, text)
    for line in speech_text(text).split(_LINE_BREAK):
        if line:
            for number, unit in enumerate(_line_units(line, terms, max_chars, sentence_end)):
                units.append((_LINE_BREAK if number == 0 else _SPACE, unit))
    return list(_pack(units, max_chars))


def _line_units(
    line: str, terms: TermMatcher, max_chars: int, sentence_end: Callable[[str], bool]
) -> Iterator[str]:
    """The line as one unit if it fits, else sentences, else groups of words."""
    if len(line) <= max_chars:
        yield line
        return
    for sentence in _sentences(_atoms(line, terms.protected_matches(line)), sentence_end):
        joined = " ".join(sentence)
        if len(joined) <= max_chars:
            yield joined
        else:
            yield from _pack([(_SPACE, atom) for atom in sentence], max_chars)


def _atoms(line: str, matches: list[TermMatch]) -> list[str]:
    """Pieces of the line between spaces, keeping each protected term in one piece."""
    atoms = []
    start = 0
    for gap in _WHITESPACE.finditer(line):
        if any(m.start < gap.start() and gap.end() <= m.end for m in matches):
            continue
        atoms.append(line[start : gap.start()])
        start = gap.end()
    atoms.append(line[start:])
    return atoms


def _sentences(atoms: list[str], sentence_end: Callable[[str], bool]) -> Iterator[list[str]]:
    current: list[str] = []
    for atom in atoms:
        current.append(atom)
        if sentence_end(atom):
            yield current
            current = []
    if current:
        yield current


def _pack(pieces: list[tuple[str, str]], max_chars: int) -> Iterator[str]:
    """Greedily join consecutive (separator, piece) pairs while the result fits."""
    current = ""
    for separator, piece in pieces:
        if len(piece) > max_chars:
            raise SpeechTextTooLongError("a piece of text without spaces exceeds the limit")
        if current and len(current) + len(separator) + len(piece) > max_chars:
            yield current
            current = piece
        else:
            current = f"{current}{separator}{piece}" if current else piece
    if current:
        yield current
