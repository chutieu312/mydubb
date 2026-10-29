# ruff: noqa: RUF001, RUF002 (typographic quotes and spaced punctuation are the subject of this module)
"""Speech chunks for the target languages written with spaces between words, other than Vietnamese:
Hindi, Spanish, Arabic, French and Russian.

They use the Vietnamese chunker (`chunker.split_for_speech`: whole lines, then sentences, then
groups of words, cut only at spaces, never inside a protected term) and the same language spans
(`ssml.chunk_language_spans`) with their own locale. Vietnamese itself is unchanged; what differs
here is only what the chunker is told:

* **Sentence ends** include the danda । ॥ (Hindi) and ؟ ۔ (Arabic) besides . ! ? …. A "." after
  a single letter (an initial, "J.") or after a common abbreviation of the language ("Sr.", "M.",
  "p. ej.", "т. е.", "e.g.") does not end a sentence. Decimals, versions and identifiers ("3.14",
  "v2.1", "Node.js") contain no space, so they are never cut anyway.
* **Pieces kept together** (only for cutting; their language is not changed): a number grouped
  with spaces ("1 024", "10 000": French and Russian write thousands so), punctuation that French
  writes after a space ("Bonjour !", "50 %", "« mot »"). Speech normalizes no-break spaces to
  spaces (`chunker.speech_text`), so these are ordinary spaces here.
* **Word boundaries.** For Hindi, Arabic and Russian, the letters of the script are word
  boundaries for term matching (`pronunciation/scripts.py`), so `Kubernetesом` still holds the
  glossary term. Spanish and French are written in Latin letters and match as Vietnamese does.

Lengths are counted in characters, as `AZURE_SPEECH_MAX_CHUNK_CHARS` is (default 2000). These
languages are read at roughly as many characters per second as Vietnamese or more (Arabic leaves
short vowels unwritten: even at a slow 6 characters per second, 2000 characters are about 330 s,
plus at most 40 timed-mode breaks of about 3.5 s), well below the 10 minutes after which Azure
truncates a response (`azure.py`).
"""

import re
from collections.abc import Callable

from app.languages import TargetLanguage
from app.pronunciation.scripts import ScriptBoundaryTerms, script_of
from app.speech.chunker import speech_text, split_for_speech
from app.speech.ssml import chunk_language_spans
from app.translation.glossary import TermMatch, TermMatcher

_SENTENCE_END = re.compile(r"[.!?…।॥؟۔][\"'”’)\]}»]*$")
_OPENING = "\"'“‘([{«¿¡"
# A "." after one of these (case-insensitive) is an abbreviation, not the end of a sentence.
_COMMON_ABBREVIATIONS = frozenset({"e.g", "i.e", "vs", "approx"})
_ABBREVIATIONS = {
    TargetLanguage.SPANISH: frozenset(
        {"sr", "sra", "srta", "dr", "dra", "ud", "uds", "p", "pág", "págs", "ej", "núm", "aprox"}
        | {"ee", "uu", "av", "cap", "fig"}
    ),
    TargetLanguage.FRENCH: frozenset(
        {"m", "mm", "mme", "mmes", "mlle", "dr", "p", "pp", "ex", "cf", "env", "fig", "chap"}
    ),
    TargetLanguage.RUSSIAN: frozenset(
        {"т", "д", "п", "г", "гг", "др", "см", "напр", "стр", "рис", "им", "ул", "т.е", "т.д"}
        | {"т.п", "т.к", "и.т.д"}
    ),
}
_KEPT_TOGETHER = re.compile(
    r"""
      (?<!\d)\d{1,3}(?:\ \d{3})+(?!\d)        # 1 024, 10 000
    | \S+(?:\ [!?:;»%€$]+)+(?!\S)            # mot !   50 %   mot »
    | «\ \S+                                 # « mot
    """,
    re.VERBOSE,
)


def chunk_spans(
    text: str, terms: TermMatcher, max_chars: int, language: TargetLanguage
) -> list[list[tuple[str, str]]]:
    """(language, text) spans of each chunk, in order (see module doc). Raises
    `chunker.SpeechTextTooLongError` when a piece without spaces exceeds the limit."""
    script = script_of(language)
    if script is not None:
        terms = ScriptBoundaryTerms(terms, script)
    chunks = split_for_speech(
        text, _KeptTogether(terms), max_chars, sentence_end=_sentence_end(language)
    )
    return chunk_language_spans(speech_text(text), chunks, terms, base=language.speech_locale)


def _sentence_end(language: TargetLanguage) -> Callable[[str], bool]:
    abbreviations = _COMMON_ABBREVIATIONS | _ABBREVIATIONS.get(language, frozenset())

    def ends(atom: str) -> bool:
        match = _SENTENCE_END.search(atom)
        if match is None:
            return False
        if atom[match.start()] != ".":
            return True
        word = atom[: match.start()].lstrip(_OPENING).casefold()
        if len(word) == 1 and word.isalpha():
            return False  # an initial
        return word not in abbreviations

    return ends


class _KeptTogether:
    """`inner`, plus the pieces a cut must not separate (only `protected_matches`)."""

    def __init__(self, inner: TermMatcher) -> None:
        self._inner = inner

    def find_matches(self, text: str) -> list[TermMatch]:
        return self._inner.find_matches(text)

    def protected_matches(self, text: str) -> list[TermMatch]:
        extra = [TermMatch(m.start(), m.end(), m.group()) for m in _KEPT_TOGETHER.finditer(text)]
        return [*self._inner.protected_matches(text), *extra]
