"""Duration smoke test: fit audio to a target length with the real FFmpeg and measure it.

Run from `backend/` (ffmpeg and ffprobe must be on PATH; they are in the Docker image).

    uv run python -m scripts.duration_smoke
        Synthetic speech-like audio (tone "words" and pauses), no credentials, no network.
        Fits it to several targets, longer and shorter than the natural length, including
        targets that need several chained atempo filters, and a 6 minute one.

    uv run python -m scripts.duration_smoke --wav speech.wav --target-seconds 360
        Fits a local 24 kHz 16-bit mono WAV (for example the lossless audio of a speech run).

    uv run python -m scripts.duration_smoke --azure
        LIVE: sends the short public sample transcript of azure_speech_smoke.py to Azure
        Speech once per voice (2 requests; AZURE_SPEECH_KEY / AZURE_SPEECH_REGION from the
        environment or backend/.env), then fits each speech to a shorter and a longer target.
        Writes before/after MP3s to listen to. No user data is sent.

For every case it prints the durations measured on real files: the target, the natural
(source) length, the processed PCM, and the final MP3: the samples a decoder produces, the
playable length declared by the MP3's gapless header (read without FFmpeg) and, for
information, ffprobe's container duration (some FFmpeg versions include the encoder delay and
padding in it; it is not a pass/fail criterion). Exit code 0 only if the PCM, the decoded MP3
and the MP3 header are all within one sample of the target.
It does NOT judge sound quality: listen to the files written to --output-dir.
"""

import argparse
import math
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from pydantic import SecretStr

from app.audio.duration import DurationReport
from app.audio.ffmpeg import AudioTools, locate_tools
from app.audio.fitter import FfmpegAudioProcessor
from app.audio.mp3_header import read_gapless_info
from app.audio.wav import read_wav_info
from app.processing_errors import ProcessingError
from app.speech.azure import AzureSpeechProvider
from app.speech.base import SpeechAudio
from app.speech.rate_limit import RequestRateLimiter
from app.speech.voices import Voice
from app.translation.glossary import default_glossary
from scripts.azure_speech_smoke import SAMPLE
from tests.audio_helpers import last_loud_index, read_samples, segments_wav

# Four "words" with their own pitch, as in the automated tests (seconds at scale 1).
WORDS = [(300, 1.0), (500, 1.0), (700, 1.0), (900, 1.5)]
GAP = 0.2
# (label, natural speech seconds, target seconds): each case states what it exercises.
SYNTHETIC_CASES = [
    ("longer than target (faster)", 10.2, 8),
    ("shorter than target (slower)", 5.1, 7),
    ("almost the target", 5.1, 5),
    ("exactly the target", 5.0, 5),
    ("factor 5.1: three chained filters, faster", 20.4, 4),
    ("factor 0.21: three chained filters, slower", 2.55, 12),
    ("370 s speech, 360 s target", 370.0, 360),
    ("350 s speech, 360 s target", 350.0, 360),
]


@dataclass(frozen=True)
class Measured:
    report: DurationReport
    decoded_samples: int
    header_samples: int
    words_ok: bool | None  # None when the audio is not the synthetic words


def synthetic_speech(seconds: float) -> bytes:
    """The words and pauses scaled to last `seconds` (the last word ends the audio)."""
    base = sum(duration for _, duration in WORDS) + GAP * (len(WORDS) - 1)
    scale = seconds / base
    segments: list[tuple[float, float]] = []
    for index, (frequency, duration) in enumerate(WORDS):
        if index:
            segments.append((0, GAP * scale))
        segments.append((frequency, duration * scale))
    return segments_wav(segments)


def decode(tools: AudioTools, mp3: Path, wav: Path) -> None:
    subprocess.run(  # noqa: S603
        [tools.ffmpeg, "-v", "error", "-y", "-i", str(mp3), str(wav)],
        check=True,
        capture_output=True,
    )


def fit(
    processor: FfmpegAudioProcessor,
    tools: AudioTools,
    wav_path: Path,
    target: int,
    work: Path,
    *,
    synthetic: bool = False,
) -> tuple[Path, Measured]:
    speech = SpeechAudio(path=work / "unused.mp3", is_fixture=False, lossless_path=wav_path)
    result = processor.fit_to_duration(speech, target, work)
    report = result.duration_report
    # Measured again here, from the final file, not taken from the processor's own report.
    decoded = work / "decoded.wav"
    decode(tools, result.path, decoded)
    samples = read_samples(decoded)
    # The synthetic audio ends with sound: a cut-off last word would leave silence at the end
    # (the reported padding aside).
    words_ok = len(samples) - 1 - last_loud_index(samples) <= report.padded_samples + 100
    return result.path, Measured(
        report=report,
        decoded_samples=len(samples),
        header_samples=read_gapless_info(result.path).playable_samples,
        words_ok=words_ok if synthetic else None,
    )


def verdict(measured: Measured) -> bool:
    report = measured.report
    target = report.target_samples
    return (
        abs(report.processed_samples - target) <= 1
        and abs(measured.decoded_samples - target) <= 1
        and abs(measured.header_samples - target) <= 1
        and abs(report.mp3_header_samples - target) <= 1
        and measured.words_ok is not False
    )


def print_header() -> None:
    print(
        f"{'case':44} {'target':>11} {'source':>13} {'PCM':>11} {'MP3 ffprobe':>14} "
        f"{'MP3 decoded':>12} {'MP3 header':>11} {'tempo':>8} {'pad/trim':>9}  result"
    )


def print_row(label: str, measured: Measured) -> bool:
    report = measured.report
    rate = report.sample_rate
    ok = verdict(measured)
    tempo = f"{report.tempo_factor:.5f}" if report.tempo_factor is not None else "none"
    print(
        f"{label:44} {report.target_samples / rate:>10.6f}s "
        f"{report.source_samples / rate:>12.6f}s {report.processed_samples / rate:>10.6f}s "
        f"{report.mp3_container_seconds:>13.6f}s {measured.decoded_samples / rate:>11.6f}s "
        f"{measured.header_samples / rate:>10.6f}s {tempo:>8} "
        f"{report.padded_samples}/{report.trimmed_samples:>3}  {'OK' if ok else 'MISMATCH'}"
    )
    return ok


def run_synthetic(processor, tools, output_dir: Path) -> bool:
    print_header()
    all_ok = True
    for index, (label, natural, target) in enumerate(SYNTHETIC_CASES, start=1):
        with tempfile.TemporaryDirectory(prefix="mydubb-duration-") as directory:
            work = Path(directory)
            source = work / "speech.wav"
            source.write_bytes(synthetic_speech(natural))
            mp3, measured = fit(processor, tools, source, target, work, synthetic=True)
            all_ok &= print_row(label, measured)
            if output_dir is not None and natural < 60:
                stem = f"synthetic-{index}-{natural:g}s-to-{target}s"
                (output_dir / f"{stem}-before.wav").write_bytes(source.read_bytes())
                (output_dir / f"{stem}-after.mp3").write_bytes(mp3.read_bytes())
    return all_ok


def run_wav(processor, tools, wav: Path, targets: list[int], output_dir: Path) -> bool:
    info = read_wav_info(wav)
    print(f"{wav.name}: {info.duration_seconds:.6f} s natural, {info.format.sample_rate} Hz")
    print_header()
    all_ok = True
    for target in targets:
        with tempfile.TemporaryDirectory(prefix="mydubb-duration-") as directory:
            work = Path(directory)
            mp3, measured = fit(processor, tools, wav, target, work)
            all_ok &= print_row(f"{wav.stem} -> {target} s", measured)
            (output_dir / f"{wav.stem}-after-{target}s.mp3").write_bytes(mp3.read_bytes())
    return all_ok


def run_azure(processor, tools, output_dir: Path, key: str, region: str) -> bool:
    """Live: one Azure Speech request per voice with the accepted public sample transcript."""
    print(f"LIVE: {len(Voice)} Azure Speech requests, {len(SAMPLE)} characters each (public).")
    all_ok = True
    print_header()
    for voice in Voice:
        provider = AzureSpeechProvider(
            key=SecretStr(key),
            region=region,
            glossary=default_glossary(),
            tools=tools,
            limiter=RequestRateLimiter(20, 60),
            timeout_seconds=60,
            max_chunk_chars=2000,
        )
        with tempfile.TemporaryDirectory(prefix="mydubb-duration-") as directory:
            work = Path(directory)
            try:
                speech = provider.synthesize(SAMPLE, voice, work)
            except ProcessingError as exc:
                print(f"FAILED ({exc.code}): {exc.user_message}")
                return False
            natural = read_wav_info(speech.lossless_path).duration_seconds
            (output_dir / f"live-{voice.value}-before.mp3").write_bytes(speech.path.read_bytes())
            (output_dir / f"live-{voice.value}-before.wav").write_bytes(
                speech.lossless_path.read_bytes()
            )
            for target in (math.floor(natural * 0.85), math.ceil(natural * 1.25)):
                fitted = work / f"fit-{target}"
                fitted.mkdir()
                mp3, measured = fit(processor, tools, speech.lossless_path, target, fitted)
                all_ok &= print_row(f"{voice.value} {natural:.2f} s -> {target} s", measured)
                (output_dir / f"live-{voice.value}-after-{target}s.mp3").write_bytes(
                    mp3.read_bytes()
                )
    return all_ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--output-dir", type=Path, default=Path("duration-samples"))
    parser.add_argument("--wav", type=Path, help="fit this local 16-bit PCM WAV")
    parser.add_argument("--target-seconds", type=int, action="append", help="with --wav")
    parser.add_argument("--azure", action="store_true", help="LIVE: 1 Azure request per voice")
    args = parser.parse_args()

    load_dotenv()
    key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
    region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
    if args.azure and not (key and region):
        print("AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are not set; see docs/DEPLOYMENT.md.")
        return 2
    tools = locate_tools()
    if tools is None:
        print("ffmpeg and ffprobe must be on PATH (they are included in the Docker image).")
        return 2
    args.output_dir.mkdir(parents=True, exist_ok=True)
    processor = FfmpegAudioProcessor(tools)
    try:
        if args.azure:
            ok = run_azure(processor, tools, args.output_dir, key, region)
        elif args.wav:
            if not args.target_seconds:
                print("--wav needs at least one --target-seconds")
                return 2
            ok = run_wav(processor, tools, args.wav, args.target_seconds, args.output_dir)
        else:
            ok = run_synthetic(processor, tools, args.output_dir)
    except ProcessingError as exc:
        print(f"FAILED ({exc.code}): {exc.user_message}")
        return 1
    if not ok:
        print("\nMISMATCH: at least one case is not within one sample of its target.")
        return 1
    print(
        f"\nOK: every case is within one sample of its target. Files are in {args.output_dir}.\n"
        "This does not judge sound quality: listen to the *-after* files."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
