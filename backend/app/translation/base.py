from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class TranslationResult:
    text: str
    # True when the text is placeholder content rather than a real translation (mock mode).
    is_illustrative: bool


class TranslationProvider(Protocol):
    """Translates cleaned English transcript text into Vietnamese.

    Implementations raise ProcessingError for expected failures (quota, timeout, rejected
    input). They must not retry calls whose outcome is unknown.
    """

    name: str

    def translate(self, text: str) -> TranslationResult: ...
