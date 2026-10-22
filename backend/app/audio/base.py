from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class ProcessedAudio:
    path: Path  # final MP3 inside the work directory
    # True only when the output was actually adjusted to the target duration.
    duration_adjusted: bool
    duration_seconds: float | None


class AudioProcessor(Protocol):
    """Turns synthesized speech into the final MP3 at the target duration.

    The real implementation (later milestone) uses FFmpeg to change the tempo of the
    complete audio so its length equals the target duration.
    """

    name: str

    def fit_to_duration(
        self, speech_audio: Path, target_seconds: int, work_dir: Path
    ) -> ProcessedAudio: ...
