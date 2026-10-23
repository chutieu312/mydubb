"""Runs INSIDE the built image (docker exec -i <container> python - < this file).

Proves that the runtime image's FFmpeg really fits audio to an exact duration: synthetic speech
is sped up and slowed down (including factors that need several chained atempo filters) and
every final MP3 is measured three ways (decoder output, ffprobe, the MP3's own gapless
header). No credentials and no network are involved.
"""

import math
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

from app.audio.ffmpeg import locate_tools
from app.audio.fitter import FfmpegAudioProcessor
from app.audio.mp3_header import read_gapless_info
from app.audio.speed import AudioSpeed, DurationTarget
from app.speech.base import SpeechAudio

RATE = 24000
# (natural seconds, target seconds)
CASES = [(5.5, 4), (2.5, 6), (10.0, 2), (2.0, 10), (5.0, 5)]


def write_tone(path: Path, seconds: float, silence: float = 0.0) -> None:
    """A 440 Hz tone, optionally followed by silence (Azure speech ends with ~300 ms of it)."""
    frames = b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * n / RATE)))
        for n in range(round(seconds * RATE))
    ) + bytes(2 * round(silence * RATE))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(frames)


tools = locate_tools()
assert tools is not None, "ffmpeg/ffprobe missing from the image"
processor = FfmpegAudioProcessor(tools)
for natural, target in CASES:
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        wav = work / "speech.wav"
        write_tone(wav, natural)
        speech = SpeechAudio(path=work / "speech.mp3", is_fixture=False, lossless_path=wav)
        result = processor.fit_to_duration(speech, DurationTarget(target), work)
        report = result.duration_report
        expected = target * RATE
        pcm = work / "check.s16le"
        subprocess.run(  # noqa: S603
            [tools.ffmpeg, "-v", "error", "-y", "-i", str(result.path), "-f", "s16le", str(pcm)],
            check=True,
        )
        decoded = pcm.stat().st_size // 2
        header = read_gapless_info(result.path).playable_samples
        assert report.processed_samples == expected, (natural, target, report)
        assert abs(decoded - expected) <= 1, (natural, target, decoded, expected)
        assert abs(header - expected) <= 1, (natural, target, header, expected)
        assert abs(report.mp3_header_samples - expected) <= 1, (natural, target, report)
        print(
            f"{natural:5.1f} s -> {target:2d} s: tempo={report.tempo_factor} "
            f"PCM={report.processed_samples} decoded={decoded} header={header} "
            f"ffprobe_container={report.mp3_container_seconds:.6f}"
        )
# Audio speed: fractional targets (baseline / speed), including one that hits FFmpeg's MP3 end
# padding cap (68,571 samples is 27 over a whole number of frames; repaired only because the
# over-claimed samples decode as silence). (tone seconds, then 0.5 s of silence)
for natural, baseline, speed in [(5.0, 5, AudioSpeed.X1_75), (19.9, 20, AudioSpeed.X0_75)]:
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        wav = work / "speech.wav"
        write_tone(wav, natural, silence=0.5)
        speech = SpeechAudio(path=work / "speech.mp3", is_fixture=False, lossless_path=wav)
        target = DurationTarget(baseline, speed)
        result = processor.fit_to_duration(speech, target, work)
        expected = target.samples(RATE)
        pcm = work / "check.s16le"
        subprocess.run(  # noqa: S603
            [tools.ffmpeg, "-v", "error", "-y", "-i", str(result.path), "-f", "s16le", str(pcm)],
            check=True,
        )
        decoded = pcm.stat().st_size // 2
        header = read_gapless_info(result.path).playable_samples
        assert abs(decoded - expected) <= 1, (baseline, speed, decoded, expected)
        assert abs(header - expected) <= 1, (baseline, speed, header, expected)
        print(
            f"baseline {baseline} s at {speed.label}: target={expected} decoded={decoded} "
            f"header={header} "
            f"padding_adjusted={result.duration_report.mp3_padding_adjusted_samples}"
        )
print("audio duration runtime OK: every MP3 has exactly the target number of samples")
