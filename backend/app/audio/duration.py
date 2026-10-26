"""Exact-length PCM handling for duration fitting: the duration report and the final conform.

`atempo` (FFmpeg) changes the tempo but its output length is only approximately
source/factor: it works in overlapping windows, so the length can be off by up to about one
window. After measuring the real output, `conform_wav` makes the sample count exactly the
target. It only appends silence or removes trailing samples that are verified to be silent;
it never removes audible audio. The amounts are reported, not hidden.
"""

import array
import sys
import wave
from dataclasses import asdict, dataclass
from pathlib import Path

from app.audio.speed import AudioSpeed
from app.audio.wav import InvalidAudioError, WavInfo, read_wav_info, write_silent_frames

# `atempo` analyses 2048-sample windows (hop 1024). A residual of at most one window is the
# rounding of that filter; anything larger means the tempo was not realised and is an error.
ROUNDING_LIMIT_FRAMES = 2048
# Trailing samples may be removed only when each is at most this loud (about -60 dBFS):
# digital silence and noise floor, not speech.
TRIMMABLE_PEAK = 32
_BLOCK_FRAMES = 1 << 18


@dataclass(frozen=True)
class DurationReport:
    """What was measured on the real audio, in samples (exact) at `sample_rate`."""

    sample_rate: int
    # Baseline from the timestamps (last - first sentence start), the speed the user chose
    # and the resulting output length: round_half_up(baseline * sample_rate / speed) samples.
    baseline_seconds: int
    speed: AudioSpeed
    target_samples: int
    # Natural length of the speech before any change.
    source_samples: int
    # PCM after tempo change and the final conform; equals the target (see `target_samples`).
    processed_samples: int
    # Tempo factor applied to the whole audio (>1 faster, <1 slower); None when the speech
    # was already within one rounding window of the target and only silence was adjusted.
    tempo_factor: float | None
    tempo_passes: int
    padded_samples: int
    trimmed_samples: int
    # Final MP3, three ways. Decoded: samples a decoder yields (what a player plays). Header:
    # playable samples declared by the MP3's own gapless fields (frames - delay - padding). Both
    # must equal the target. Container: ffprobe's format duration, reported as is; some FFmpeg
    # versions include the encoder delay and padding in it (a few hundredths of a second more),
    # so it is not used to accept or reject the file.
    mp3_decoded_samples: int
    mp3_header_samples: int
    mp3_container_seconds: float
    # Samples by which the header's end padding was raised so that the header says what was
    # encoded (FFmpeg's muxer caps the padding it writes); 0 when it was already exact.
    mp3_padding_adjusted_samples: int = 0

    @property
    def target_seconds(self) -> float:
        return self.target_samples / self.sample_rate

    def seconds(self, samples: int) -> float:
        return samples / self.sample_rate

    def as_dict(self) -> dict:
        return {
            **{key: value for key, value in asdict(self).items() if key != "speed"},
            "speed": self.speed.number,
            "target_seconds": self.target_seconds,
            "source_seconds": self.seconds(self.source_samples),
            "processed_seconds": self.seconds(self.processed_samples),
            "mp3_decoded_seconds": self.seconds(self.mp3_decoded_samples),
            "mp3_header_seconds": self.seconds(self.mp3_header_samples),
        }


def tail_is_silent(path: Path, info: WavInfo, frames: int) -> bool:
    """True when the last `frames` frames of the WAV are all quiet enough to be dropped."""
    if info.format.sample_width != 2:
        raise InvalidAudioError("only 16-bit audio is supported")
    remaining = min(frames, info.frames)
    position = info.frames - remaining
    with path.open("rb") as handle:
        handle.seek(info.data_offset + position * info.format.frame_bytes)
        while remaining:
            count = min(_BLOCK_FRAMES, remaining)
            block = handle.read(count * info.format.frame_bytes)
            if len(block) != count * info.format.frame_bytes:
                raise InvalidAudioError("audio ended unexpectedly")
            samples = array.array("h")
            samples.frombytes(block)
            if sys.byteorder == "big":
                samples.byteswap()
            if samples and max(max(samples), -min(samples)) > TRIMMABLE_PEAK:
                return False
            remaining -= count
    return True


def silent_tail_frames(path: Path, info: WavInfo) -> int:
    """How many frames at the end of the WAV are quiet enough to be dropped (`TRIMMABLE_PEAK`)."""
    if info.format.sample_width != 2 or info.format.channels != 1:
        raise InvalidAudioError("only 16-bit mono audio is supported")
    silent = 0
    end = info.frames
    with path.open("rb") as handle:
        while end:
            count = min(_BLOCK_FRAMES, end)
            handle.seek(info.data_offset + (end - count) * info.format.frame_bytes)
            block = handle.read(count * info.format.frame_bytes)
            if len(block) != count * info.format.frame_bytes:
                raise InvalidAudioError("audio ended unexpectedly")
            samples = array.array("h")
            samples.frombytes(block)
            if sys.byteorder == "big":
                samples.byteswap()
            for index in range(count - 1, -1, -1):
                if abs(samples[index]) > TRIMMABLE_PEAK:
                    return silent + (count - 1 - index)
            silent += count
            end -= count
    return silent


def conform_wav(source: Path, info: WavInfo, output: Path, target_frames: int) -> tuple[int, int]:
    """Write `source` with exactly `target_frames` frames; returns (padded, trimmed) frames.

    A short source gets silence appended; a long one loses frames from the end. The caller
    decides, beforehand, that this is allowed (see `ROUNDING_LIMIT_FRAMES`, `tail_is_silent`).
    """
    keep = min(info.frames, target_frames)
    frame_bytes = info.format.frame_bytes
    with wave.open(str(output), "wb") as target, source.open("rb") as handle:
        target.setnchannels(info.format.channels)
        target.setsampwidth(info.format.sample_width)
        target.setframerate(info.format.sample_rate)
        handle.seek(info.data_offset)
        remaining = keep
        while remaining:
            count = min(_BLOCK_FRAMES, remaining)
            block = handle.read(count * frame_bytes)
            if len(block) != count * frame_bytes:
                raise InvalidAudioError("audio ended unexpectedly")
            target.writeframes(block)
            remaining -= count
        write_silent_frames(target, target_frames - keep, frame_bytes)
    written = read_wav_info(output)
    if written.frames != target_frames:
        raise InvalidAudioError("conformed audio has the wrong length")
    return target_frames - keep, info.frames - keep
