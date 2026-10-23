"""Runs INSIDE the built image (docker exec -i <container> python - < this file).

Proves that the runtime image has what Azure Speech output needs: FFmpeg with the MP3
encoder, ffprobe, and the application's audio code. Azure is replaced by a fake HTTP
transport serving synthetic tones, so no credentials or network are involved.
"""

import io
import math
import struct
import tempfile
import wave
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx
from pydantic import SecretStr

from app.audio.ffmpeg import locate_tools, probe_mp3
from app.speech.azure import AzureSpeechProvider
from app.speech.rate_limit import RequestRateLimiter
from app.speech.voices import Voice
from app.translation.glossary import default_glossary

NS = {"s": "http://www.w3.org/2001/10/synthesis"}


def tone(seconds: float) -> bytes:
    rate = 24000
    frames = b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * n / rate)))
        for n in range(int(seconds * rate))
    )
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(frames)
    return buffer.getvalue()


requests = []
served_seconds = []


def fake_azure(request: httpx.Request) -> httpx.Response:
    text = "".join(ET.fromstring(request.content).find("s:voice", NS).itertext())
    requests.append(text)
    seconds = len(text) / 15  # about the pace of speech, so the audio looks plausible
    served_seconds.append(seconds)
    return httpx.Response(200, content=tone(seconds))


tools = locate_tools()
assert tools is not None, "ffmpeg/ffprobe missing from the image"
provider = AzureSpeechProvider(
    key=SecretStr("fake-key"),
    region="westus2",
    glossary=default_glossary(),
    tools=tools,
    limiter=RequestRateLimiter(20, 60),
    timeout_seconds=30,
    max_chunk_chars=200,
    transport=httpx.MockTransport(fake_azure),
)
text = " ".join(f"Câu số {i} nói về neural network và loss function." for i in range(12))
with tempfile.TemporaryDirectory() as work:
    audio = provider.synthesize(text, Voice.EMMA, Path(work))
    duration = probe_mp3(tools, audio.path)
    head = audio.path.read_bytes()[:2048]
    assert len(requests) > 2, "expected several chunks"
    assert abs(duration - sum(served_seconds)) < 0.5, (duration, sum(served_seconds))
    assert b"Info" in head or b"Xing" in head, "no seek header in the MP3"
print(f"speech runtime OK: {len(requests)} chunks joined into a {duration:.1f} s MP3")
