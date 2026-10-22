"""Splits Vietnamese text into speech requests that stay within `max_chars`.

Chunks are whole lines and sentences whenever possible. A sentence longer than the limit is
cut at spaces, never inside a protected glossary term and never inside a word. Whitespace is
normalized to single spaces and nothing else changes, so `" ".join(chunks).split()` equals
`text.split()` and no text is lost, repeated or reordered.
"""

import re
from collections.abc import Iterator

from app.translation.glossary import Glossary, TermMatch

_WHITESPACE = re.compile(r"\s+")
# Sentence-ending punctuation, optionally followed by closing quotes or brackets.
_SENTENCE_END = re.compile(r"[.!?…][\"'”’)\]}»]*$")  # noqa: RUF001 (typographic quotes are intended)


class SpeechTextTooLongError(ValueError):
    """A run of text without usable spaces (or a protected term) exceeds the chunk limit."""


def split_for_speech(text: str, glossary: Glossary, max_chars: int) -> list[str]:
    """Chunks of at most `max_chars` characters, in order. Blank text gives no chunks."""
    units: list[str] = []
    for raw_line in text.splitlines():
        line = " ".join(raw_line.split())
        if line:
            units.extend(_line_units(line, glossary, max_chars))
    return list(_pack(units, max_chars))


def _line_units(line: str, glossary: Glossary, max_chars: int) -> Iterator[str]:
    """The line as one unit if it fits, else sentences, else groups of words."""
    if len(line) <= max_chars:
        yield line
        return
    for sentence in _sentences(_atoms(line, glossary.find_matches(line))):
        joined = " ".join(sentence)
        if len(joined) <= max_chars:
            yield joined
        else:
            yield from _pack(sentence, max_chars)


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


def _sentences(atoms: list[str]) -> Iterator[list[str]]:
    current: list[str] = []
    for atom in atoms:
        current.append(atom)
        if _SENTENCE_END.search(atom):
            yield current
            current = []
    if current:
        yield current


def _pack(pieces: "list[str] | Iterator[str]", max_chars: int) -> Iterator[str]:
    """Greedily join consecutive pieces with spaces while the result fits."""
    current = ""
    for piece in pieces:
        if len(piece) > max_chars:
            raise SpeechTextTooLongError("a piece of text without spaces exceeds the limit")
        if current and len(current) + 1 + len(piece) > max_chars:
            yield current
            current = piece
        else:
            current = f"{current} {piece}" if current else piece
    if current:
        yield current
