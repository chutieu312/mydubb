import shutil
import time
from pathlib import Path

from app.processing_errors import ProcessingError
from app.speech.base import SpeechAudio
from app.speech.voices import Voice

FIXTURE_MP3 = Path(__file__).resolve().parent.parent / "audio" / "fixtures" / "mock_audio.mp3"


class MockSpeechProvider:
    """Returns a bundled MP3 fixture regardless of the input text or voice.

    The fixture is NOT generated from the submitted transcript and does not reflect the
    target duration. It only exercises playback and download.
    """

    name = "mock-speech"

    def __init__(self, *, fail: bool = False, delay: float = 0.0) -> None:
        self._fail = fail
        self._delay = delay

    def synthesize(self, text: str, voice: Voice, work_dir: Path) -> SpeechAudio:
        time.sleep(self._delay)
        if self._fail:
            raise ProcessingError(
                "speech_failed", "Speech synthesis failed (development mock failure scenario)."
            )
        output = work_dir / "speech.mp3"
        shutil.copyfile(FIXTURE_MP3, output)
        return SpeechAudio(path=output, is_fixture=True)
