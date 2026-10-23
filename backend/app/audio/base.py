from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.audio.duration import DurationReport
from app.speech.base import SpeechAudio


@dataclass(frozen=True)
class ProcessedAudio:
    path: Path  # final MP3 inside the work directory
    # True only when the output was actually adjusted to the target duration.
    duration_adjusted: bool
    # What was measured on the real output; None when the duration was not adjusted.
    duration_report: DurationReport | None = None


class AudioProcessor(Protocol):
    """Turns synthesized speech into the final MP3 at the target duration.

    The real implementation uses FFmpeg to change the tempo of the complete audio so that its
    length equals the target duration, starting from the speech provider's lossless audio.
    """

    name: str

    def fit_to_duration(
        self, speech: SpeechAudio, target_seconds: int, work_dir: Path
    ) -> ProcessedAudio: ...

    def close(self) -> None:
        """Cancel running work (server shutdown); later and running calls fail safely."""
        ...
