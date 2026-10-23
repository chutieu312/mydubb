from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.speech.voices import Voice
from app.translation.glossary import TermMatcher


@dataclass(frozen=True)
class SpeechAudio:
    path: Path
    # True when the audio is a bundled fixture, not speech generated from the text.
    is_fixture: bool
    # Uncompressed audio the MP3 was encoded from, when the provider keeps it in `work_dir`
    # (Milestone 3C can adjust the tempo before encoding instead of re-encoding an MP3).
    lossless_path: Path | None = None


class SpeechProvider(Protocol):
    """Synthesizes Vietnamese text into an audio file inside `work_dir`.

    `terms` are the spans read in English (the glossary plus English detected for this job,
    see `pronunciation/`); None means the shared glossary only. They never change the text.

    Implementations raise ProcessingError for expected failures and must not retry
    calls whose outcome is unknown.
    """

    name: str

    def synthesize(
        self, text: str, voice: Voice, work_dir: Path, terms: TermMatcher | None = None
    ) -> SpeechAudio: ...
