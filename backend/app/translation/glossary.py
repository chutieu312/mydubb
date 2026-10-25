"""Glossary of English terms that must stay in English in the Vietnamese translation.

Pure text matching: no HTTP, no provider knowledge. The data file is
`data/glossary.txt` (format, selection policy and maintenance: `docs/GLOSSARY.md`).

How a text is searched (`Glossary.find_matches`):

1. Every term is in one Aho-Corasick automaton (`pyahocorasick`), built once per `Glossary` in
   memory; the shared glossary is built once per process (`default_glossary`). Nothing is
   pickled or stored.
2. The text is scanned once, in a search form where each whitespace run is one space and each
   character is replaced by a case key (`_case_keys`, one character per character). Positions
   in the search form map back to the text through the removed whitespace (`_SearchForm`).
3. Each hit is confirmed by the term's own regular expression, anchored at that position of the
   original text. That expression alone decides the match, as before: capitalization (`=TERM`
   lines are exact), whole words, any whitespace between words and the plural "s". The case
   key is the same for every pair of characters that `re.IGNORECASE` treats as equal (and
   sometimes for more, e.g. "ß" and "s", which the expression then rejects), so the scan finds
   every position where an expression can match.
4. Overlapping matches are resolved as before: longest first, then earliest.

Cost for a text of n characters with h automaton hits and k confirmed matches: the scan is
O(n + h), each confirmation reads at most the term and its whitespace, and the overlap step
sorts the k matches (O(k log k)) and inserts each into a sorted list (O(k) per insert in the
worst case). Building is O(total length of the terms) for the automaton, plus one compiled
expression per term.
"""

import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Protocol

import ahocorasick

DEFAULT_GLOSSARY_PATH = Path(__file__).parent / "data" / "glossary.txt"

_MAX_TERM_LENGTH = 100
_CASE_SENSITIVE_PREFIX = "="
_WHITESPACE = re.compile(r"\s+")
_CASED_PLANES_END = 0x20000


class GlossaryError(ValueError):
    """The glossary file is invalid. The message names the line, never user content."""


@dataclass(frozen=True)
class TermMatch:
    start: int
    end: int
    text: str  # exactly as written in the input


class TermMatcher(Protocol):
    """Finds the terms that speech reads in English (the glossary, or more for one job)."""

    def find_matches(self, text: str) -> list[TermMatch]:
        """Every span to read in English."""
        ...

    def protected_matches(self, text: str) -> list[TermMatch]:
        """The spans a speech chunk boundary must never cut."""
        ...


@dataclass(frozen=True)
class _Term:
    text: str
    case_sensitive: bool
    pattern: re.Pattern[str]


class Glossary:
    def __init__(self, terms: list[tuple[str, bool]]) -> None:
        """`terms` is a list of (term, case_sensitive)."""
        self._terms = [
            _Term(term, case_sensitive, _compile(term, case_sensitive))
            for term, case_sensitive in terms
        ]
        # Terms with the same search form (e.g. "=REST" and "rest") share one automaton entry.
        by_key: dict[str, list[int]] = {}
        for index, term in enumerate(self._terms):
            by_key.setdefault(_SearchForm(term.text).text, []).append(index)
        self._automaton = ahocorasick.Automaton()
        for key, indexes in by_key.items():
            self._automaton.add_word(key, (len(key), tuple(indexes)))
        if by_key:
            self._automaton.make_automaton()

    def __len__(self) -> int:
        return len(self._terms)

    def terms(self) -> list[tuple[str, bool]]:
        """(term, case_sensitive) in file order."""
        return [(term.text, term.case_sensitive) for term in self._terms]

    @classmethod
    def from_text(cls, content: str) -> "Glossary":
        terms: list[tuple[str, bool]] = []
        seen: set[str] = set()
        for number, raw in enumerate(content.splitlines(), start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            case_sensitive = line.startswith(_CASE_SENSITIVE_PREFIX)
            term = " ".join(line.removeprefix(_CASE_SENSITIVE_PREFIX).split())
            if not term:
                raise GlossaryError(f"glossary line {number}: empty term")
            if len(term) > _MAX_TERM_LENGTH:
                raise GlossaryError(f"glossary line {number}: term longer than 100 characters")
            if any(ord(ch) < 32 for ch in term) or "<" in term or ">" in term or "&" in term:
                raise GlossaryError(f"glossary line {number}: unsupported character in term")
            key = term if case_sensitive else term.casefold()
            if key in seen:
                raise GlossaryError(f"glossary line {number}: duplicate term")
            seen.add(key)
            terms.append((term, case_sensitive))
        return cls(terms)

    @classmethod
    def from_file(cls, path: Path = DEFAULT_GLOSSARY_PATH) -> "Glossary":
        return cls.from_text(path.read_text(encoding="utf-8"))

    def find_matches(self, text: str) -> list[TermMatch]:
        """Non-overlapping occurrences of glossary terms in `text`, in text order.

        When occurrences overlap, the longer one wins (ties: the earlier one). Each match keeps
        the spelling and capitalization of the input.
        """
        if not self._terms:  # an automaton without words cannot search
            return []
        search = _SearchForm(text)
        # Per term, where its next occurrence may start: occurrences of one term never overlap
        # each other (as with `finditer`); only different terms compete below.
        resume: dict[int, int] = {}
        candidates: list[TermMatch] = []
        for last, (length, indexes) in self._automaton.iter(search.text):
            start = search.original_index(last - length + 1)
            for index in indexes:
                if start < resume.get(index, 0):
                    continue
                match = self._terms[index].pattern.match(text, start)
                if match:
                    candidates.append(TermMatch(match.start(), match.end(), match.group()))
                    resume[index] = match.end()
        candidates.sort(key=lambda m: (m.start - m.end, m.start))  # longest first
        ordered: list[TermMatch] = []  # accepted matches, sorted by start
        starts: list[int] = []  # their starts, for bisect
        for candidate in candidates:
            index = bisect_left(starts, candidate.start)
            before = ordered[index - 1] if index > 0 else None
            after = ordered[index] if index < len(ordered) else None
            if (before and before.end > candidate.start) or (after and after.start < candidate.end):
                continue
            starts.insert(index, candidate.start)
            ordered.insert(index, candidate)
        return ordered

    def protected_matches(self, text: str) -> list[TermMatch]:
        """Every glossary term is kept in one piece."""
        return self.find_matches(text)


def _compile(term: str, case_sensitive: bool) -> re.Pattern[str]:
    words = r"\s+".join(re.escape(word) for word in term.split(" "))
    # Whole words only; an optional plural "s" belongs to the term unless it already ends in "s"
    # or in a non-alphanumeric character (e.g. "C++").
    plural = "s?" if term[-1].isalnum() and term[-1].lower() != "s" else ""
    flags = 0 if case_sensitive else re.IGNORECASE
    return re.compile(rf"(?<!\w){words}{plural}(?!\w)", flags)


class _SearchForm:
    """`text` with each whitespace run as one space and each character as its case key."""

    def __init__(self, text: str) -> None:
        pieces: list[str] = []
        # Where the search form gets shorter than `text`: from search index `_breaks[i]` on,
        # `_removed[i]` characters of `text` are missing before it.
        self._breaks: list[int] = []
        self._removed: list[int] = []
        removed = previous = 0
        for run in _WHITESPACE.finditer(text):
            pieces += (text[previous : run.start()], " ")
            previous = run.end()
            if run.end() - run.start() > 1:
                removed += run.end() - run.start() - 1
                self._breaks.append(run.end() - removed)
                self._removed.append(removed)
        pieces.append(text[previous:])
        self.text = "".join(pieces).translate(_case_keys())

    def original_index(self, index: int) -> int:
        """The position in `text` of the character at `index` of the search form."""
        position = bisect_right(self._breaks, index)
        return index + (self._removed[position - 1] if position else 0)


@lru_cache(maxsize=1)
def _case_keys() -> dict[int, int]:
    """`str.translate` table from a character to its case key (unlisted: the character itself).

    The key is the lowercase, then upper- and lowercase again, so characters that the regex
    engine also treats as equal meet (long s and "s", final and ordinary sigma, the Kelvin sign
    and "k"). A character whose uppercase is longer than one character uses its case folding
    instead ("ﬅ" and "ﬆ"). Only the first character of a mapping is kept ("İ" lowercases to
    two characters; the regex engine uses "i"), so positions never move. Built once per process
    from the Unicode tables of the running Python, which the `re` module uses too. Case
    mappings only exist in planes 0 and 1 (the tests check every code point).
    """
    table: dict[int, int] = {}
    for code in range(_CASED_PLANES_END):
        char = chr(code)
        lower = char.lower()[0]
        upper = lower.upper()
        key = upper.lower()[0] if len(upper) == 1 else lower.casefold()[0]
        if key != char:
            table[code] = ord(key)
    return table


@lru_cache(maxsize=1)
def default_glossary() -> Glossary:
    return Glossary.from_file()
