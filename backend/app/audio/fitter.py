"""Duration fitting with FFmpeg: the whole speech audio is sped up or slowed down to the target.

Contract (see docs/ARCHITECTURE.md): the final audio is exactly `target_samples` long, where
the target is the baseline (last - first sentence start) divided by the speed the user chose
(see audio/speed.py). The spoken content is never cut, skipped or repeated to get there; only
the tempo of the complete audio changes (`atempo`, which keeps the pitch). The speed is part of
the target, not a second tempo step: the source is fitted directly to the final length.

1. The speech provider's lossless WAV is measured: `factor = source_samples / target_samples`
   (the same ratio as source_duration / target_duration).
2. FFmpeg changes the tempo by that factor (a chain of `atempo` filters, each within its own
   range, so any factor is realised). The output is measured again: `atempo` works in
   windows and does not hit the length exactly. If it is off by more than one window, the
   factor is corrected from the measurement and the ORIGINAL audio is processed again
   (never a second time on already processed audio).
3. The sample count is then made exactly the target: silence is appended when the result is
   shorter, or trailing samples are removed when longer AND those samples are verified silent.
   Anything else is an error, never an `atrim` that hides a tempo that was not reached.
4. The PCM is encoded to MP3 once. The MP3 is then verified on the real file: the number of
   samples a decoder produces and the playable length declared by the MP3's own gapless
   header (frames - encoder delay - padding, read without FFmpeg) must both equal the target
   (one sample of rounding at most). FFmpeg's muxer caps the padding it writes, which would
   leave the header up to 46 samples too long for some targets; `set_exact_padding` corrects
   exactly that case first (and reports it), see audio/mp3_header.py. ffprobe's container
   duration is recorded but not used to decide: FFmpeg versions disagree on whether it
   includes the encoder delay and padding.
"""

import logging
import shutil
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

from app.audio.base import ProcessedAudio
from app.audio.duration import (
    ROUNDING_LIMIT_FRAMES,
    DurationReport,
    conform_wav,
    tail_is_silent,
)
from app.audio.ffmpeg import (
    AudioToolCancelled,
    AudioToolError,
    AudioTools,
    AudioToolTimeout,
    change_tempo,
    decode_to_wav,
    encode_mp3,
    probe_mp3,
    tempo_filter_chain,
)
from app.audio.mp3_header import Mp3HeaderError, read_gapless_info, set_exact_padding
from app.audio.speed import DurationTarget
from app.audio.wav import InvalidAudioError, WavInfo, read_wav_info
from app.processing_errors import ProcessingError
from app.speech.base import SpeechAudio

logger = logging.getLogger(__name__)

# Tempo passes: the first uses the ideal factor, later ones correct it from the measured
# length. The measured error is a few hundred samples after the first correction.
MAX_TEMPO_PASSES = 6
# The decoded and header lengths of the MP3 may differ from the target by this many samples
# (rounding), never more.
MP3_TOLERANCE_SAMPLES = 1
# The intermediate PCM is a WAV, whose sizes are 32-bit. This is a technical limit of the
# format (about 11 hours at 24 kHz mono), not a product quota.
MAX_PCM_BYTES = 2 * 1024**3

_MESSAGES = {
    "audio_source_missing": (
        "The speech audio needed to adjust the duration was not available, so no audio was "
        "produced. This is a server problem; please tell the administrator."
    ),
    "audio_input_invalid": (
        "The generated speech audio could not be read, so its duration could not be adjusted "
        "and no audio was produced. Please submit again."
    ),
    "audio_duration_unsupported": (
        "The target duration is longer than the audio format used here can hold (about 11 "
        "hours), so no audio was produced."
    ),
    "audio_duration_not_reached": (
        "The audio could not be adjusted to the exact target duration, so no audio was "
        "produced. Please submit again; if it keeps failing, tell the administrator."
    ),
    "audio_verification_failed": (
        "The adjusted audio did not match the target duration when it was checked, so no "
        "audio was produced. Please submit again; if it keeps failing, tell the administrator."
    ),
    "audio_timeout": "Audio processing took too long and was stopped. Please submit again.",
    "audio_cancelled": "Audio processing was cancelled because the server is shutting down.",
    "audio_processing_failed": (
        "Audio processing failed, so no audio was produced. Please submit again; if it keeps "
        "failing, tell the administrator."
    ),
}


def _failure(code: str) -> ProcessingError:
    return ProcessingError(code, _MESSAGES[code])


@dataclass(frozen=True)
class _Candidate:
    path: Path
    info: WavInfo


class FfmpegAudioProcessor:
    name = "ffmpeg-audio"

    def __init__(self, tools: AudioTools) -> None:
        self._tools = tools
        self._cancel = threading.Event()

    def close(self) -> None:
        """Stop running FFmpeg processes and refuse new work (server shutdown)."""
        self._cancel.set()

    def fit_to_duration(
        self, speech: SpeechAudio, target: DurationTarget, work_dir: Path
    ) -> ProcessedAudio:
        if speech.lossless_path is None:
            raise _failure("audio_source_missing")
        output = work_dir / "final.mp3"
        scratch = Path(tempfile.mkdtemp(prefix="audio-", dir=work_dir))
        try:
            report = self._fit(speech.lossless_path, target, scratch, output)
        except ProcessingError:
            output.unlink(missing_ok=True)
            raise
        except AudioToolCancelled:
            output.unlink(missing_ok=True)
            raise _failure("audio_cancelled") from None
        except AudioToolTimeout:
            output.unlink(missing_ok=True)
            raise _failure("audio_timeout") from None
        except InvalidAudioError:
            output.unlink(missing_ok=True)
            raise _failure("audio_input_invalid") from None
        except (AudioToolError, OSError):
            output.unlink(missing_ok=True)
            raise _failure("audio_processing_failed") from None
        except BaseException:
            # No partial audio is left behind, whatever happened.
            output.unlink(missing_ok=True)
            raise
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        # Counts only; never content.
        logger.info(
            "Audio fitted: source_samples=%d target_samples=%d tempo=%s passes=%d "
            "padded=%d trimmed=%d",
            report.source_samples,
            report.target_samples,
            f"{report.tempo_factor:.6f}" if report.tempo_factor is not None else "none",
            report.tempo_passes,
            report.padded_samples,
            report.trimmed_samples,
        )
        return ProcessedAudio(path=output, duration_adjusted=True, duration_report=report)

    def _fit(
        self, lossless: Path, target: DurationTarget, scratch: Path, output: Path
    ) -> DurationReport:
        source = read_wav_info(lossless)
        rate = source.format.sample_rate
        if source.format.sample_width != 2:
            raise InvalidAudioError("only 16-bit audio is supported")
        target_frames = target.samples(rate)
        if target_frames * source.format.frame_bytes > MAX_PCM_BYTES:
            raise _failure("audio_duration_unsupported")

        processed, factor, passes = self._tempo(lossless, source, target_frames, scratch)
        fitted = scratch / "fitted.wav"
        padded, trimmed = conform_wav(processed.path, processed.info, fitted, target_frames)

        encode_mp3(self._tools, fitted, output, target_frames / rate, cancel=self._cancel)
        try:
            padding_adjusted = set_exact_padding(output, target_frames)
        except Mp3HeaderError:
            logger.warning("Encoded MP3 header cannot be made to match the target")
            raise _failure("audio_verification_failed") from None
        container_seconds = probe_mp3(self._tools, output, cancel=self._cancel)
        decoded_wav = scratch / "decoded.wav"
        decode_to_wav(self._tools, output, decoded_wav, target_frames / rate, cancel=self._cancel)
        decoded = read_wav_info(decoded_wav)
        try:
            header = read_gapless_info(output)
        except Mp3HeaderError:
            logger.warning("Encoded MP3 has no readable gapless header")
            raise _failure("audio_verification_failed") from None

        within = MP3_TOLERANCE_SAMPLES
        if (
            decoded.format.sample_rate != rate
            or header.sample_rate != rate
            or abs(decoded.frames - target_frames) > within
            or abs(header.playable_samples - target_frames) > within
        ):
            logger.warning(
                "Encoded MP3 does not match the target: target_samples=%d decoded_samples=%d "
                "header_samples=%d container_seconds=%.6f",
                target_frames,
                decoded.frames,
                header.playable_samples,
                container_seconds,
            )
            raise _failure("audio_verification_failed")
        return DurationReport(
            sample_rate=rate,
            baseline_seconds=target.baseline_seconds,
            speed=target.speed,
            target_samples=target_frames,
            source_samples=source.frames,
            processed_samples=target_frames,
            tempo_factor=factor,
            tempo_passes=passes,
            padded_samples=padded,
            trimmed_samples=trimmed,
            mp3_decoded_samples=decoded.frames,
            mp3_header_samples=header.playable_samples,
            mp3_container_seconds=container_seconds,
            mp3_padding_adjusted_samples=padding_adjusted,
        )

    def _tempo(
        self, lossless: Path, source: WavInfo, target_frames: int, scratch: Path
    ) -> tuple[_Candidate, float | None, int]:
        """The speech at (nearly) the target length: path, info, factor used, passes run."""
        # Already within one rounding window of the target: no tempo change is needed.
        if self._can_conform(lossless, source, target_frames):
            return _Candidate(lossless, source), None, 0

        seconds = source.duration_seconds
        factor = source.frames / target_frames
        for attempt in range(1, MAX_TEMPO_PASSES + 1):
            path = scratch / f"tempo-{attempt}.wav"
            change_tempo(self._tools, lossless, path, factor, seconds, cancel=self._cancel)
            info = read_wav_info(path)
            if info.format != source.format:
                raise InvalidAudioError("tempo change altered the audio format")
            if self._can_conform(path, info, target_frames):
                logger.info(
                    "Tempo fitted: filters=%s passes=%d", tempo_filter_chain(factor), attempt
                )
                return _Candidate(path, info), factor, attempt
            # Correct the factor from the measurement and run the original audio again. When
            # the output was too long, aim shorter by the overshoot so the result can be
            # completed with silence instead of cutting.
            path.unlink(missing_ok=True)
            aim = target_frames - max(0, info.frames - target_frames)
            factor *= info.frames / max(aim, target_frames // 2, 1)
        logger.warning("Tempo did not reach the target length in %d passes", MAX_TEMPO_PASSES)
        raise _failure("audio_duration_not_reached")

    @staticmethod
    def _can_conform(path: Path, info: WavInfo, target_frames: int) -> bool:
        """Whether silence padding / silent trailing trim alone reaches the exact length."""
        difference = info.frames - target_frames
        if difference <= 0:
            return -difference <= ROUNDING_LIMIT_FRAMES
        return difference <= ROUNDING_LIMIT_FRAMES and tail_is_silent(path, info, difference)
