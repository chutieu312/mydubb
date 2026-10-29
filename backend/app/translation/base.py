from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from app.languages import DEFAULT_TARGET_LANGUAGE, TargetLanguage


@dataclass(frozen=True)
class TranslationResult:
    text: str
    # True when the text is placeholder content rather than a real translation (mock mode).
    is_illustrative: bool
    # translate_lines only: one translation per input line, in order (the timed-mode blocks).
    lines: tuple[str, ...] = ()


class TranslationProvider(Protocol):
    """Translates cleaned English transcript text into the job's target language (Vietnamese
    unless stated otherwise).

    Implementations raise ProcessingError for expected failures (quota, timeout, rejected
    input). They must not retry calls whose outcome is unknown, and never translate into
    another language than the one asked for.
    """

    name: str

    def translate(
        self, text: str, language: TargetLanguage = DEFAULT_TARGET_LANGUAGE
    ) -> TranslationResult: ...

    def translate_lines(
        self, lines: Sequence[str], language: TargetLanguage = DEFAULT_TARGET_LANGUAGE
    ) -> TranslationResult:
        """One translation per line (timed mode: one per block, each a whole sentence or group
        of sentences, so no caption fragment is translated alone). `lines` hold no line breaks.
        The result's `lines` has exactly one entry per input line, or the call fails."""
        ...
