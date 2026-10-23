"""Finds English that the translation left in the Vietnamese text, for speech and review.

Pure text processing: no HTTP, no database, no model. It compares the cleaned English source
with the Vietnamese translation of the same job and never changes either text.

Order of precedence for each line of the translation:

1. **Glossary** terms, exactly as before (`translation/glossary.py`). Words inside a glossary
   match are not looked at again.
2. **Code**: a URL, e-mail address, path (`/proc`, `~/x`, `./run.sh`, `C:\\x`), `--flag`,
   dotted or snake_case identifier (`os.path`, `max_len`) or call (`main()`), copied
   **verbatim** from the source. It is read with `en-US` because it certainly is not
   Vietnamese, but how a voice reads `/` or `_` is a listening question; nothing promises a
   good reading. Code is never stored as a glossary candidate (it may hold user names, hosts
   or tokens). A code token that contains a glossary term replaces it (still English); one that
   cuts through a glossary term is dropped, so the glossary keeps priority.
3. **Words**: ASCII Latin words (letters, digits, inner `'` or `-`). A word is **English**
   only when both hold:
   a. it cannot be a Vietnamese syllable (`vietnamese.may_be_vietnamese`); Vietnamese writes
      each syllable separately, so `runtime`, `kernel`, `trenchcoat` cannot be Vietnamese,
      while `an`, `to`, `con`, `run` or `Nguyen` can (with or without diacritics), and
   b. it occurs in the source (case-insensitive), i.e. the translation copied it.
   An all-caps word copied with its exact case (`CEO`, `AI`) is an acronym even when its
   letters could spell a syllable.
   A word that may be Vietnamese is **ambiguous** and stays `vi-VN`; a non-Vietnamese word
   that is not in the source is **unmatched** and stays `vi-VN` too. Source overlap alone is
   never enough, and having no diacritics is never enough.
4. Adjacent English words (only spaces between them) form one span. Ambiguous words between
   two English words join the span only when the whole sequence occurs, contiguously, in the
   source ("features in trenchcoat").
5. A span with an English function word (`is`, `in`, `the`, ...) or more than three words is
   English the translation left untranslated: read `en-US`, never stored. Other spans are
   **glossary candidates** (word, phrase, proper name or acronym) for the review in batches.

Limits: an English word shaped like a Vietnamese syllable (`run`, `map`, `Go`) stays `vi-VN`
unless the glossary lists it; a Vietnamese loanword spelled like the English one (`video`,
`internet`) is read `en-US`. Nothing here can tell a technical term from an ordinary English
word the translation failed to translate (`trenchcoat`); that is the reviewer's decision, and
no candidate is ever approved or added to the glossary automatically.
"""

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from enum import StrEnum
from itertools import chain

from app.pronunciation.keys import candidate_key, display_form
from app.pronunciation.vietnamese import may_be_vietnamese
from app.translation.glossary import Glossary, TermMatch

# A candidate longer than this is not a term (and would start to be an excerpt).
MAX_TERM_WORDS = 3
MAX_TERM_CHARS = 100  # the glossary's own limit
# Bounds the database work one job can cause; the rest is only counted.
MAX_CANDIDATES_PER_JOB = 200

_WORD = re.compile(r"(?<![\w-])[A-Za-z][A-Za-z0-9]*(?:['’-][A-Za-z0-9]+)*(?![\w-])")  # noqa: RUF001
_PARTS = re.compile(r"['’-]")  # noqa: RUF001
_ONLY_SPACES = re.compile(r"[ \t\u00a0]+")
_CODE = re.compile(
    r"""
      (?<!\S)(?:[A-Za-z][A-Za-z0-9+.-]*://|www\.)\S+                    # URL
    | (?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+   # e-mail
    | (?<![^\s(\[{"'‘“])(?:~|\.{1,2})?/[A-Za-z0-9_][A-Za-z0-9_.~+/-]*   # path
    | (?<!\w)[A-Za-z]:\\\S+                                             # Windows path
    | (?<!\S)--[A-Za-z][A-Za-z0-9-]*                                    # --flag
    | (?<![\w.])_*[A-Za-z][A-Za-z0-9]*(?:(?:_+|\.)[A-Za-z0-9]+)+_*(?:\(\))?(?!\w)  # identifier
    | (?<!\w)__[A-Za-z][A-Za-z0-9_]*__(?!\w)                            # __dunder__
    | (?<![\w.])[A-Za-z_][A-Za-z0-9_]*\(\)                              # call
    """,  # noqa: RUF001
    re.VERBOSE,
)
_TRAILING_PUNCTUATION = ".,;:!?)]}'\"”’»…"  # noqa: RUF001
_OPENING_PUNCTUATION = "\"'“‘([{«"  # noqa: RUF001
_SENTENCE_END = ".!?…:"
_ACRONYM = re.compile(r"[A-Z][A-Z0-9]+s?")

# English function words: a span holding one is a clause the translation left in English,
# not a term.
_STOPWORDS = """
    a about after all also am an and any are aren't as at be because been but by can can't
    could did didn't do does doesn't don't even for from had has have he her his how i i'd
    i'll i'm i've if in into is isn't it it's its just me more my no not of on only or our
    out so some still than that that's the their them then there there's these they this
    those to too up very was we were what when where which who why will with won't would
    you your
    """
STOPWORDS = frozenset(_STOPWORDS.split())


class SpanKind(StrEnum):
    GLOSSARY = "glossary"  # a known term from the shared glossary
    TERM = "term"  # English word/phrase/name the translation kept; a glossary candidate
    UNTRANSLATED = "untranslated"  # English clause the translation left; not stored
    CODE = "code"  # URL, path, e-mail, identifier; not stored


class CandidateKind(StrEnum):
    WORD = "word"
    PHRASE = "phrase"
    PROPER_NAME = "proper_name"  # capitalized inside a sentence, or CamelCase
    ACRONYM = "acronym"


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    text: str
    kind: SpanKind


@dataclass(frozen=True)
class Candidate:
    key: str
    term: str  # display form, as detected
    kind: CandidateKind


class _Status(StrEnum):
    ENGLISH = "english"
    AMBIGUOUS = "ambiguous"
    UNMATCHED = "unmatched"


@dataclass(frozen=True)
class _Token:
    start: int
    end: int
    text: str
    folded: str


def _fold(word: str) -> str:
    return display_form(word).casefold()


def _overlaps(a: TermMatch, b: TermMatch) -> bool:
    return a.start < b.end and b.start < a.end


def _inside(inner: TermMatch, outer: TermMatch) -> bool:
    return outer.start <= inner.start and inner.end <= outer.end


def _exact(terms: Iterable[str]) -> Glossary:
    return Glossary([(term, True) for term in sorted(set(terms))])


class SpeechTerms:
    """The English spans speech uses for one job (a `TermMatcher` for chunking and SSML).

    The shared glossary first; code tokens that contain glossary terms replace them; then the
    English detected for this job, only where nothing else matched. The detected strings are
    matched exactly (case-sensitive, whole words, plural "s" as in the glossary) in every
    chunk, which is safe because each of them contains a word that cannot be Vietnamese.
    """

    def __init__(
        self, glossary: Glossary, *, code: Iterable[str] = (), english: Iterable[str] = ()
    ) -> None:
        self._glossary = glossary
        self._code = _exact(code)
        self._english = _exact(english)

    def find_matches(self, text: str) -> list[TermMatch]:
        return [match for match, _ in self.classified_matches(text)]

    def classified_matches(self, text: str) -> list[tuple[TermMatch, SpanKind]]:
        known = self._glossary.find_matches(text)
        code = [
            c
            for c in self._code.find_matches(text)
            if all(_inside(k, c) or not _overlaps(k, c) for k in known)
        ]
        known = [k for k in known if not any(_inside(k, c) for c in code)]
        taken = [*known, *code]
        english = [
            e for e in self._english.find_matches(text) if not any(_overlaps(e, t) for t in taken)
        ]
        labelled = chain(
            ((m, SpanKind.GLOSSARY) for m in known),
            ((m, SpanKind.CODE) for m in code),
            ((m, SpanKind.TERM) for m in english),
        )
        return sorted(labelled, key=lambda item: item[0].start)


@dataclass(frozen=True)
class Detection:
    spans: tuple[Span, ...]  # every en-US span of the translation, in text order
    candidates: tuple[Candidate, ...]  # deduplicated by key, in order of first appearance
    ambiguous_tokens: int  # words copied from the source that may be Vietnamese: kept vi-VN
    unmatched_tokens: int  # non-Vietnamese words/code not found in the source: kept vi-VN
    dropped_candidates: int  # beyond MAX_CANDIDATES_PER_JOB
    speech_terms: SpeechTerms

    def counts(self) -> dict[str, int]:
        """Numbers only, safe to log."""
        counts = {kind.value: 0 for kind in SpanKind}
        for span in self.spans:
            counts[span.kind.value] += 1
        return {
            **counts,
            "candidates": len(self.candidates),
            "ambiguous_tokens": self.ambiguous_tokens,
            "unmatched_tokens": self.unmatched_tokens,
        }


class _Source:
    """The words of the English source and where they stand next to each other."""

    def __init__(self, source: str) -> None:
        self.text = source
        self.words: set[str] = set()
        self.exact_words: set[str] = set()
        # Folded words in order; None where punctuation or a line break separates them.
        self._sequence: list[str | None] = []
        self._positions: dict[str, list[int]] = {}
        for line in source.split("\n"):
            previous_end: int | None = None
            for match in _WORD.finditer(line):
                if previous_end is not None and line[previous_end : match.start()].strip():
                    self._sequence.append(None)
                word = _fold(match.group())
                self.words.add(word)
                self.exact_words.add(display_form(match.group()))
                self._positions.setdefault(word, []).append(len(self._sequence))
                self._sequence.append(word)
                previous_end = match.end()
            self._sequence.append(None)

    def has_sequence(self, words: list[str]) -> bool:
        for position in self._positions.get(words[0], ()):
            if self._sequence[position : position + len(words)] == words:
                return True
        return False


def _code_tokens(line: str) -> Iterator[TermMatch]:
    for match in _CODE.finditer(line):
        text = match.group()
        while text and text[-1] in _TRAILING_PUNCTUATION and not text.endswith("()"):
            text = text[:-1]
        if not any(char.isalnum() for char in text):
            continue
        if _is_dotted_abbreviation(text):
            continue
        yield TermMatch(match.start(), match.start() + len(text), text)


def _is_dotted_abbreviation(text: str) -> bool:
    """ "e.g", "i.e", "U.S": dots between single letters are not an identifier."""
    if "." not in text or "_" in text or "/" in text or "@" in text or "(" in text:
        return False
    if "://" in text or text.startswith("www."):
        return False
    return any(len(part) < 2 for part in text.split("."))


def _status(token: _Token, source: _Source) -> _Status:
    if _ACRONYM.fullmatch(token.text) and display_form(token.text) in source.exact_words:
        # "CEO", "AI", "UI": an all-caps word copied with its exact case is an acronym, even
        # when its letters could spell a Vietnamese syllable.
        return _Status.ENGLISH
    if all(may_be_vietnamese(part) for part in _PARTS.split(token.text) if part):
        return _Status.AMBIGUOUS
    if token.folded in source.words:
        return _Status.ENGLISH
    return _Status.UNMATCHED


def _runs(line: str, tokens: list[_Token]) -> Iterator[list[_Token]]:
    """Groups of tokens separated only by spaces (no punctuation, no other word)."""
    run: list[_Token] = []
    for token in tokens:
        if run and not _ONLY_SPACES.fullmatch(line[run[-1].end : token.start]):
            yield run
            run = []
        run.append(token)
    if run:
        yield run


def _english_spans(
    run: list[_Token], statuses: list[_Status], source: _Source
) -> Iterator[list[_Token]]:
    i = 0
    while i < len(run):
        if statuses[i] is not _Status.ENGLISH:
            i += 1
            continue
        j = i
        k = i + 1
        while k < len(run):
            if statuses[k] is _Status.ENGLISH:
                j = k
                k += 1
                continue
            if statuses[k] is _Status.AMBIGUOUS:
                m = k
                while m < len(run) and statuses[m] is _Status.AMBIGUOUS:
                    m += 1
                if (
                    m < len(run)
                    and statuses[m] is _Status.ENGLISH
                    and source.has_sequence([t.folded for t in run[i : m + 1]])
                ):
                    j = m
                    k = m + 1
                    continue
            break
        yield run[i : j + 1]
        i = j + 1


def _sentence_initial(line: str, start: int) -> bool:
    before = line[:start].rstrip().rstrip(_OPENING_PUNCTUATION).rstrip()
    return not before or before[-1] in _SENTENCE_END


def _token_kind(line: str, token: _Token) -> CandidateKind:
    text = token.text
    if _ACRONYM.fullmatch(text):
        return CandidateKind.ACRONYM
    if any(char.isupper() for char in text[1:]):
        return CandidateKind.PROPER_NAME
    if text[0].isupper() and not _sentence_initial(line, token.start):
        return CandidateKind.PROPER_NAME
    return CandidateKind.WORD


class _Candidates:
    def __init__(self) -> None:
        self.by_key: dict[str, Candidate] = {}
        self.dropped = 0

    def add(self, term: str, kind: CandidateKind) -> None:
        term = display_form(term)
        if len(term) > MAX_TERM_CHARS:
            return
        key = candidate_key(term)
        existing = self.by_key.get(key)
        if existing is not None:
            # A capitalized sighting inside a sentence is better evidence of a name.
            if kind is CandidateKind.PROPER_NAME and existing.kind is CandidateKind.WORD:
                self.by_key[key] = Candidate(key, existing.term, kind)
            return
        if len(self.by_key) >= MAX_CANDIDATES_PER_JOB:
            self.dropped += 1
            return
        self.by_key[key] = Candidate(key, term, kind)


def detect_english(source: str, translation: str, glossary: Glossary) -> Detection:
    """English spans of `translation` and the job's glossary candidates (see module doc)."""
    words = _Source(source)
    code_terms: dict[str, None] = {}  # ordered set
    english_kinds: dict[str, SpanKind] = {}
    candidates = _Candidates()
    ambiguous = unmatched = 0

    for line in translation.split("\n"):
        known = glossary.find_matches(line)
        code = []
        for token in _code_tokens(line):
            if any(_overlaps(k, token) and not _inside(k, token) for k in known):
                continue
            # Code the translation changed is left alone, and its pieces are not words.
            code.append(token)
            if token.text in source:
                code_terms[token.text] = None
            else:
                unmatched += 1
        taken = [*known, *code]
        tokens = [
            _Token(m.start(), m.end(), m.group(), _fold(m.group()))
            for m in _WORD.finditer(line)
            if not any(t.start < m.end() and m.start() < t.end for t in taken)
        ]
        for run in _runs(line, tokens):
            statuses = [_status(token, words) for token in run]
            in_spans: set[int] = set()
            for span in _english_spans(run, statuses, words):
                in_spans.update(id(token) for token in span)
                text = line[span[0].start : span[-1].end]
                folded = [token.folded for token in span]
                if len(span) > MAX_TERM_WORDS or any(word in STOPWORDS for word in folded):
                    english_kinds[text] = SpanKind.UNTRANSLATED
                    continue
                english_kinds[text] = SpanKind.TERM
                if len(span) == 1:
                    candidates.add(text, _token_kind(line, span[0]))
                elif words.has_sequence(folded):
                    candidates.add(text, CandidateKind.PHRASE)
                else:
                    for token in span:
                        candidates.add(token.text, _token_kind(line, token))
            for token, status in zip(run, statuses, strict=True):
                if id(token) in in_spans:
                    continue
                if status is _Status.AMBIGUOUS and token.folded in words.words:
                    ambiguous += 1
                elif status is _Status.UNMATCHED:
                    unmatched += 1

    speech_terms = SpeechTerms(glossary, code=code_terms, english=english_kinds)
    spans: list[Span] = []
    offset = 0
    for line in translation.split("\n"):
        for match, kind in speech_terms.classified_matches(line):
            if kind is SpanKind.TERM:
                kind = english_kinds.get(match.text, SpanKind.TERM)
            spans.append(Span(offset + match.start, offset + match.end, match.text, kind))
        offset += len(line) + 1
    return Detection(
        spans=tuple(spans),
        candidates=tuple(candidates.by_key.values()),
        ambiguous_tokens=ambiguous,
        unmatched_tokens=unmatched,
        dropped_candidates=candidates.dropped,
        speech_terms=speech_terms,
    )
