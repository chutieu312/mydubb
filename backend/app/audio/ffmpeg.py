"""FFmpeg/ffprobe helpers: encode joined PCM audio to MP3 and verify the MP3.

Both tools are started with a fixed argument list (no shell), no stdin, a minimal
environment and a timeout. Their output is never logged or shown to users: it can include
paths, and error text is not needed for diagnosis beyond the exit status.
"""

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

MP3_BITRATE = "96k"
# Encoding runs far faster than real time; this only bounds a hung process.
_ENCODE_BASE_TIMEOUT_SECONDS = 120.0
_ENCODE_SECONDS_PER_AUDIO_SECOND = 0.1
_PROBE_TIMEOUT_SECONDS = 30.0
_ENV_KEYS = ("PATH", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP")


class AudioToolError(RuntimeError):
    """FFmpeg/ffprobe failed or produced audio that does not pass verification."""


@dataclass(frozen=True)
class AudioTools:
    ffmpeg: str
    ffprobe: str


def locate_tools() -> AudioTools | None:
    """The ffmpeg and ffprobe executables on PATH, or None if either is missing."""
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    return AudioTools(ffmpeg, ffprobe) if ffmpeg and ffprobe else None


def encode_mp3(tools: AudioTools, wav: Path, output: Path, duration_seconds: float) -> None:
    """Encode `wav` as a mono MP3 (with the Xing/Info header players use for seeking)."""
    _run(
        [
            tools.ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-threads",
            "1",
            "-i",
            str(wav),
            "-vn",
            "-map_metadata",
            "-1",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            MP3_BITRATE,
            "-ac",
            "1",
            "-f",
            "mp3",
            str(output),
        ],
        timeout=_ENCODE_BASE_TIMEOUT_SECONDS + duration_seconds * _ENCODE_SECONDS_PER_AUDIO_SECOND,
    )


def probe_mp3(tools: AudioTools, path: Path) -> float:
    """Duration in seconds of a valid single-stream MP3; raises AudioToolError otherwise."""
    result = _run(
        [
            tools.ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        timeout=_PROBE_TIMEOUT_SECONDS,
    )
    try:
        info = json.loads(result.stdout)
        streams = info["streams"]
        container = info["format"]
        duration = float(container["duration"])
    except (ValueError, KeyError, TypeError):
        raise AudioToolError("unreadable probe result") from None
    if (
        len(streams) != 1
        or streams[0].get("codec_name") != "mp3"
        or "mp3" not in str(container.get("format_name", "")).split(",")
        or not duration > 0
    ):
        raise AudioToolError("the output is not a single-stream MP3")
    return duration


def _run(args: list[str], *, timeout: float) -> subprocess.CompletedProcess[str]:
    env = {key: os.environ[key] for key in _ENV_KEYS if key in os.environ}
    try:
        result = subprocess.run(  # noqa: S603
            args,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
            check=False,
        )
    except subprocess.TimeoutExpired:
        logger.warning("%s timed out", Path(args[0]).stem)
        raise AudioToolError("timed out") from None
    except OSError as exc:
        logger.warning("%s could not be started: %s", Path(args[0]).stem, type(exc).__name__)
        raise AudioToolError("could not be started") from None
    if result.returncode != 0:
        logger.warning("%s failed with exit status %d", Path(args[0]).stem, result.returncode)
        raise AudioToolError("failed")
    return result
