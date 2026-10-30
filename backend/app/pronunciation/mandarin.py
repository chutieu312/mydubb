"""English left in a Mandarin (Simplified Chinese) translation, for speech.

The same order of precedence as `detector.py` (glossary, then code, then words copied from the
source), with what differs for Chinese:

* **Boundaries.** Chinese has no spaces, so Han characters are word boundaries (`han.py`):
  `使用Kubernetes部署` holds the glossary term `Kubernetes`. For code, Han characters count as
  spaces, so a URL or path ends where the Chinese text resumes (`访问https://example.com了解`).
* **No Vietnamese syllable rule.** Mandarin is written in Han characters, so a Latin word in the
  translation is never Mandarin: a word copied from the source (case-insensitive), or an all-caps
  acronym copied with its exact case, is English, whatever its shape (`run`, `Go`, `map`). There is
  no "ambiguous" word. A Latin word that is not in the source stays `zh-CN` (it is only counted):
  the source decides, as for Vietnamese, nothing is guessed.
* Adjacent English words separated only by spaces form one span; a span with an English function
  word or more than `MAX_TERM_WORDS` words is English the translation left untranslated. Both are
  read `en-US`; nothing changes the text.
* **No glossary candidates.** The candidate store (`glossary_candidates/`) is a legacy of the
  Vietnamese glossary review and is not fed from Mandarin jobs.

The same rules apply to the other target languages not written in Latin letters (Hindi, Arabic,
Russian, Japanese: `detect_english_in_script` with their script from `scripts.py`): a Latin word
in such a translation is never a word of that language, so the source alone decides, as here.
"""

import re
from functools import partial

from app.pronunciation.detector import (
    _ACRONYM,
    _WORD,
    MAX_TERM_WORDS,
    STOPWORDS,
    Detection,
    Span,
    SpanKind,
    SpeechTerms,
    _code_tokens,
    _english_spans,
    _fold,
    _inside,
    _overlaps,
    _runs,
    _Source,
    _Status,
    _Token,
)
from app.pronunciation.han import HAN
from app.pronunciation.keys import display_form
from app.pronunciation.scripts import mask_script
from app.translation.glossary import Glossary


def _status(token: _Token, source: _Source) -> _Status:
    if _ACRONYM.fullmatch(token.text) and display_form(token.text) in source.exact_words:
        return _Status.ENGLISH
    if token.folded in source.words:
        return _Status.ENGLISH
    return _Status.UNMATCHED


def detect_english_in_script(
    source: str, translation: str, glossary: Glossary, script: re.Pattern[str]
) -> Detection:
    """English spans of a `translation` written in `script` (see module doc). Never changes
    either text."""
    words = _Source(source)
    code_terms: dict[str, None] = {}  # ordered set
    english_kinds: dict[str, SpanKind] = {}
    unmatched = 0

    for raw_line in translation.split("\n"):
        line = mask_script(raw_line, script)
        known = glossary.find_matches(line)
        code = []
        for token in _code_tokens(mask_script(raw_line, script, " ")):
            if any(_overlaps(k, token) and not _inside(k, token) for k in known):
                continue
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
                text = " ".join(line[span[0].start : span[-1].end].split())
                folded = [token.folded for token in span]
                if len(span) > MAX_TERM_WORDS or any(word in STOPWORDS for word in folded):
                    english_kinds[text] = SpanKind.UNTRANSLATED
                else:
                    english_kinds[text] = SpanKind.TERM
            unmatched += sum(
                1
                for token, status in zip(run, statuses, strict=True)
                if id(token) not in in_spans and status is _Status.UNMATCHED
            )

    speech_terms = SpeechTerms(glossary, code=code_terms, english=english_kinds)
    spans: list[Span] = []
    offset = 0
    for raw_line in translation.split("\n"):
        for match, kind in speech_terms.classified_matches(mask_script(raw_line, script)):
            if kind is SpanKind.TERM:
                kind = english_kinds.get(" ".join(match.text.split()), SpanKind.TERM)
            text = raw_line[match.start : match.end]
            spans.append(Span(offset + match.start, offset + match.end, text, kind))
        offset += len(raw_line) + 1
    return Detection(
        spans=tuple(spans),
        candidates=(),
        ambiguous_tokens=0,
        unmatched_tokens=unmatched,
        dropped_candidates=0,
        speech_terms=speech_terms,
    )


# Mandarin: Han characters are the script (`han.py`).
detect_english_mandarin = partial(detect_english_in_script, script=HAN)
