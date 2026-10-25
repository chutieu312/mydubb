import shutil
import time
from pathlib import Path

from app.audio.base import ProcessedAudio
from app.audio.speed import DurationTarget, TimelinePlan
from app.processing_errors import ProcessingError
from app.speech.base import SpeechAudio, TimedSpeechAudio


class MockAudioProcessor:
    """Passes audio through unchanged. Does NOT adjust duration, whatever speed was chosen."""

    name = "mock-audio"

    def __init__(self, *, fail: bool = False, delay: float = 0.0) -> None:
        self._fail = fail
        self._delay = delay

    def close(self) -> None:
        pass

    def fit_to_duration(
        self, speech: SpeechAudio, target: DurationTarget, work_dir: Path
    ) -> ProcessedAudio:
        return self._pass_through(speech.path, work_dir)

    def fit_timeline(
        self, speech: TimedSpeechAudio, plan: TimelinePlan, work_dir: Path
    ) -> ProcessedAudio:
        """Timed mode: the fixture (or the first clip) unchanged; nothing is placed or fitted."""
        source = speech.fixture_path or (speech.clips[0] if speech.clips else None)
        if source is None:
            raise ProcessingError("audio_source_missing", "No audio to pass through.")
        return self._pass_through(source, work_dir)

    def _pass_through(self, source: Path, work_dir: Path) -> ProcessedAudio:
        time.sleep(self._delay)
        if self._fail:
            raise ProcessingError(
                "audio_processing_failed",
                "Audio processing failed (development mock failure scenario).",
            )
        output = work_dir / "final.mp3"
        shutil.copyfile(source, output)
        return ProcessedAudio(path=output, duration_adjusted=False)
