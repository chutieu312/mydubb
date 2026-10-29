import time
from collections.abc import Sequence

from app.languages import DEFAULT_TARGET_LANGUAGE, TargetLanguage
from app.processing_errors import ProcessingError
from app.translation.base import TranslationResult

ILLUSTRATIVE_NOTICE = (
    "[Development mock mode - illustrative content, NOT a real Vietnamese translation]"
)
# Each language's placeholder names that language, so a mock Mandarin job never shows text
# labelled as Vietnamese (and the reverse). The Vietnamese one is unchanged.
_NOTICES = {
    TargetLanguage.VIETNAMESE: ILLUSTRATIVE_NOTICE,
    TargetLanguage.MANDARIN: (
        "[Development mock mode - illustrative content, NOT a real Mandarin Chinese "
        "(Simplified) translation]"
    ),
}
_PREFIXES = {
    TargetLanguage.VIETNAMESE: "(VI mock) ",
    TargetLanguage.MANDARIN: "(ZH mock 中文示例) ",
}


class MockTranslationProvider:
    """Deterministic stand-in for Azure Translator. Makes no network calls."""

    name = "mock-translation"

    def __init__(self, *, fail: bool = False, unexpected_error: bool = False, delay: float = 0.0):
        self._fail = fail
        self._unexpected_error = unexpected_error
        self._delay = delay

    def translate(
        self, text: str, language: TargetLanguage = DEFAULT_TARGET_LANGUAGE
    ) -> TranslationResult:
        self._start()
        prefix = _PREFIXES[language]
        lines = [f"{prefix}{line}" for line in text.split("\n")]
        text = "\n".join([_NOTICES[language], *lines])
        return TranslationResult(text=text, is_illustrative=True)

    def translate_lines(
        self, lines: Sequence[str], language: TargetLanguage = DEFAULT_TARGET_LANGUAGE
    ) -> TranslationResult:
        self._start()
        prefix = _PREFIXES[language]
        translated = tuple(f"{prefix}{line}" for line in lines)
        text = "\n".join([_NOTICES[language], *translated])
        return TranslationResult(text=text, is_illustrative=True, lines=translated)

    def _start(self) -> None:
        time.sleep(self._delay)
        if self._unexpected_error:
            raise RuntimeError("mock unexpected failure in translation stage")
        if self._fail:
            raise ProcessingError(
                "translation_failed", "Translation failed (development mock failure scenario)."
            )
