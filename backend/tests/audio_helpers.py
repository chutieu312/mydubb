"""Synthetic audio for tests: real WAV files, no Azure involved."""

import io
import math
import struct
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
