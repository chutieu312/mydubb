import shutil
import time
from collections.abc import Sequence
from pathlib import Path

from app.languages import DEFAULT_TARGET_LANGUAGE, TargetLanguage
from app.processing_errors import ProcessingError
from app.speech.base import SpeechAudio, TimedSpeechAudio
from app.speech.voices import Voice
from app.translation.glossary import TermMatcher

FIXTURE_MP3 = Path(__file__).resolve().parent.parent / "audio" / "fixtures" / "mock_audio.mp3"


class MockSpeechProvider:
    """Returns a bundled MP3 fixture regardless of the input text, voice or language.

    The fixture (a synthetic chime, no speech in any language) is NOT generated from the
    submitted transcript and does not reflect the target duration. It only exercises playback
    and download.
    """

    name = "mock-speech"
    produces_fixture = True

    def __init__(self, *, fail: bool = False, delay: float = 0.0) -> None:
        self._fail = fail
        self._delay = delay

    def synthesize(
        self,
        text: str,
        voice: Voice,
        work_dir: Path,
        terms: TermMatcher | None = None,
        language: TargetLanguage = DEFAULT_TARGET_LANGUAGE,
    ) -> SpeechAudio:
        return SpeechAudio(path=self._fixture(work_dir), is_fixture=True)

    def synthesize_blocks(
        self,
        texts: Sequence[str],
        voice: Voice,
        work_dir: Path,
        terms: TermMatcher | None = None,
        language: TargetLanguage = DEFAULT_TARGET_LANGUAGE,
    ) -> TimedSpeechAudio:
        """The same fixture: no clip per block, so nothing is placed on a timeline."""
        return TimedSpeechAudio(
            clips=(), is_fixture=True, requests=0, fixture_path=self._fixture(work_dir)
        )

    def _fixture(self, work_dir: Path) -> Path:
        time.sleep(self._delay)
        if self._fail:
            raise ProcessingError(
                "speech_failed", "Speech synthesis failed (development mock failure scenario)."
            )
        output = work_dir / "speech.mp3"
        shutil.copyfile(FIXTURE_MP3, output)
        return output
