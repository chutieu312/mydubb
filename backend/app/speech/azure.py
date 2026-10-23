"""Azure Speech text to speech over the REST API: Vietnamese text -> one MP3.

REST rather than the Speech SDK, checked against Microsoft Learn on 2026-10-22:

* Microsoft recommends the SDK where it can be used, but the Python SDK is a native
  (C++) library with extra system packages and a large wheel, and its streaming/event
  features are not needed for "SSML in, audio file out". The REST API is one HTTPS POST,
  needs only the HTTP client already in use for Translator, and runs unchanged in the slim
  Docker image on Render.
* `POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1` with
  `Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`,
  `X-Microsoft-OutputFormat` and `User-Agent`. Status codes: 400, 401, 415, 429, 502, 503.
* Limits that apply to this REST path: 20 transactions per 60 seconds on a Free (F0)
  resource (30 TPS on S0), and a maximum of 10 minutes of audio per request: longer audio is
  silently TRUNCATED to 10 minutes, with a normal 200 response. Chunks are therefore far
  below that, and a result near 10 minutes is rejected instead of being accepted as complete.
  The 64 KB SSML limit in the same table is for WebSocket and is not applied here.
* Voices are `en-US-AndrewMultilingualNeural` / `en-US-EmmaMultilingualNeural`. One `<voice>`
  per request holds `<lang xml:lang="vi-VN">` spans for Vietnamese and `<lang xml:lang="en-US">`
  spans for glossary terms (see `ssml.py`); the same speaker reads both.
* `riff-24khz-16bit-mono-pcm` is requested so chunks can be joined as samples and encoded once
  to MP3 (see `app/audio`); MP3/WAV files are never concatenated byte for byte.

Failures raise ProcessingError with user-safe messages. Requests are never retried (the
quota is small and the outcome of a timed-out call is unknown), there is no fallback to the
mock, and a job with one failed chunk fails as a whole: no partial audio is returned. The key,
SSML, text and response bodies are never logged.
"""

import logging
import re
import shutil
import tempfile
import time
from pathlib import Path

import httpx
from pydantic import SecretStr

from app.audio.ffmpeg import AudioToolError, AudioTools, encode_mp3, probe_mp3
from app.audio.wav import InvalidAudioError, PcmFormat, concat_wavs, read_wav_info
from app.processing_errors import ProcessingError
from app.speech.base import SpeechAudio
from app.speech.chunker import SpeechTextTooLongError, split_for_speech
from app.speech.rate_limit import RateLimiterClosed, RequestRateLimiter
from app.speech.ssml import build_ssml
from app.speech.voices import Voice
from app.translation.glossary import Glossary

logger = logging.getLogger(__name__)

OUTPUT_FORMAT = "riff-24khz-16bit-mono-pcm"
PCM_FORMAT = PcmFormat(sample_rate=24000, channels=1, sample_width=2)
USER_AGENT = "MyDubb"
# The service truncates audio at 10 minutes without an error. A chunk this close to the
# limit may have been cut, so it is treated as invalid.
SERVICE_MAX_AUDIO_SECONDS = 600.0
SUSPECT_TRUNCATION_SECONDS = 590.0
# A response is at most 10 minutes of 24 kHz 16-bit mono audio; this only guards the disk.
MAX_RESPONSE_BYTES = int(SERVICE_MAX_AUDIO_SECONDS * 48_000 * 1.1) + 1_000_000
# Speech faster than this many characters per second does not exist: the audio was cut.
MAX_PLAUSIBLE_CHARS_PER_SECOND = 50.0
MIN_CHARS_FOR_RATE_CHECK = 40
# The MP3 duration may differ slightly from the PCM duration (encoder delay and padding).
MP3_DURATION_TOLERANCE_SECONDS = 1.0

_REQUEST_ID = re.compile(r"[0-9A-Za-z-]{1,64}")

_MESSAGES = {
    "speech_auth_failed": (
        "The speech service rejected this server's credentials or denied access. This is a "
        "server configuration problem, not an issue with your transcript. Please tell the "
        "administrator."
    ),
    "speech_quota_exceeded": (
        "The speech service's quota or rate limit was reached. Please wait a few minutes and "
        "submit again."
    ),
    "speech_timeout": "The speech service did not answer in time. Please submit again.",
    "speech_network_error": (
        "The speech service could not be reached. Please submit again in a moment."
    ),
    "speech_service_error": (
        "The speech service had a temporary problem. Please submit again in a moment."
    ),
    "speech_rejected": (
        "The speech service rejected the request. Please submit again; if it keeps failing, "
        "tell the administrator."
    ),
    "speech_invalid_audio": (
        "The speech service returned audio that could not be used, so no audio was produced. "
        "Please submit again."
    ),
    "speech_audio_failed": (
        "The audio could not be assembled into an MP3 file. Please submit again; if it keeps "
        "failing, tell the administrator."
    ),
    "speech_cancelled": "Speech generation was cancelled because the server is shutting down.",
    "speech_input_unsupported": (
        "The translated text contains a very long run of text without spaces that cannot be "
        "split for speech. Please add spaces or line breaks and submit again."
    ),
    "speech_no_speakable_text": "The translated text has nothing that can be spoken.",
}


def _failure(code: str) -> ProcessingError:
    return ProcessingError(code, _MESSAGES[code])


def synthesis_url(region: str) -> str:
    return f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"


class AzureSpeechProvider:
    name = "azure-speech"

    def __init__(
        self,
        *,
        key: SecretStr,
        region: str,
        glossary: Glossary,
        tools: AudioTools,
        limiter: RequestRateLimiter,
        timeout_seconds: float,
        max_chunk_chars: int,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._key = key
        self._url = synthesis_url(region)
        self._glossary = glossary
        self._tools = tools
        self._limiter = limiter
        self._timeout = timeout_seconds
        self._max_chunk_chars = max_chunk_chars
        self._transport = transport

    def synthesize(self, text: str, voice: Voice, work_dir: Path) -> SpeechAudio:
        try:
            chunks = split_for_speech(text, self._glossary, self._max_chunk_chars)
        except SpeechTextTooLongError:
            raise _failure("speech_input_unsupported") from None
        # Text with no letter or digit (e.g. only punctuation) has nothing to read aloud.
        chunks = [chunk for chunk in chunks if any(char.isalnum() for char in chunk)]
        if not chunks:
            raise _failure("speech_no_speakable_text")

        wav = work_dir / "speech.wav"
        mp3 = work_dir / "speech.mp3"
        scratch = Path(tempfile.mkdtemp(prefix="speech-", dir=work_dir))
        try:
            chunk_files = self._synthesize_chunks(chunks, voice, scratch)
            duration = self._join_and_encode(chunk_files, wav, mp3)
        except BaseException:
            # Never leave partial audio behind, whatever the failure was.
            wav.unlink(missing_ok=True)
            mp3.unlink(missing_ok=True)
            raise
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        # Counts and sizes only; never content.
        logger.info(
            "Azure Speech finished: requests=%d chars=%d audio_seconds=%.1f",
            len(chunks),
            sum(len(chunk) for chunk in chunks),
            duration,
        )
        return SpeechAudio(path=mp3, is_fixture=False, lossless_path=wav)

    def _synthesize_chunks(self, chunks: list[str], voice: Voice, scratch: Path) -> list[Path]:
        files = []
        timeout = httpx.Timeout(self._timeout, connect=min(10.0, self._timeout))
        with httpx.Client(timeout=timeout, transport=self._transport) as client:
            for index, chunk in enumerate(chunks):
                try:
                    self._limiter.acquire()
                except RateLimiterClosed:
                    raise _failure("speech_cancelled") from None
                target = scratch / f"chunk-{index:05d}.wav"
                self._synthesize_chunk(client, build_ssml(chunk, voice, self._glossary), target)
                self._validate_chunk(target, len(chunk))
                files.append(target)
        return files

    def _synthesize_chunk(self, client: httpx.Client, ssml: str, target: Path) -> None:
        headers = {
            "Ocp-Apim-Subscription-Key": self._key.get_secret_value(),
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
            "User-Agent": USER_AGENT,
        }
        started = time.monotonic()
        try:
            with client.stream(
                "POST", self._url, headers=headers, content=ssml.encode("utf-8")
            ) as response:
                status = response.status_code
                request_id = response.headers.get("X-RequestId", "")
                if status == 200:
                    self._save_body(response, target, started)
        except httpx.TimeoutException:
            logger.warning("Azure Speech request timed out")
            raise _failure("speech_timeout") from None
        except httpx.TransportError as exc:
            logger.warning("Azure Speech request failed: %s", type(exc).__name__)
            raise _failure("speech_network_error") from None
        except httpx.HTTPError as exc:
            logger.warning("Azure Speech request failed: %s", type(exc).__name__)
            raise _failure("speech_service_error") from None
        except OSError as exc:
            logger.warning("Azure Speech audio could not be stored: %s", type(exc).__name__)
            raise _failure("speech_audio_failed") from None
        if status != 200:
            raise self._status_error(status, request_id)

    def _save_body(self, response: httpx.Response, target: Path, started: float) -> None:
        """Stream the audio to disk within the total time and size limits."""
        size = 0
        with target.open("wb") as handle:
            for block in response.iter_bytes():
                size += len(block)
                if size > MAX_RESPONSE_BYTES:
                    logger.warning("Azure Speech response exceeded the size limit")
                    raise _failure("speech_invalid_audio")
                if time.monotonic() - started > self._timeout:
                    raise httpx.ReadTimeout("total time limit exceeded")
                handle.write(block)

    @staticmethod
    def _status_error(status: int, request_id: str) -> ProcessingError:
        logger.warning(
            "Azure Speech returned http_status=%d request_id=%s",
            status,
            request_id if _REQUEST_ID.fullmatch(request_id) else "-",
        )
        if status in (401, 403):
            return _failure("speech_auth_failed")
        if status == 429:
            return _failure("speech_quota_exceeded")
        if status in (408, 504):
            return _failure("speech_timeout")
        if 400 <= status < 500:
            return _failure("speech_rejected")
        return _failure("speech_service_error")

    @staticmethod
    def _validate_chunk(path: Path, chars: int) -> None:
        try:
            info = read_wav_info(path)
        except InvalidAudioError:
            logger.warning("Azure Speech returned audio that is not the requested WAV format")
            raise _failure("speech_invalid_audio") from None
        seconds = info.duration_seconds
        if info.format != PCM_FORMAT:
            logger.warning("Azure Speech returned an unexpected audio format")
            raise _failure("speech_invalid_audio")
        if seconds >= SUSPECT_TRUNCATION_SECONDS:
            logger.warning("Azure Speech audio reached the 10 minute limit; it may be cut off")
            raise _failure("speech_invalid_audio")
        if chars >= MIN_CHARS_FOR_RATE_CHECK and chars / seconds > MAX_PLAUSIBLE_CHARS_PER_SECOND:
            logger.warning("Azure Speech audio is implausibly short for its text")
            raise _failure("speech_invalid_audio")

    def _join_and_encode(self, chunk_files: list[Path], wav: Path, mp3: Path) -> float:
        try:
            duration = concat_wavs(chunk_files, wav, PCM_FORMAT)
            encode_mp3(self._tools, wav, mp3, duration)
            mp3_duration = probe_mp3(self._tools, mp3)
        except (InvalidAudioError, AudioToolError, OSError):
            raise _failure("speech_audio_failed") from None
        if abs(mp3_duration - duration) > MP3_DURATION_TOLERANCE_SECONDS:
            logger.warning("Encoded MP3 length does not match the joined audio")
            raise _failure("speech_audio_failed")
        return mp3_duration
