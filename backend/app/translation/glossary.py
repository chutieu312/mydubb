"""Glossary of English terms that must stay in English in the Vietnamese translation.

Pure text matching: no HTTP, no provider knowledge. The data file is
`data/glossary.txt` (format and policy for ambiguous words are documented at its top).
"""

import re
from bisect import bisect_left
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Protocol

DEFAULT_GLOSSARY_PATH = Path(__file__).parent / "data" / "glossary.txt"

_MAX_TERM_LENGTH = 100
_CASE_SENSITIVE_PREFIX = "="


class GlossaryError(ValueError):
    """The glossary file is invalid. The message names the line, never user content."""


@dataclass(frozen=True)
class TermMatch:
    start: int
    end: int
    text: str  # exactly as written in the input


class TermMatcher(Protocol):
    """Finds the terms that speech reads in English (the glossary, or more for one job)."""

    def find_matches(self, text: str) -> list[TermMatch]: ...


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
        candidates = [
            TermMatch(m.start(), m.end(), m.group())
            for term in self._terms
            for m in term.pattern.finditer(text)
        ]
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


def _compile(term: str, case_sensitive: bool) -> re.Pattern[str]:
    words = r"\s+".join(re.escape(word) for word in term.split(" "))
    # Whole words only; an optional plural "s" belongs to the term unless it already ends in "s"
    # or in a non-alphanumeric character (e.g. "C++").
    plural = "s?" if term[-1].isalnum() and term[-1].lower() != "s" else ""
    flags = 0 if case_sensitive else re.IGNORECASE
    return re.compile(rf"(?<!\w){words}{plural}(?!\w)", flags)


@lru_cache(maxsize=1)
def default_glossary() -> Glossary:
    return Glossary.from_file()
