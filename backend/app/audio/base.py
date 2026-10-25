from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.audio.duration import DurationReport
from app.audio.speed import DurationTarget, TimelinePlan
from app.audio.timeline import TimelineReport
from app.speech.base import SpeechAudio, TimedSpeechAudio


@dataclass(frozen=True)
class ProcessedAudio:
    path: Path  # final MP3 inside the work directory
    # True only when the output was actually adjusted to the target duration.
    duration_adjusted: bool
    # What was measured on the real output; None when the duration was not adjusted.
    duration_report: DurationReport | None = None
    # Timed mode: what happened in each frame of the timeline; None in plain mode.
    timeline: TimelineReport | None = None


class AudioProcessor(Protocol):
    """Turns synthesized speech into the final MP3 at the target duration.

    The target is the baseline from the timestamps divided by the chosen speed (a whole number
    of samples, see audio/speed.py). The real implementation uses FFmpeg to change the tempo of
    the complete audio so that its length equals the target, starting from the speech
    provider's lossless audio.
    """

    name: str

    def fit_to_duration(
        self, speech: SpeechAudio, target: DurationTarget, work_dir: Path
    ) -> ProcessedAudio: ...

    def fit_timeline(
        self, speech: TimedSpeechAudio, plan: TimelinePlan, work_dir: Path
    ) -> ProcessedAudio:
        """Timed mode: each block's clip in its own frame of the target (audio/timeline.py)."""
        ...

    def close(self) -> None:
        """Cancel running work (server shutdown); later and running calls fail safely."""
        ...
