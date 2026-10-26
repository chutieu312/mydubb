"""Timed dubbing: speech clips placed in their frames of the output timeline.

The frames come from `transcript/timed.py` (`TimedTranscript.boundaries`): block `i` is planned
from sample `boundaries[i]` to `boundaries[i + 1]`, and the last boundary is the exact target of
`audio/speed.py`. Every length below is a difference of two rounded boundaries, so nothing drifts
however many blocks there are, and the joined audio has exactly the target length.

First, frames whose speech would need an extreme tempo are grouped with a neighbour
(`audio/grouping.py`): the blocks of a group share one frame, from the first block's boundary to
the end of the last one's, and the clips are read one after another in it. Then per frame (the
clip is the lossless WAV the speech provider made for the block's text, or the group's clips
joined):

* **Shorter than its frame**: kept at its natural speed and followed by silence up to the end of
  the frame. It is never slowed down to fill the frame.
* **Longer, but only because of its silent tail** (each trailing sample at most `TRIMMABLE_PEAK`,
  as in `duration.conform_wav`): that silence is dropped, then the frame is filled with silence.
* **Longer with speech**: the tempo of the clip (without its silent tail) is raised with `atempo`,
  which keeps the pitch, aiming `TEMPO_MARGIN_FRAMES` short of the frame so that the filter's
  rounding never pushes it over; then silence fills the frame. A result still too long (unless
  the excess is silent) or far shorter than aimed is processed again from the original clip with
  a corrected factor, up to `MAX_TEMPO_PASSES`, otherwise the job fails. Speech is never cut.

The next frame always starts exactly at its own boundary: a frame cannot push the following ones
later, and audio can never spill into the next frame. All clips that need a tempo change in a pass
go through ONE FFmpeg process (`ffmpeg.change_tempo_many`), so the number of FFmpeg starts does not
grow with the number of blocks.

The boundaries inside a caption are estimates (word count), so a frame is the time its text
probably took in the source, not a measured one. Inside a group, a block starts where the speech
before it ends; `TimelineReport.removed` estimates how far that is from its planned boundary
(computed from the tempo factor, not measured).
"""

import threading
import wave
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path

from app.audio.duration import ROUNDING_LIMIT_FRAMES, silent_tail_frames
from app.audio.ffmpeg import AudioTools, TempoTask, change_tempo_many
from app.audio.grouping import TEMPO_TARGET, group_frames, relative_target
from app.audio.wav import (
    InvalidAudioError,
    PcmFormat,
    WavInfo,
    concat_wavs,
    read_wav_info,
    write_silent_frames,
)

# How far short of its frame a sped-up clip aims (about 43 ms at 24 kHz): `atempo` misses the
# exact length by tens to a few hundred samples, and a miss must land on the silent side.
TEMPO_MARGIN_FRAMES = 1024
MAX_TEMPO_PASSES = 6
# Clips per FFmpeg process: bounds the open files of one process; more clips use more processes.
MAX_CLIPS_PER_PROCESS = 64
_COPY_BLOCK_BYTES = 1024 * 1024


class TimelineNotReached(Exception):
    """A clip could not be fitted into its frame without cutting speech."""


@dataclass(frozen=True)
class BlockFit:
    """What happened in one frame of the timeline (one block, or a group of blocks)."""

    first_block: int
    last_block: int  # inclusive
    frame_samples: int
    source_samples: int  # natural length of the clip(s)
    audible_samples: int  # without the silent tail: what has to be heard
    trimmed_samples: int  # silent tail dropped (never speech)
    tempo_factor: float | None  # None: natural speed
    tempo_passes: int
    fitted_samples: int  # after the tempo change (or the natural speech)
    padded_samples: int  # silence after it, up to the end of the frame

    @property
    def ratio(self) -> float:
        return self.audible_samples / self.frame_samples

    def as_dict(self) -> dict:
        return {
            "first_block": self.first_block,
            "last_block": self.last_block,
            "frame_samples": self.frame_samples,
            "source_samples": self.source_samples,
            "audible_samples": self.audible_samples,
            "trimmed_samples": self.trimmed_samples,
            "tempo_factor": self.tempo_factor,
            "tempo_passes": self.tempo_passes,
            "fitted_samples": self.fitted_samples,
            "padded_samples": self.padded_samples,
        }


@dataclass(frozen=True)
class RemovedBoundary:
    """A block start that grouping removed: where it was planned and where its speech is ESTIMATED
    to start (the group's start plus the clips before it divided by the group's tempo factor; not
    measured on the audio, and `atempo` does not stretch every part of a clip exactly evenly)."""

    block: int
    planned_sample: int
    estimated_sample: int


@dataclass(frozen=True)
class TimelineReport:
    sample_rate: int
    boundaries: list[int]  # planned, one per block plus the end
    block_ratios: list[float]  # each block alone: audible / frame (inf for a zero frame)
    frames: list[BlockFit]  # after grouping
    removed: list[RemovedBoundary] = field(default_factory=list)
    grouping_enabled: bool = True
    grouping_target: float = TEMPO_TARGET

    @property
    def unresolved(self) -> list[BlockFit]:
        """Frames still above the tempo warning level after grouping."""
        return [f for f in self.frames if (f.tempo_factor or 0) > TEMPO_TARGET]

    def as_dict(self) -> dict:
        displacement = [abs(r.estimated_sample - r.planned_sample) for r in self.removed]
        return {
            "sample_rate": self.sample_rate,
            "blocks": len(self.block_ratios),
            "frames": len(self.frames),
            "grouping_enabled": self.grouping_enabled,
            "grouping_target": self.grouping_target,
            "tempo_warning_level": TEMPO_TARGET,
            "boundaries": self.boundaries,
            "block_ratios": [None if r == float("inf") else r for r in self.block_ratios],
            "frame_fits": [f.as_dict() for f in self.frames],
            "removed_boundaries": [
                {
                    "block": r.block,
                    "planned_sample": r.planned_sample,
                    "estimated_sample": r.estimated_sample,
                }
                for r in self.removed
            ],
            "estimated_max_displacement_seconds": max(displacement, default=0) / self.sample_rate,
            "frames_over_warning_level": len(self.unresolved),
        }


@dataclass
class _Frame:
    first_block: int
    last_block: int
    samples: int
    clip: Path
    info: WavInfo
    keep: int = 0  # samples of the clip without its silent tail
    fitted: Path | None = None
    fitted_frames: int = 0
    factor: float | None = None
    passes: int = 0


def fit_timeline(
    tools: AudioTools,
    clips: list[Path],
    boundaries: list[int],
    scratch: Path,
    output: Path,
    *,
    grouping: bool = True,
    relative: bool = False,
    cancel: threading.Event | None = None,
) -> TimelineReport:
    """Write `output` (PCM WAV of exactly `boundaries[-1]` samples) from one clip per block."""
    if len(boundaries) != len(clips) + 1 or boundaries[0] != 0:
        raise ValueError("one boundary per block plus the end, starting at 0")
    if any(later < earlier for earlier, later in pairwise(boundaries)):
        raise ValueError("boundaries must not decrease")
    infos = [read_wav_info(clip) for clip in clips]
    pcm = infos[0].format
    if pcm.sample_width != 2 or pcm.channels != 1 or any(i.format != pcm for i in infos):
        raise InvalidAudioError("clips must share one 16-bit mono format")

    frame_lengths = [b - a for a, b in pairwise(boundaries)]
    clip_samples = [info.frames for info in infos]
    audible = [
        info.frames - silent_tail_frames(clip, info)
        for clip, info in zip(clips, infos, strict=True)
    ]
    target = relative_target(frame_lengths, clip_samples, audible) if relative else TEMPO_TARGET
    plan = group_frames(
        frame_lengths, clip_samples, audible, pcm.sample_rate, enabled=grouping, target=target
    )
    frames = _frames(plan.groups, clips, infos, boundaries, scratch, pcm)
    for frame in frames:
        frame.keep = frame.info.frames - silent_tail_frames(frame.clip, frame.info)
        if frame.info.frames <= frame.samples or frame.keep <= frame.samples:
            frame.fitted, frame.fitted_frames = frame.clip, min(frame.info.frames, frame.samples)
        else:
            frame.factor = frame.keep / _aim(frame.samples)
    _change_tempo(tools, [f for f in frames if f.factor is not None], scratch, cancel)
    _join(frames, pcm, output)
    if read_wav_info(output).frames != boundaries[-1]:
        raise InvalidAudioError("joined timeline has the wrong length")

    fits = [
        BlockFit(
            first_block=frame.first_block,
            last_block=frame.last_block,
            frame_samples=frame.samples,
            source_samples=frame.info.frames,
            audible_samples=frame.keep,
            trimmed_samples=frame.info.frames - frame.keep
            if frame.factor is not None
            else max(0, frame.info.frames - frame.samples),
            tempo_factor=frame.factor,
            tempo_passes=frame.passes,
            fitted_samples=frame.fitted_frames,
            padded_samples=frame.samples - frame.fitted_frames,
        )
        for frame in frames
    ]
    return TimelineReport(
        sample_rate=pcm.sample_rate,
        boundaries=list(boundaries),
        block_ratios=[
            a / f if f else float("inf") for a, f in zip(audible, frame_lengths, strict=True)
        ],
        frames=fits,
        removed=_removed(frames, boundaries, clip_samples),
        grouping_enabled=grouping,
        grouping_target=target,
    )


def _aim(frame_samples: int) -> int:
    return max(frame_samples - TEMPO_MARGIN_FRAMES, (frame_samples + 1) // 2, 1)


def _frames(
    groups: list[tuple[int, int]],
    clips: list[Path],
    infos: list[WavInfo],
    boundaries: list[int],
    scratch: Path,
    pcm: PcmFormat,
) -> list[_Frame]:
    frames = []
    for first, last in groups:
        if first == last:
            clip, info = clips[first], infos[first]
        else:
            clip = scratch / f"group-{first:05d}-{last:05d}.wav"
            concat_wavs(clips[first : last + 1], clip, pcm)
            info = read_wav_info(clip)
        frames.append(_Frame(first, last, boundaries[last + 1] - boundaries[first], clip, info))
    return frames


def _removed(
    frames: list[_Frame], boundaries: list[int], clip_samples: list[int]
) -> list[RemovedBoundary]:
    """Where each block inside a group is estimated to start: the group's start plus the clips
    before it, at the group's tempo (not measured)."""
    removed = []
    for frame in frames:
        offset = 0
        for block in range(frame.first_block + 1, frame.last_block + 1):
            offset += clip_samples[block - 1]
            played = offset / frame.factor if frame.factor else offset
            removed.append(
                RemovedBoundary(
                    block=block,
                    planned_sample=boundaries[block],
                    estimated_sample=boundaries[frame.first_block] + round(played),
                )
            )
    return removed


def _change_tempo(
    tools: AudioTools, pending: list[_Frame], scratch: Path, cancel: threading.Event | None
) -> None:
    for attempt in range(1, MAX_TEMPO_PASSES + 1):
        if not pending:
            return
        tasks = []
        for frame in pending:
            frame.passes = attempt
            frame.fitted = scratch / f"tempo-{frame.first_block:05d}-{attempt}.wav"
            rate = frame.info.format.sample_rate
            tasks.append(TempoTask(frame.clip, frame.fitted, frame.factor, frame.keep, rate))
        for start in range(0, len(tasks), MAX_CLIPS_PER_PROCESS):
            change_tempo_many(tools, tasks[start : start + MAX_CLIPS_PER_PROCESS], cancel=cancel)
        retry = []
        for frame in pending:
            info = read_wav_info(frame.fitted)
            if info.format != frame.info.format:
                raise InvalidAudioError("tempo change altered the audio format")
            aim = _aim(frame.samples)
            excess = info.frames - frame.samples
            fits = excess <= 0 or silent_tail_frames(frame.fitted, info) >= excess
            if fits and info.frames >= aim - ROUNDING_LIMIT_FRAMES:
                frame.fitted_frames = min(info.frames, frame.samples)
                continue
            # Correct the factor from the measurement; the ORIGINAL clip is processed again.
            frame.factor *= info.frames / aim
            retry.append(frame)
        pending = retry
    if pending:
        raise TimelineNotReached


def _join(frames: list[_Frame], pcm: PcmFormat, output: Path) -> None:
    """Each frame's audio (at most the frame long), then silence to the frame's end."""
    with wave.open(str(output), "wb") as target:
        target.setnchannels(pcm.channels)
        target.setsampwidth(pcm.sample_width)
        target.setframerate(pcm.sample_rate)
        for frame in frames:
            assert frame.fitted is not None
            info = read_wav_info(frame.fitted)
            take = frame.fitted_frames
            with frame.fitted.open("rb") as handle:
                handle.seek(info.data_offset)
                remaining = take * pcm.frame_bytes
                while remaining:
                    block = handle.read(min(_COPY_BLOCK_BYTES, remaining))
                    if not block:
                        raise InvalidAudioError("audio ended unexpectedly")
                    target.writeframes(block)
                    remaining -= len(block)
            write_silent_frames(target, frame.samples - take, pcm.frame_bytes)
