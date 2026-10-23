"""FFmpeg/ffprobe helpers: change tempo, encode PCM audio to MP3, decode and verify it.

Both tools are started with a fixed argument list (no shell), no stdin, a minimal
environment and a timeout. Their output is never logged or shown to users: it can include
paths, and error text is not needed for diagnosis beyond the exit status.

A run can also be cancelled (server shutdown): the process is then killed, never left behind.
"""

import json
import logging
import os
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

MP3_BITRATE = "96k"
# Encoding runs far faster than real time; this only bounds a hung process.
_ENCODE_BASE_TIMEOUT_SECONDS = 120.0
_ENCODE_SECONDS_PER_AUDIO_SECOND = 0.1
_PROBE_TIMEOUT_SECONDS = 30.0
# Tempo change and decoding also run faster than real time; the same kind of bound.
_FILTER_BASE_TIMEOUT_SECONDS = 120.0
_FILTER_SECONDS_PER_AUDIO_SECOND = 0.5
_ENV_KEYS = ("PATH", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP")
# How often a running process checks for cancellation.
_POLL_SECONDS = 0.2
_KILL_WAIT_SECONDS = 5.0
# Each `atempo` instance stays inside this range, which every FFmpeg version accepts
# (newer versions allow more, but a chain of in-range filters works everywhere).
ATEMPO_MIN = 0.5
ATEMPO_MAX = 2.0


class AudioToolError(RuntimeError):
    """FFmpeg/ffprobe failed or produced audio that does not pass verification."""


class AudioToolTimeout(AudioToolError):
    """The program did not finish within its time limit and was killed."""


class AudioToolCancelled(AudioToolError):
    """The run was cancelled (the server is shutting down); the process was killed."""


@dataclass(frozen=True)
class AudioTools:
    ffmpeg: str
    ffprobe: str


def locate_tools() -> AudioTools | None:
    """The ffmpeg and ffprobe executables on PATH, or None if either is missing."""
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    return AudioTools(ffmpeg, ffprobe) if ffmpeg and ffprobe else None


def check_capabilities(tools: AudioTools) -> None:
    """Raise AudioToolError unless this FFmpeg has what duration fitting needs.

    The `atempo` filter changes tempo without changing pitch; `libmp3lame` writes the MP3
    with the LAME/Info header that makes the playable length exact.
    """
    for option, name in (("-filters", "atempo"), ("-encoders", "libmp3lame")):
        listing = run_tool(
            [tools.ffmpeg, "-hide_banner", "-loglevel", "error", option],
            timeout=_PROBE_TIMEOUT_SECONDS,
        ).stdout
        # Listing rows look like " T.. atempo  A->A  Adjust audio tempo."
        if not any(line.split()[1:2] == [name] for line in listing.splitlines()):
            logger.warning("ffmpeg lacks %s", name)
            raise AudioToolError("a required FFmpeg component is missing")


def tempo_filter_chain(factor: float) -> list[float]:
    """Factors for chained `atempo` filters whose product is `factor`.

    Every element is inside [ATEMPO_MIN, ATEMPO_MAX], so any positive factor can be realised;
    none is ignored or clamped.
    """
    if not 0 < factor < float("inf"):
        raise AudioToolError("invalid tempo factor")
    chain = []
    remaining = factor
    while remaining > ATEMPO_MAX:
        chain.append(ATEMPO_MAX)
        remaining /= ATEMPO_MAX
    while remaining < ATEMPO_MIN:
        chain.append(ATEMPO_MIN)
        remaining /= ATEMPO_MIN
    chain.append(remaining)
    return chain


def change_tempo(
    tools: AudioTools,
    source: Path,
    output: Path,
    factor: float,
    audio_seconds: float,
    *,
    cancel: threading.Event | None = None,
) -> None:
    """Write `source` sped up by `factor` (slowed down below 1) as 16-bit PCM WAV.

    `atempo` keeps the pitch. The output length is only approximately source/factor (the
    filter works in overlapping windows), so callers measure it.
    """
    filters = ",".join(f"atempo={step!r}" for step in tempo_filter_chain(factor))
    run_tool(
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
            str(source),
            "-vn",
            "-map_metadata",
            "-1",
            "-filter:a",
            filters,
            "-codec:a",
            "pcm_s16le",
            "-f",
            "wav",
            str(output),
        ],
        timeout=_filter_timeout(audio_seconds, factor),
        cancel=cancel,
    )


def decode_to_wav(
    tools: AudioTools,
    source: Path,
    output: Path,
    audio_seconds: float,
    *,
    cancel: threading.Event | None = None,
) -> None:
    """Decode an audio file to 16-bit PCM WAV the way a player's decoder would."""
    run_tool(
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
            str(source),
            "-vn",
            "-codec:a",
            "pcm_s16le",
            "-f",
            "wav",
            str(output),
        ],
        timeout=_filter_timeout(audio_seconds, 1.0),
        cancel=cancel,
    )


def _filter_timeout(audio_seconds: float, factor: float) -> float:
    # Work scales with the longer of the input and the output.
    longest = max(audio_seconds, audio_seconds / factor)
    return _FILTER_BASE_TIMEOUT_SECONDS + longest * _FILTER_SECONDS_PER_AUDIO_SECOND


def encode_mp3(
    tools: AudioTools,
    wav: Path,
    output: Path,
    duration_seconds: float,
    *,
    cancel: threading.Event | None = None,
) -> None:
    """Encode `wav` as a mono MP3 (with the Xing/Info header players use for seeking)."""
    run_tool(
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
        cancel=cancel,
    )


def probe_mp3(tools: AudioTools, path: Path, *, cancel: threading.Event | None = None) -> float:
    """Duration in seconds of a valid single-stream MP3; raises AudioToolError otherwise."""
    result = run_tool(
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
        cancel=cancel,
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


def run_tool(
    args: list[str], *, timeout: float, cancel: threading.Event | None = None
) -> subprocess.CompletedProcess[str]:
    """Run a program (argument list, no shell) to completion; kill it on timeout or cancel.

    Raises AudioToolError for a failure to start or a non-zero exit status, AudioToolTimeout
    when it runs out of time and AudioToolCancelled when `cancel` is set. The output is
    returned but never logged.
    """
    env = {key: os.environ[key] for key in _ENV_KEYS if key in os.environ}
    name = Path(args[0]).stem
    try:
        process = subprocess.Popen(  # noqa: S603
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
    except OSError as exc:
        logger.warning("%s could not be started: %s", name, type(exc).__name__)
        raise AudioToolError("could not be started") from None
    deadline = time.monotonic() + timeout
    try:
        while True:
            if cancel is not None and cancel.is_set():
                raise AudioToolCancelled("cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                logger.warning("%s timed out", name)
                raise AudioToolTimeout("timed out")
            try:
                stdout, stderr = process.communicate(timeout=min(remaining, _POLL_SECONDS))
            except subprocess.TimeoutExpired:
                continue
            break
    finally:
        # Whatever ended the wait (timeout, cancel, any exception), no process keeps running.
        if process.poll() is None:
            process.kill()
            try:
                process.communicate(timeout=_KILL_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                logger.warning("%s did not stop after being killed", name)
    if process.returncode != 0:
        logger.warning("%s failed with exit status %d", name, process.returncode)
        raise AudioToolError("failed")
    return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
