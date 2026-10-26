"""Reading and joining 16-bit PCM WAV files (the uncompressed audio before MP3 encoding).

Speech chunks are concatenated as decoded samples, never as raw bytes of an encoded file.
The header parser is strict on purpose: a truncated download or a different format must not
become part of the result.
"""

import struct
import wave
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

_COPY_BLOCK_BYTES = 1024 * 1024
# A streaming encoder may write 0 or 0xFFFFFFFF as the data size because it is unknown.
_UNKNOWN_SIZES = (0, 0xFFFFFFFF)
_PCM = 1
# Silence is written in blocks of at most this many bytes, all taken from one preallocated buffer,
# so a long silence never needs memory of its own size (a 3-hour frame of 24 kHz 16-bit mono
# audio is about 500 MB).
SILENCE_BLOCK_BYTES = 1024 * 1024
_ZEROS = memoryview(bytes(SILENCE_BLOCK_BYTES))


class FrameWriter(Protocol):
    """What `write_silent_frames` needs: `wave.Wave_write` or a test double."""

    def writeframes(self, data: bytes | memoryview) -> None: ...


class InvalidAudioError(ValueError):
    """The file is not the expected WAV audio. The message never contains file content."""


@dataclass(frozen=True)
class PcmFormat:
    sample_rate: int
    channels: int
    sample_width: int  # bytes per sample

    @property
    def frame_bytes(self) -> int:
        return self.channels * self.sample_width


@dataclass(frozen=True)
class WavInfo:
    format: PcmFormat
    data_offset: int
    data_bytes: int

    @property
    def frames(self) -> int:
        return self.data_bytes // self.format.frame_bytes

    @property
    def duration_seconds(self) -> float:
        return self.frames / self.format.sample_rate


def read_wav_info(path: Path) -> WavInfo:
    """Validate the header of a PCM WAV file and locate its samples."""
    size = path.stat().st_size
    with path.open("rb") as handle:
        riff = handle.read(12)
        if len(riff) < 12 or riff[:4] != b"RIFF" or riff[8:12] != b"WAVE":
            raise InvalidAudioError("not a RIFF/WAVE file")
        fmt: PcmFormat | None = None
        while True:
            header = handle.read(8)
            if len(header) < 8:
                raise InvalidAudioError("no audio data chunk")
            chunk_id, chunk_size = struct.unpack("<4sI", header)
            if chunk_id == b"data":
                if fmt is None:
                    raise InvalidAudioError("audio data before the format chunk")
                offset = handle.tell()
                available = size - offset
                if chunk_size in _UNKNOWN_SIZES:
                    chunk_size = available
                elif chunk_size > available:
                    raise InvalidAudioError("audio data is shorter than its header declares")
                chunk_size -= chunk_size % fmt.frame_bytes
                if chunk_size == 0:
                    raise InvalidAudioError("audio data is empty")
                return WavInfo(fmt, offset, chunk_size)
            if chunk_id == b"fmt ":
                fmt = _parse_format(handle.read(chunk_size), chunk_size)
            else:
                handle.seek(chunk_size, 1)
            if chunk_size % 2:
                handle.seek(1, 1)  # chunks are padded to an even size


def _parse_format(body: bytes, declared: int) -> PcmFormat:
    if declared < 16 or len(body) < 16:
        raise InvalidAudioError("invalid format chunk")
    tag, channels, rate, _byte_rate, _align, bits = struct.unpack("<HHIIHH", body[:16])
    if tag != _PCM or bits % 8 or not channels or not rate:
        raise InvalidAudioError("not uncompressed PCM audio")
    return PcmFormat(sample_rate=rate, channels=channels, sample_width=bits // 8)


def concat_wavs(sources: Sequence[Path], output: Path, expected: PcmFormat) -> float:
    """Write the samples of `sources`, in order, as one WAV file; returns its duration.

    Every source must have exactly the `expected` format.
    """
    if not sources:
        raise InvalidAudioError("no audio to join")
    infos = [read_wav_info(source) for source in sources]
    if any(info.format != expected for info in infos):
        raise InvalidAudioError("audio chunks have different formats")
    with wave.open(str(output), "wb") as target:
        target.setnchannels(expected.channels)
        target.setsampwidth(expected.sample_width)
        target.setframerate(expected.sample_rate)
        for source, info in zip(sources, infos, strict=True):
            with source.open("rb") as handle:
                handle.seek(info.data_offset)
                remaining = info.data_bytes
                while remaining:
                    block = handle.read(min(_COPY_BLOCK_BYTES, remaining))
                    if not block:
                        raise InvalidAudioError("audio ended unexpectedly")
                    target.writeframes(block)
                    remaining -= len(block)
    return sum(info.frames for info in infos) / expected.sample_rate


def write_silent_frames(target: FrameWriter, frames: int, frame_bytes: int) -> None:
    """Write `frames` silent frames to an open WAV writer, in bounded blocks of whole frames."""
    if frames < 0 or frame_bytes <= 0:
        raise ValueError("frames must not be negative and frame_bytes must be positive")
    block = SILENCE_BLOCK_BYTES - SILENCE_BLOCK_BYTES % frame_bytes
    remaining = frames * frame_bytes
    while remaining:
        count = min(block, remaining)
        target.writeframes(_ZEROS[:count])
        remaining -= count


def write_silence(output: Path, pcm: PcmFormat, frames: int) -> None:
    """A WAV of `frames` silent frames in format `pcm`."""
    with wave.open(str(output), "wb") as target:
        target.setnchannels(pcm.channels)
        target.setsampwidth(pcm.sample_width)
        target.setframerate(pcm.sample_rate)
        write_silent_frames(target, frames, pcm.frame_bytes)
