"""English left in a Spanish or French translation, for speech.

Spanish and French are written in Latin letters, and many of their words are spelled exactly like
English ones (`image`, `simple`, `local`, `important`, `global`) or like glossary terms used as
ordinary words (`=Vue` is French "vue", `=Tableau` French "tableau"). Neither the Vietnamese
syllable rule (`detector.py`) nor the source-overlap rule of the non-Latin languages
(`mandarin.py`) can tell them apart, so only what is certain is read with `en-US`:

1. **Glossary terms that the source contains** (same term, case-insensitive, plural "s" aside):
   the glossary protected them before translation, so the translation holds them in English. A
   glossary match whose term the source does not contain is a Spanish or French word and keeps the
   target locale.
2. **Code** copied verbatim from the source (URL, path, e-mail, identifier, `--flag`; the same
   rules as `detector.py`).
3. **Acronyms** copied with their exact case (`CPU`, `REST`): an all-caps word of two or more
   letters that the source contains with the same capitals.

Every other Latin word, English or not, keeps the target locale (es-ES / fr-FR) and is only
counted. Limit: an English word or phrase that the translation kept but the glossary does not list
(`trenchcoat`, a product name) is read by the voice in Spanish or French. No glossary candidates
are recorded (the store is a legacy of the Vietnamese glossary review).
"""

from app.pronunciation.detector import (
    _ACRONYM,
    _WORD,
    Detection,
    Span,
    SpanKind,
    SpeechTerms,
    _code_tokens,
    _inside,
    _overlaps,
    _Source,
)
from app.pronunciation.keys import display_form
from app.translation.glossary import Glossary, TermMatch


def _term_key(text: str) -> str:
    key = " ".join(text.split()).casefold()
    return key[:-1] if key.endswith("s") else key


class SourceGlossary:
    """The glossary limited to the terms that occur in the source (see module doc, rule 1)."""

    def __init__(self, glossary: Glossary, source: str) -> None:
        self._glossary = glossary
        self._keys = {
            _term_key(match.text)
            for line in source.split("\n")
            for match in glossary.find_matches(line)
        }

    def find_matches(self, text: str) -> list[TermMatch]:
        return [m for m in self._glossary.find_matches(text) if _term_key(m.text) in self._keys]

    def protected_matches(self, text: str) -> list[TermMatch]:
        return self.find_matches(text)


def detect_english_latin(source: str, translation: str, glossary: Glossary) -> Detection:
    """English spans of a Spanish or French `translation` (see module doc). Never changes either
    text."""
    words = _Source(source)
    known_terms = SourceGlossary(glossary, source)
    code_terms: dict[str, None] = {}  # ordered set
    acronyms: dict[str, SpanKind] = {}
    unmatched = 0

    for line in translation.split("\n"):
        known = known_terms.find_matches(line)
        code = []
        for token in _code_tokens(line):
            if any(_overlaps(k, token) and not _inside(k, token) for k in known):
                continue
            code.append(token)
            if token.text in source:
                code_terms[token.text] = None
            else:
                unmatched += 1
        taken = [*known, *code]
        for match in _WORD.finditer(line):
            if any(t.start < match.end() and match.start() < t.end for t in taken):
                continue
            text = match.group()
            if _ACRONYM.fullmatch(text) and display_form(text) in words.exact_words:
                acronyms[text] = SpanKind.TERM
            else:
                unmatched += 1

    # The source-limited glossary replaces the shared one for this job's speech.
    speech_terms = SpeechTerms(known_terms, code=code_terms, english=acronyms)
    spans: list[Span] = []
    offset = 0
    for line in translation.split("\n"):
        for match, kind in speech_terms.classified_matches(line):
            spans.append(Span(offset + match.start, offset + match.end, match.text, kind))
        offset += len(line) + 1
    return Detection(
        spans=tuple(spans),
        candidates=(),
        ambiguous_tokens=0,
        unmatched_tokens=unmatched,
        dropped_candidates=0,
        speech_terms=speech_terms,
    )
