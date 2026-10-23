"""Synthetic audio for tests: real WAV files, no Azure involved."""

import array
import io
import math
import struct
import sys
import wave
import xml.etree.ElementTree as ET
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


def wav_bytes(samples: "array.array", rate: int = RATE) -> bytes:
    """Mono 16-bit PCM WAV holding `samples`."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        data = array.array("h", samples)
        if sys.byteorder == "big":
            data.byteswap()
        handle.writeframes(data.tobytes())
    return buffer.getvalue()


def tone_samples(seconds: float, frequency: float, rate: int = RATE, amplitude: int = 12000):
    """Sine samples; each tone starts and ends at zero phase so segments join without a click."""
    count = int(seconds * rate)
    return array.array(
        "h", (int(amplitude * math.sin(2 * math.pi * frequency * n / rate)) for n in range(count))
    )


def segments_wav(segments: list[tuple[float, float]], rate: int = RATE) -> bytes:
    """Tones one after another as (frequency, seconds); frequency 0 is silence.

    A stand-in for speech whose order and end can be checked after a tempo change: every
    segment has its own pitch, and the last one ends exactly at the end of the audio.
    """
    samples = array.array("h")
    for frequency, seconds in segments:
        if frequency:
            samples.extend(tone_samples(seconds, frequency, rate))
        else:
            samples.extend(array.array("h", bytes(int(seconds * rate) * 2)))
    return wav_bytes(samples, rate)


def read_samples(path: Path) -> array.array:
    with wave.open(str(path), "rb") as handle:
        samples = array.array("h")
        samples.frombytes(handle.readframes(handle.getnframes()))
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def dominant_frequency(
    samples: "array.array", start: int, count: int, expected: float, rate: int = RATE
) -> float:
    """The frequency within 20% of `expected` with the most energy in samples[start:start+count].

    A Goertzel scan in 1 Hz steps. Counting zero crossings would be fooled by the small
    seams a tempo change leaves in a pure tone; the spectrum is not.
    """
    window = samples[start : start + count]
    best_power, best_frequency = -1.0, 0.0
    for frequency in range(int(expected * 0.8), int(expected * 1.2) + 1):
        coefficient = 2 * math.cos(2 * math.pi * frequency / rate)
        previous = before = 0.0
        for value in window:
            previous, before = coefficient * previous - before + value, previous
        power = previous * previous + before * before - coefficient * previous * before
        if power > best_power:
            best_power, best_frequency = power, float(frequency)
    return best_frequency


def last_loud_index(samples: "array.array", threshold: int = 2000) -> int:
    for index in range(len(samples) - 1, -1, -1):
        if abs(samples[index]) > threshold:
            return index
    return -1


# --- SSML requests as sent to Azure Speech ---

NS = {"s": "http://www.w3.org/2001/10/synthesis"}
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"


def ssml_voice(content: bytes) -> ET.Element:
    return ET.fromstring(content).find("s:voice", NS)


def ssml_text(content: bytes) -> str:
    """The text a voice would read: all span texts, in order."""
    return "".join(ssml_voice(content).itertext())


def ssml_spans(content: bytes) -> list[tuple[str, str]]:
    """(language, text) of every span of the single voice."""
    return [(span.get(XML_LANG), span.text or "") for span in ssml_voice(content)]
