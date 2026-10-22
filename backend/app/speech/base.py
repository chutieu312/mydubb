from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.speech.voices import Voice


@dataclass(frozen=True)
class SpeechAudio:
    path: Path
    # True when the audio is a bundled fixture, not speech generated from the text.
    is_fixture: bool


class SpeechProvider(Protocol):
    """Synthesizes Vietnamese text into an audio file inside `work_dir`.

    Implementations raise ProcessingError for expected failures and must not retry
    calls whose outcome is unknown.
    """

    name: str

    def synthesize(self, text: str, voice: Voice, work_dir: Path) -> SpeechAudio: ...
