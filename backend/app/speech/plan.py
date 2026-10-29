"""Which speech-text rules a job's language uses.

| Language | Chunks | Spoken length (timed mode) |
|---|---|---|
| Vietnamese | `chunker.py` + `ssml.chunk_language_spans` | `spoken_length.py` |
| Mandarin | `mandarin.py` (no spaces) | `mandarin.mandarin_syllables` |
| Japanese | `mandarin.chunk_unspaced` with `japanese.py` | `spoken_units.py` (morae) |
| Hindi, Spanish, Arabic, French, Russian | `spaced.py` (Vietnamese chunker) | `spoken_units.py` |

Vietnamese and Mandarin are unchanged. Everything after this point (SSML skeleton, one voice per
request, requests, WAV checks and their limits, joining, encoding, timed-mode cuts) is shared.
"""

from collections.abc import Callable

from app.languages import TargetLanguage
from app.speech import mandarin, spaced
from app.speech.chunker import speech_text, split_for_speech
from app.speech.japanese import JAPANESE_SCRIPT
from app.speech.spoken_length import spoken_syllables
from app.speech.spoken_units import spoken_estimate
from app.speech.ssml import chunk_language_spans
from app.translation.glossary import TermMatcher

_UNSPACED = frozenset({TargetLanguage.MANDARIN, TargetLanguage.JAPANESE})


def chunk_spans(
    text: str, terms: TermMatcher, max_chars: int, language: TargetLanguage
) -> list[list[tuple[str, str]]]:
    """The (language, text) spans of each speech chunk, in order; their texts joined are the
    chunk. Raises `chunker.SpeechTextTooLongError` when the text cannot be split safely."""
    if language is TargetLanguage.MANDARIN:
        return mandarin.chunk_spans(text, terms, max_chars, language.speech_locale)
    if language is TargetLanguage.JAPANESE:
        return mandarin.chunk_unspaced(
            text, terms, max_chars, language.speech_locale, JAPANESE_SCRIPT
        )
    if language is TargetLanguage.VIETNAMESE:
        chunks = split_for_speech(text, terms, max_chars)
        return chunk_language_spans(speech_text(text), chunks, terms)
    return spaced.chunk_spans(text, terms, max_chars, language)


def request_char_limit(language: TargetLanguage, max_chars: int) -> int:
    """Characters per request: the configured limit, or less for the languages without spaces
    (`mandarin.UNSPACED_MAX_CHUNK_CHARS`), whose characters are read longer."""
    if language in _UNSPACED:
        return min(max_chars, mandarin.UNSPACED_MAX_CHUNK_CHARS)
    return max_chars


def syllable_estimate(language: TargetLanguage) -> Callable[[str], float]:
    """The spoken-length estimate used to compare speaking rates (timed mode)."""
    if language is TargetLanguage.MANDARIN:
        return mandarin.mandarin_syllables
    if language is TargetLanguage.VIETNAMESE:
        return spoken_syllables
    return spoken_estimate(language)
