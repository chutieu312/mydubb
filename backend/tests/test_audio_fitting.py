"""Duration fitting with the real FFmpeg on synthetic audio (no Azure, no credentials).

Every result is measured on the real files: samples of the processed PCM, the container
duration ffprobe reads from the MP3, the samples a decoder produces, and the gapless fields
of the MP3 header (read by app.audio.mp3_header without FFmpeg).
"""

import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from app.audio import fitter, mp3_header
from app.audio.duration import ROUNDING_LIMIT_FRAMES, DurationReport
from app.audio.ffmpeg import (
    ATEMPO_MAX,
    ATEMPO_MIN,
    AudioToolCancelled,
    AudioToolError,
    AudioTools,
    AudioToolTimeout,
    check_capabilities,
    decode_to_wav,
    encode_mp3,
    run_tool,
    tempo_filter_chain,
)
from app.audio.fitter import MAX_TEMPO_PASSES, FfmpegAudioProcessor
from app.audio.mp3_header import (
    Mp3Gapless,
    Mp3HeaderError,
    read_gapless_info,
    set_exact_padding,
)
from app.audio.speed import AudioSpeed, DurationTarget
from app.audio.wav import read_wav_info
from app.processing_errors import ProcessingError
from app.speech.base import SpeechAudio
from tests.audio_helpers import (
    RATE,
    dominant_frequency,
    last_loud_index,
    make_wav,
    read_samples,
    segments_wav,
    tone_samples,
    wav_bytes,
)

# Four "words": each has its own pitch, so order, completeness and the very end of the audio
# can be checked after the tempo change. Nominal seconds scale with `scale`.
WORDS = [(300, 1.0), (500, 1.0), (700, 1.0), (900, 1.5)]
GAP = 0.2


def speech_like(scale: float = 1.0) -> tuple[bytes, float]:
    segments: list[tuple[float, float]] = []
    for index, (frequency, seconds) in enumerate(WORDS):
        if index:
            segments.append((0, GAP * scale))
        segments.append((frequency, seconds * scale))
    return segments_wav(segments), sum(seconds for _, seconds in segments)


@pytest.fixture
def processor(audio_tools) -> FfmpegAudioProcessor:
    return FfmpegAudioProcessor(audio_tools)


@pytest.fixture
def work_dir(tmp_path) -> Path:
    directory = tmp_path / "work"
    directory.mkdir()
    return directory


def fit(processor, work_dir: Path, wav: bytes, target: int, speed: AudioSpeed = AudioSpeed.X1):
    source = work_dir / "speech.wav"
    source.write_bytes(wav)
    speech = SpeechAudio(path=work_dir / "speech.mp3", is_fixture=False, lossless_path=source)
    return processor.fit_to_duration(speech, DurationTarget(target, speed), work_dir)


def decoded_samples(audio_tools: AudioTools, mp3: Path, tmp_path: Path) -> int:
    """Samples a decoder yields for the MP3, counted outside the application code."""
    pcm = tmp_path / "decoded.s16le"
    subprocess.run(  # noqa: S603
        [audio_tools.ffmpeg, "-v", "error", "-y", "-i", str(mp3), "-f", "s16le", str(pcm)],
        check=True,
        capture_output=True,
    )
    return pcm.stat().st_size // 2


def assert_exact(result, audio_tools, tmp_path, target: int) -> DurationReport:
    """The processed PCM and the final MP3 both have exactly the target number of samples."""
    return assert_exact_samples(result, audio_tools, tmp_path, target * RATE)


def assert_exact_samples(result, audio_tools, tmp_path, expected: int) -> DurationReport:
    report = result.duration_report
    assert result.duration_adjusted is True
    assert report.target_samples == expected
    assert report.processed_samples == expected
    assert report.sample_rate == RATE
    # Independent measurements of the real MP3 (one sample of rounding at most).
    assert abs(decoded_samples(audio_tools, result.path, tmp_path) - expected) <= 1
    assert abs(read_gapless_info(result.path).playable_samples - expected) <= 1
    assert abs(report.mp3_decoded_samples - expected) <= 1
    assert abs(report.mp3_header_samples - expected) <= 1
    # ffprobe's container duration is recorded as is: depending on the FFmpeg version it is
    # the target or the target plus the encoder delay and padding (a few hundredths of a second).
    assert expected / RATE - 0.001 <= report.mp3_container_seconds <= expected / RATE + 0.2
    return report


def loud_runs(samples, threshold: int = 2000, merge_gap: int = 600) -> list[tuple[int, int]]:
    """(start, end) of each stretch of sound; pauses shorter than `merge_gap` are joined."""
    runs: list[list[int]] = []
    for index, value in enumerate(samples):
        if abs(value) > threshold:
            if runs and index - runs[-1][1] <= merge_gap:
                runs[-1][1] = index
            else:
                runs.append([index, index])
    return [(start, end) for start, end in runs]


def assert_words_complete_and_in_order(
    samples, report: DurationReport, source_seconds, scale, pitch_tolerance_hz: float = 0
):
    """Every word is there, in order, at its own pitch, with the end of the last word intact."""
    target = report.target_samples
    factor = source_seconds * RATE / target
    # The tempo filter works in windows of 2048 samples, so a word edge moves by about one
    # window (longer when slowing down); the words themselves are not shortened.
    tolerance = 1.5 * ROUNDING_LIMIT_FRAMES * max(1.0, 1 / factor)
    runs = loud_runs(samples)
    assert len(runs) == len(WORDS)
    position = 0.0
    for index, ((frequency, seconds), (start, end)) in enumerate(zip(WORDS, runs, strict=True)):
        if index:
            position += GAP * scale
        expected_start = position / factor * RATE
        expected_length = seconds * scale / factor * RATE
        assert start == pytest.approx(expected_start, abs=tolerance)
        assert end - start == pytest.approx(expected_length, abs=tolerance)
        middle = (start + end) // 2
        found = dominant_frequency(samples, middle - 2048, 4096, frequency)
        assert abs(found - frequency) <= pitch_tolerance_hz
        position += seconds * scale
    # The last word runs to the end: at most the reported silence padding follows it.
    assert len(samples) - 1 - last_loud_index(samples) <= report.padded_samples + 100


# --- the factor is realised, whatever its size ----------------------------------------------------


@pytest.mark.parametrize(
    "factor", [1.0, 1.0001, 1.9999, 2.0, 2.0001, 3.3, 10.0, 123.4, 0.9999, 0.5, 0.4999, 0.3, 0.01]
)
def test_chain_product_is_the_factor_and_every_filter_is_in_range(factor):
    chain = tempo_filter_chain(factor)
    product = 1.0
    for step in chain:
        assert ATEMPO_MIN <= step <= ATEMPO_MAX
        product *= step
    assert product == pytest.approx(factor, rel=1e-12)


@pytest.mark.parametrize("factor", [0, -1.0, float("inf"), float("nan")])
def test_a_factor_that_cannot_exist_is_an_error_not_a_clamp(factor):
    with pytest.raises(AudioToolError):
        tempo_filter_chain(factor)


# --- exact length ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("scale", "target"),
    [
        (1.0, 4),  # natural speech 5.1 s is longer than the target: faster
        (1.0, 7),  # shorter than the target: slower
        (2.0, 2),  # factor 5.1: needs three chained filters, faster
        (0.5, 12),  # factor 0.2125: needs three chained filters, slower
        (1.0, 5),  # 5.1 s -> 5 s: nearly the target already
    ],
)
def test_speech_is_fitted_to_the_target_without_losing_words(
    processor, audio_tools, work_dir, tmp_path, scale, target
):
    wav, source_seconds = speech_like(scale)
    result = fit(processor, work_dir, wav, target)

    report = assert_exact(result, audio_tools, tmp_path, target)
    assert report.source_samples == round(source_seconds * RATE)
    assert report.tempo_factor == pytest.approx(source_seconds / target, rel=0.01)
    assert report.trimmed_samples == 0  # the audible content is never cut
    assert report.padded_samples <= ROUNDING_LIMIT_FRAMES
    decoded = tmp_path / "decoded.wav"
    subprocess.run(  # noqa: S603
        [audio_tools.ffmpeg, "-v", "error", "-y", "-i", str(result.path), str(decoded)],
        check=True,
        capture_output=True,
    )
    assert_words_complete_and_in_order(read_samples(decoded), report, source_seconds, scale)


def test_the_natural_length_equal_to_the_target_only_adds_nothing(
    processor, audio_tools, work_dir, tmp_path
):
    result = fit(processor, work_dir, make_wav(6.0), 6)
    report = assert_exact(result, audio_tools, tmp_path, 6)
    assert report.tempo_factor is None
    assert (report.tempo_passes, report.padded_samples, report.trimmed_samples) == (0, 0, 0)


def test_a_few_samples_short_is_completed_with_reported_silence(
    processor, audio_tools, work_dir, tmp_path
):
    wav = wav_bytes(tone_samples(6.0, 440)[:-500])
    result = fit(processor, work_dir, wav, 6)
    report = assert_exact(result, audio_tools, tmp_path, 6)
    assert report.tempo_factor is None
    assert (report.padded_samples, report.trimmed_samples) == (500, 0)


def test_trailing_silence_beyond_the_target_is_removed_and_reported(
    processor, audio_tools, work_dir, tmp_path
):
    samples = tone_samples(6.0, 440)
    samples.extend([0] * 1000)  # Azure audio ends with silence
    result = fit(processor, work_dir, wav_bytes(samples), 6)
    report = assert_exact(result, audio_tools, tmp_path, 6)
    assert report.tempo_factor is None
    assert (report.padded_samples, report.trimmed_samples) == (0, 1000)


def test_audible_samples_beyond_the_target_are_never_trimmed(
    processor, audio_tools, work_dir, tmp_path
):
    """1000 samples too long but the end is sound: the tempo changes instead of a cut."""
    samples = tone_samples(6.0, 440)
    samples.extend(tone_samples(1000 / RATE, 440))
    result = fit(processor, work_dir, wav_bytes(samples), 6)
    report = assert_exact(result, audio_tools, tmp_path, 6)
    assert report.tempo_factor == pytest.approx(1 + 1000 / (6 * RATE), rel=1e-2)
    assert report.trimmed_samples == 0


def test_a_long_target_is_reached(processor, audio_tools, work_dir, tmp_path):
    """A 6 minute target (the example in the product description) from a longer speech."""
    result = fit(processor, work_dir, make_wav(370.0), 360)
    report = assert_exact(result, audio_tools, tmp_path, 360)
    assert report.tempo_factor == pytest.approx(370 / 360, rel=1e-3)
    assert report.source_samples == 370 * RATE


def test_a_shorter_speech_is_slowed_down_to_a_long_target(
    processor, audio_tools, work_dir, tmp_path
):
    result = fit(processor, work_dir, make_wav(350.0), 360)
    report = assert_exact(result, audio_tools, tmp_path, 360)
    assert report.tempo_factor == pytest.approx(350 / 360, rel=1e-3)


@pytest.mark.parametrize(("source", "target"), [(8.0, 5), (5.0, 8), (20.0, 2), (2.0, 20)])
def test_pitch_is_preserved(processor, audio_tools, work_dir, tmp_path, source, target):
    result = fit(processor, work_dir, make_wav(source, 440.0), target)
    assert_exact(result, audio_tools, tmp_path, target)
    decoded = tmp_path / "decoded.wav"
    subprocess.run(  # noqa: S603
        [audio_tools.ffmpeg, "-v", "error", "-y", "-i", str(result.path), str(decoded)],
        check=True,
        capture_output=True,
    )
    samples = read_samples(decoded)
    middle = len(samples) // 2
    assert dominant_frequency(samples, middle, 4096, 440.0) == pytest.approx(440.0, abs=2)


def test_the_mp3_keeps_the_existing_audio_configuration(processor, work_dir, audio_tools):
    result = fit(processor, work_dir, make_wav(5.0), 4)
    info = subprocess.run(  # noqa: S603
        [
            audio_tools.ffprobe,
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,sample_rate,channels,bit_rate",
            "-of",
            "default=nw=1",
            str(result.path),
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    assert "codec_name=mp3" in info
    assert f"sample_rate={RATE}" in info
    assert "channels=1" in info
    assert "bit_rate=96000" in info


def test_the_report_lists_target_source_pcm_and_mp3_separately(
    processor, audio_tools, work_dir, tmp_path
):
    report = fit(processor, work_dir, make_wav(5.5), 4).duration_report.as_dict()
    assert report["target_seconds"] == 4
    assert report["target_samples"] == 4 * RATE
    assert report["source_seconds"] == 5.5
    assert report["processed_seconds"] == 4.0
    assert report["mp3_decoded_seconds"] == 4.0
    assert report["mp3_header_seconds"] == 4.0
    assert report["mp3_container_seconds"] >= 4.0


# --- audio speed: the target is baseline / speed, fitted from the original in one step ---------


# Baseline 20 s (the example in the product decision): speed, target samples at 24 kHz.
# 20 s / 1.75 = 11.428571... s = 274285.714... samples, which rounds to 274286.
SPEED_TABLE = [
    (AudioSpeed.X0_5, 960_000),
    (AudioSpeed.X0_75, 640_000),
    (AudioSpeed.X1, 480_000),
    (AudioSpeed.X1_25, 384_000),
    (AudioSpeed.X1_5, 320_000),
    (AudioSpeed.X1_75, 274_286),
    (AudioSpeed.X2, 240_000),
]


@pytest.mark.parametrize(("speed", "expected"), SPEED_TABLE, ids=[s.label for s, _ in SPEED_TABLE])
def test_every_speed_is_fitted_to_its_own_target_in_one_step(
    processor, audio_tools, work_dir, tmp_path, speed, expected
):
    scale = 4.0  # natural speech of 20.4 s, close to the 20 s baseline
    wav, source_seconds = speech_like(scale)
    result = fit(processor, work_dir, wav, 20, speed)

    report = assert_exact_samples(result, audio_tools, tmp_path, expected)
    assert report.baseline_seconds == 20
    assert report.speed is speed
    assert report.source_samples == round(source_seconds * RATE)
    # The tempo is source/target from the ORIGINAL audio (not 20.4/20 and then x speed again),
    # and nothing audible is cut.
    assert report.tempo_factor == pytest.approx(source_seconds * RATE / expected, rel=0.01)
    assert report.trimmed_samples == 0
    assert report.padded_samples <= ROUNDING_LIMIT_FRAMES
    decoded = tmp_path / "decoded.wav"
    subprocess.run(  # noqa: S603
        [audio_tools.ffmpeg, "-v", "error", "-y", "-i", str(result.path), str(decoded)],
        check=True,
        capture_output=True,
    )
    # Every word is still there, in order, with its own pitch, and the last one reaches the end.
    # The pitch is kept to within 2 Hz (atempo at a factor of 2.5 moves 900 Hz by about 1 Hz).
    assert_words_complete_and_in_order(
        read_samples(decoded), report, source_seconds, scale, pitch_tolerance_hz=2
    )


def test_a_fractional_target_is_exact_in_samples(processor, audio_tools, work_dir, tmp_path):
    # 5 s / 1.75 = 2.857142... s = 68571.43 samples: not a whole number of anything but samples.
    result = fit(processor, work_dir, make_wav(5.5), 5, AudioSpeed.X1_75)
    report = assert_exact_samples(result, audio_tools, tmp_path, 68_571)
    as_dict = report.as_dict()
    assert as_dict["target_samples"] == 68_571
    assert as_dict["target_seconds"] == 68_571 / RATE
    assert as_dict["mp3_decoded_seconds"] == 68_571 / RATE
    assert as_dict["baseline_seconds"] == 5
    assert as_dict["speed"] == 1.75
    assert isinstance(as_dict["speed"], float)  # JSON-serialisable, not an Enum


def test_one_x_is_the_baseline_even_when_azure_speaks_faster_or_slower(
    processor, audio_tools, work_dir, tmp_path
):
    """1x is 'fitted to the baseline', not 'the natural speed Azure returned'."""
    for index, natural in enumerate((3.0, 9.0)):
        directory = work_dir / f"run-{index}"
        directory.mkdir()
        result = fit(processor, directory, make_wav(natural), 6, AudioSpeed.X1)
        report = assert_exact(result, audio_tools, tmp_path, 6)
        assert report.tempo_factor == pytest.approx(natural / 6, rel=0.01)


def test_the_speed_is_not_applied_a_second_time_to_the_tempo(processor, work_dir):
    # 8 s of natural speech, baseline 8 s, 2x: the tempo is 8 / 4 = 2, not 1 x 2 x 2.
    report = fit(processor, work_dir, make_wav(8.0), 8, AudioSpeed.X2).duration_report
    assert report.target_samples == 4 * RATE
    assert report.tempo_factor == pytest.approx(2.0, rel=0.01)


# --- MP3 end padding: FFmpeg's muxer caps it, which the fitter corrects ---------------------------
#
# At 24 kHz an MP3 frame holds 576 samples. FFmpeg writes at most 1105 samples of end padding,
# so a target that is 1-46 samples over a whole number of frames (which fractional targets,
# unlike whole-second ones, often are) came out up to 46 samples too long in the header and in
# every gapless decoder. Whole seconds at 24 kHz are always 0, 192 or 384 samples over.


def encode_exact(audio_tools, work_dir: Path, samples: int) -> Path:
    wav = work_dir / "tone.wav"
    wav.write_bytes(make_wav(samples / RATE))
    mp3 = work_dir / "tone.mp3"
    encode_mp3(audio_tools, wav, mp3, samples / RATE)
    return mp3


def decode_count(audio_tools, mp3: Path, work_dir: Path) -> int:
    decoded = work_dir / "tone-decoded.wav"
    decode_to_wav(audio_tools, mp3, decoded, 10.0)
    return read_wav_info(decoded).frames


FRAME = 576
BASE = 120 * FRAME  # a whole number of frames


@pytest.mark.parametrize("over", [0, 1, 2, 27, 45, 46, 47, 192, 300, 575])
def test_every_position_in_a_frame_decodes_to_the_exact_target(audio_tools, work_dir, over):
    target = BASE + over
    mp3 = encode_exact(audio_tools, work_dir, target)
    adjusted = set_exact_padding(mp3, target)

    # Only the capped cases (1-46 samples over a frame) are touched; the rest are left alone.
    assert (adjusted > 0) == (1 <= over <= 46)
    assert read_gapless_info(mp3).playable_samples == target
    assert decode_count(audio_tools, mp3, work_dir) == target


def test_an_mp3_that_is_already_exact_is_not_modified(audio_tools, work_dir):
    mp3 = encode_exact(audio_tools, work_dir, BASE + 192)
    before = mp3.read_bytes()
    assert set_exact_padding(mp3, BASE + 192) == 0
    assert mp3.read_bytes() == before


def test_the_repair_rewrites_only_the_padding_and_the_tag_crc(audio_tools, work_dir):
    target = BASE + 27
    mp3 = encode_exact(audio_tools, work_dir, target)
    before = bytearray(mp3.read_bytes())
    assert set_exact_padding(mp3, target) == 20  # padding 1125 needed, 1105 written
    after = mp3.read_bytes()
    assert len(after) == len(before)
    changed = [i for i, (a, b) in enumerate(zip(before, after, strict=True)) if a != b]
    # Padding (12 bits spread over two bytes) and the two CRC bytes: nothing in the audio.
    assert 1 <= len(changed) <= 4
    first_audio_frame = 44 + 288  # ID3v2 tag + the Info frame
    assert all(index < first_audio_frame for index in changed)
    # A second call finds nothing left to do.
    assert set_exact_padding(mp3, target) == 0


def test_the_repaired_tag_crc_is_the_one_ffmpeg_would_write(audio_tools, work_dir):
    """The CRC algorithm is checked on files FFmpeg wrote (before and after the repair)."""
    mp3 = encode_exact(audio_tools, work_dir, BASE + 192)
    data = mp3.read_bytes()
    frame = bytearray(data[44 : 44 + 190])
    stored = int.from_bytes(frame[167:169], "big")
    frame[167:169] = bytes(2)
    assert mp3_header._tag_crc(bytes(frame)) == stored


def test_a_header_the_repair_does_not_understand_is_an_error_not_a_guess(audio_tools, work_dir):
    target = BASE + 27
    mp3 = encode_exact(audio_tools, work_dir, target)
    data = bytearray(mp3.read_bytes())
    data[44 + 167] ^= 0xFF  # corrupt the stored tag CRC
    mp3.write_bytes(bytes(data))
    with pytest.raises(Mp3HeaderError, match="tag CRC"):
        set_exact_padding(mp3, target)
    assert mp3.read_bytes() == bytes(data)


def test_a_padding_that_does_not_fit_the_field_is_an_error(audio_tools, work_dir):
    mp3 = encode_exact(audio_tools, work_dir, BASE + 27)
    with pytest.raises(Mp3HeaderError, match="does not fit"):
        set_exact_padding(mp3, 1000)  # the encoded audio is far longer than this target


def test_a_target_longer_than_what_was_encoded_is_left_for_the_verification(audio_tools, work_dir):
    mp3 = encode_exact(audio_tools, work_dir, BASE + 27)
    assert set_exact_padding(mp3, BASE + 500) == 0  # nothing to shorten; verification fails it


def test_the_processor_reports_a_corrected_header(processor, audio_tools, work_dir, tmp_path):
    # 5 s / 1.75 = 68571.43 -> 68571 samples = 119 frames + 27: the capped case.
    report = fit(processor, work_dir, make_wav(5.5), 5, AudioSpeed.X1_75).duration_report
    assert report.target_samples == 68_571
    assert report.mp3_header_samples == 68_571
    assert report.mp3_padding_adjusted_samples == 20
    assert report.as_dict()["mp3_padding_adjusted_samples"] == 20


def test_whole_second_targets_never_need_the_correction(processor, work_dir):
    report = fit(processor, work_dir, make_wav(5.5), 4).duration_report
    assert report.mp3_padding_adjusted_samples == 0


# --- failures are errors, never a quiet pass-through ---------------------------------------------


def assert_nothing_left(work_dir: Path) -> None:
    assert sorted(path.name for path in work_dir.iterdir()) == ["speech.wav"]


def test_a_tempo_that_is_not_realised_is_an_error_not_a_trim(processor, work_dir, monkeypatch):
    """If FFmpeg hands back the audio unchanged, a long speech must not be cut to fit."""
    calls = []

    def unchanged(tools, source, output, factor, seconds, *, cancel=None):
        calls.append(factor)
        output.write_bytes(source.read_bytes())

    monkeypatch.setattr(fitter, "change_tempo", unchanged)
    with pytest.raises(ProcessingError) as raised:
        fit(processor, work_dir, make_wav(10.0), 5)
    assert raised.value.code == "audio_duration_not_reached"
    assert len(calls) == MAX_TEMPO_PASSES
    assert_nothing_left(work_dir)


def test_a_short_speech_whose_tempo_is_not_realised_is_not_padded_to_fit(
    processor, work_dir, monkeypatch
):
    def unchanged(tools, source, output, factor, seconds, *, cancel=None):
        output.write_bytes(source.read_bytes())

    monkeypatch.setattr(fitter, "change_tempo", unchanged)
    with pytest.raises(ProcessingError) as raised:
        fit(processor, work_dir, make_wav(3.0), 5)
    assert raised.value.code == "audio_duration_not_reached"
    assert_nothing_left(work_dir)


@pytest.mark.parametrize(
    ("patched", "replacement", "code"),
    [
        ("change_tempo", AudioToolError("failed"), "audio_processing_failed"),
        ("change_tempo", AudioToolTimeout("timed out"), "audio_timeout"),
        ("change_tempo", AudioToolCancelled("cancelled"), "audio_cancelled"),
        ("encode_mp3", AudioToolError("failed"), "audio_processing_failed"),
        ("probe_mp3", AudioToolError("failed"), "audio_processing_failed"),
        ("decode_to_wav", AudioToolError("failed"), "audio_processing_failed"),
    ],
)
def test_failures_have_a_code_and_leave_no_files(
    processor, work_dir, monkeypatch, patched, replacement, code
):
    def replace(*args, **kwargs):
        if isinstance(replacement, Exception):
            raise replacement
        return replacement

    monkeypatch.setattr(fitter, patched, replace)
    with pytest.raises(ProcessingError) as raised:
        fit(processor, work_dir, make_wav(5.0), 4)
    assert raised.value.code == code
    assert_nothing_left(work_dir)


def test_a_decoded_length_that_differs_by_two_samples_is_rejected(
    processor, work_dir, monkeypatch, audio_tools
):
    real_decode = fitter.decode_to_wav

    def two_samples_longer(tools, source, output, seconds, *, cancel=None):
        real_decode(tools, source, output, seconds, cancel=cancel)
        samples = read_samples(output)
        output.write_bytes(wav_bytes(samples + samples[:2]))

    monkeypatch.setattr(fitter, "decode_to_wav", two_samples_longer)
    with pytest.raises(ProcessingError) as raised:
        fit(processor, work_dir, make_wav(5.0), 4)
    assert raised.value.code == "audio_verification_failed"
    assert_nothing_left(work_dir)


def test_a_header_that_declares_another_length_is_rejected(processor, work_dir, monkeypatch):
    real = fitter.read_gapless_info

    def one_frame_longer(path):
        info = real(path)
        return Mp3Gapless(
            info.sample_rate,
            info.frames + 1,
            info.samples_per_frame,
            info.encoder_delay,
            info.padding,
        )

    monkeypatch.setattr(fitter, "read_gapless_info", one_frame_longer)
    with pytest.raises(ProcessingError) as raised:
        fit(processor, work_dir, make_wav(5.0), 4)
    assert raised.value.code == "audio_verification_failed"
    assert_nothing_left(work_dir)


def test_an_mp3_without_a_readable_gapless_header_is_rejected(processor, work_dir, monkeypatch):
    def unreadable(path):
        raise Mp3HeaderError("no header")

    monkeypatch.setattr(fitter, "read_gapless_info", unreadable)
    with pytest.raises(ProcessingError) as raised:
        fit(processor, work_dir, make_wav(5.0), 4)
    assert raised.value.code == "audio_verification_failed"
    assert_nothing_left(work_dir)


def test_an_unexpected_error_still_removes_partial_files(processor, work_dir, monkeypatch):
    def explode(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(fitter, "encode_mp3", explode)
    with pytest.raises(RuntimeError):
        fit(processor, work_dir, make_wav(5.0), 4)
    assert_nothing_left(work_dir)


@pytest.mark.parametrize(
    "data",
    [b"", b"not audio at all", make_wav(2.0)[:1000], wav_bytes(tone_samples(0, 440))],
)
def test_input_that_is_not_usable_audio_is_rejected(processor, work_dir, data):
    with pytest.raises(ProcessingError) as raised:
        fit(processor, work_dir, data, 4)
    assert raised.value.code == "audio_input_invalid"
    assert_nothing_left(work_dir)


def test_without_lossless_audio_there_is_no_silent_pass_through(processor, work_dir):
    mp3 = work_dir / "speech.mp3"
    mp3.write_bytes(b"\xff\xfb" * 100)
    speech = SpeechAudio(path=mp3, is_fixture=True)
    with pytest.raises(ProcessingError) as raised:
        processor.fit_to_duration(speech, DurationTarget(4), work_dir)
    assert raised.value.code == "audio_source_missing"
    assert not (work_dir / "final.mp3").exists()


def test_a_target_the_audio_format_cannot_hold_is_an_explicit_error(
    processor, work_dir, monkeypatch
):
    monkeypatch.setattr(fitter, "MAX_PCM_BYTES", 100_000)
    with pytest.raises(ProcessingError) as raised:
        fit(processor, work_dir, make_wav(1.0), 4)  # 4 s = 192,000 bytes
    assert raised.value.code == "audio_duration_unsupported"
    assert_nothing_left(work_dir)


def test_a_closed_processor_refuses_work(processor, work_dir):
    processor.close()
    with pytest.raises(ProcessingError) as raised:
        fit(processor, work_dir, make_wav(5.0), 4)
    assert raised.value.code == "audio_cancelled"
    assert_nothing_left(work_dir)


def test_failure_messages_are_safe_for_users(processor, work_dir, tmp_path):
    secret_path = str(tmp_path)
    with pytest.raises(ProcessingError) as raised:
        fit(processor, work_dir, b"not audio", 4)
    assert secret_path not in raised.value.user_message
    assert "ffmpeg" not in raised.value.user_message.lower()


# --- the subprocess runner ------------------------------------------------------------------------


@pytest.fixture
def started_processes(monkeypatch):
    started: list[subprocess.Popen] = []
    real = subprocess.Popen

    def spy(*args, **kwargs):
        process = real(*args, **kwargs)
        started.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", spy)
    return started


SLEEP = [sys.executable, "-c", "import time; time.sleep(60)"]


def test_a_program_that_times_out_is_killed(started_processes):
    began = time.monotonic()
    with pytest.raises(AudioToolTimeout):
        run_tool(SLEEP, timeout=0.5)
    assert time.monotonic() - began < 10
    assert started_processes[0].poll() is not None


def test_cancelling_kills_a_running_program_promptly(started_processes):
    cancel = threading.Event()
    threading.Timer(0.4, cancel.set).start()
    began = time.monotonic()
    with pytest.raises(AudioToolCancelled):
        run_tool(SLEEP, timeout=60, cancel=cancel)
    assert time.monotonic() - began < 10
    assert started_processes[0].poll() is not None


def test_a_failing_program_is_reported_without_its_output(caplog):
    code = "import sys; sys.stderr.write('SECRET-PATH'); sys.exit(3)"
    with caplog.at_level("DEBUG"), pytest.raises(AudioToolError) as raised:
        run_tool([sys.executable, "-c", code], timeout=30)
    assert "SECRET-PATH" not in str(raised.value)
    assert "SECRET-PATH" not in caplog.text


def test_a_program_that_cannot_start_is_an_error(tmp_path):
    with pytest.raises(AudioToolError):
        run_tool([str(tmp_path / "no-such-program")], timeout=5)


def test_the_arguments_are_never_interpreted_by_a_shell(tmp_path):
    marker = tmp_path / "injected"
    code = "import sys; print(sys.argv[1])"
    result = run_tool([sys.executable, "-c", code, f"x; touch {marker}"], timeout=30)
    assert result.stdout.strip() == f"x; touch {marker}"
    assert not marker.exists()


def test_ffmpeg_capabilities_are_checked(audio_tools):
    check_capabilities(audio_tools)
    with pytest.raises(AudioToolError):
        check_capabilities(AudioTools(ffmpeg=sys.executable, ffprobe=audio_tools.ffprobe))
