"""Which speech-text rules a job's language uses.

Vietnamese keeps its original chunker (`chunker.py`), language spans (`ssml.chunk_language_spans`)
and syllable estimate (`spoken_length.py`), unchanged. Mandarin uses `mandarin.py`, because Chinese
is written without spaces. Everything after this point (SSML skeleton, one voice per request,
requests, WAV checks, joining, encoding, timed-mode cuts) is shared.
"""

from collections.abc import Callable

from app.languages import TargetLanguage
from app.speech import mandarin
from app.speech.chunker import speech_text, split_for_speech
from app.speech.spoken_length import spoken_syllables
from app.speech.ssml import chunk_language_spans
from app.translation.glossary import TermMatcher


def chunk_spans(
    text: str, terms: TermMatcher, max_chars: int, language: TargetLanguage
) -> list[list[tuple[str, str]]]:
    """The (language, text) spans of each speech chunk, in order; their texts joined are the
    chunk. Raises `chunker.SpeechTextTooLongError` when the text cannot be split safely."""
    if language is TargetLanguage.MANDARIN:
        return mandarin.chunk_spans(text, terms, max_chars, language.speech_locale)
    chunks = split_for_speech(text, terms, max_chars)
    return chunk_language_spans(speech_text(text), chunks, terms)


def syllable_estimate(language: TargetLanguage) -> Callable[[str], float]:
    """The spoken-length estimate used to compare speaking rates (timed mode)."""
    if language is TargetLanguage.MANDARIN:
        return mandarin.mandarin_syllables
    return spoken_syllables
