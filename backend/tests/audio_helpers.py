"""Synthetic audio for tests: real WAV files, no Azure involved."""

import io
import math
import struct
import wave
from functools import lru_cache
from pathlib import Path

RATE = 24000


@lru_cache(maxsize=32)
def _one_second(frequency: float, rate: int) -> bytes:
    samples = [int(8000 * math.sin(2 * math.pi * frequency * n / rate)) for n in range(rate)]
    return struct.pack(f"<{rate}h", *samples)


def make_wav(seconds: float, frequency: float = 440.0, rate: int = RATE) -> bytes:
    """Mono 16-bit PCM WAV of a sine tone (the format Azure is asked for)."""
    full, rest = divmod(int(seconds * rate), rate)
    second = _one_second(frequency, rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(second * full + second[: rest * 2])
    return buffer.getvalue()


def wav_samples(path: Path) -> bytes:
    with wave.open(str(path), "rb") as handle:
        return handle.readframes(handle.getnframes())
