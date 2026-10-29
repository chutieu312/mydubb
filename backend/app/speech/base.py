from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.languages import DEFAULT_TARGET_LANGUAGE, TargetLanguage
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


@dataclass(frozen=True)
class TimedSpeechAudio:
    """One lossless clip per block of a timed transcript, in block order (timed mode)."""

    clips: tuple[Path, ...]  # empty for a fixture
    is_fixture: bool
    requests: int  # synthesis requests made (all blocks)
    # Mock mode: the bundled MP3 that stands in for the speech (not generated from the text).
    fixture_path: Path | None = None


class SpeechProvider(Protocol):
    """Synthesizes the translated text (in `language`, Vietnamese unless stated otherwise) into
    an audio file inside `work_dir`.

    `terms` are the spans read in English (the glossary plus English detected for this job,
    see `pronunciation/`); None means the shared glossary only. They never change the text.

    Implementations raise ProcessingError for expected failures and must not retry
    calls whose outcome is unknown.
    """

    name: str
    # True when the audio is a bundled fixture, not speech made from the text (mock).
    produces_fixture: bool

    def synthesize(
        self,
        text: str,
        voice: Voice,
        work_dir: Path,
        terms: TermMatcher | None = None,
        language: TargetLanguage = DEFAULT_TARGET_LANGUAGE,
    ) -> SpeechAudio: ...

    def synthesize_blocks(
        self,
        texts: Sequence[str],
        voice: Voice,
        work_dir: Path,
        terms: TermMatcher | None = None,
        language: TargetLanguage = DEFAULT_TARGET_LANGUAGE,
    ) -> TimedSpeechAudio:
        """One clip per text, in order (timed mode). Every block must succeed: a failure fails
        the whole call and no clip is returned."""
        ...
