import time

from app.processing_errors import ProcessingError
from app.translation.base import TranslationResult

ILLUSTRATIVE_NOTICE = (
    "[Development mock mode - illustrative content, NOT a real Vietnamese translation]"
)


class MockTranslationProvider:
    """Deterministic stand-in for Azure Translator. Makes no network calls."""

    name = "mock-translation"

    def __init__(self, *, fail: bool = False, unexpected_error: bool = False, delay: float = 0.0):
        self._fail = fail
        self._unexpected_error = unexpected_error
        self._delay = delay

    def translate(self, text: str) -> TranslationResult:
        time.sleep(self._delay)
        if self._unexpected_error:
            raise RuntimeError("mock unexpected failure in translation stage")
        if self._fail:
            raise ProcessingError(
                "translation_failed", "Translation failed (development mock failure scenario)."
            )
        lines = [f"(VI mock) {line}" for line in text.split("\n")]
        text = "\n".join([ILLUSTRATIVE_NOTICE, *lines])
        return TranslationResult(text=text, is_illustrative=True)
