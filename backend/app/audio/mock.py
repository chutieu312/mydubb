import shutil
import time
from pathlib import Path

from app.audio.base import ProcessedAudio
from app.processing_errors import ProcessingError
from app.speech.base import SpeechAudio


class MockAudioProcessor:
    """Passes audio through unchanged. Does NOT adjust duration."""

    name = "mock-audio"

    def __init__(self, *, fail: bool = False, delay: float = 0.0) -> None:
        self._fail = fail
        self._delay = delay

    def close(self) -> None:
        pass

    def fit_to_duration(
        self, speech: SpeechAudio, target_seconds: int, work_dir: Path
    ) -> ProcessedAudio:
        time.sleep(self._delay)
        if self._fail:
            raise ProcessingError(
                "audio_processing_failed",
                "Audio processing failed (development mock failure scenario).",
            )
        output = work_dir / "final.mp3"
        shutil.copyfile(speech.path, output)
        return ProcessedAudio(path=output, duration_adjusted=False)
