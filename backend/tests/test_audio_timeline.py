"""Timed dubbing audio: clips placed in their frames with the real FFmpeg (no Azure).

Each block's clip is a tone at its own pitch, with a short silent lead and tail like Azure speech,
so the result can be checked block by block: where each pitch sounds, that it never leaves its
frame, and that nothing is lost, repeated or reordered.
"""

import array
import math
from fractions import Fraction
from itertools import pairwise
from pathlib import Path

import pytest

from app.audio.ffmpeg import AudioTools
from app.audio.fitter import FfmpegAudioProcessor
from app.audio.speed import AudioSpeed, DurationTarget, TimelinePlan
from app.audio.timeline import TEMPO_MARGIN_FRAMES, fit_timeline
from app.processing_errors import ProcessingError
from app.speech.base import TimedSpeechAudio
from tests.audio_helpers import RATE, read_samples, tone_samples, wav_bytes

PITCHES = [300, 420, 540, 660, 780, 900, 1020, 1140]
LEAD = TAIL = int(0.1 * RATE)
LOUD = 2000


def clip(path: Path, seconds: float, pitch: int) -> Path:
    samples = array.array("h", bytes(LEAD * 2))
    samples.extend(tone_samples(seconds, pitch))
    samples.extend(array.array("h", bytes(TAIL * 2)))
    path.write_bytes(wav_bytes(samples))
    return path


def power(samples, start: int, count: int, frequency: int) -> float:
    coefficient = 2 * math.cos(2 * math.pi * frequency / RATE)
    previous = before = 0.0
    for value in samples[start : start + count]:
        previous, before = coefficient * previous - before + value, previous
    return previous * previous + before * before - coefficient * previous * before


def pitch_at(samples, start: int, count: int = 1200) -> int:
    return max(PITCHES, key=lambda f: power(samples, start, count, f))


def loud_spans(samples, boundaries: list[int]) -> list[tuple[int, int] | None]:
    """First and last loud sample inside each frame (None if the frame has no sound)."""
    spans = []
    for start, end in pairwise(boundaries):
        loud = [i for i in range(start, end) if abs(samples[i]) > LOUD]
        spans.append((loud[0], loud[-1]) if loud else None)
    return spans


def place(tools, tmp_path, seconds: list[float], boundaries: list[int], *, grouping=False):
    clips = [clip(tmp_path / f"c{i}.wav", s, PITCHES[i % 8]) for i, s in enumerate(seconds)]
    output = tmp_path / "timeline.wav"
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    report = fit_timeline(tools, clips, boundaries, scratch, output, grouping=grouping)
    return read_samples(output), report


def test_short_clips_keep_their_speed_and_long_ones_fit_their_frame(
    audio_tools: AudioTools, tmp_path: Path
) -> None:
    boundaries = [0, 3 * RATE, 5 * RATE, 9 * RATE]  # frames of 3, 2 and 4 s
    samples, report = place(audio_tools, tmp_path, [1.5, 3.0, 2.0], boundaries)
    assert len(samples) == boundaries[-1]
    short, long, other = report.frames
    assert short.tempo_factor is None and short.fitted_samples == 2 * LEAD + int(1.5 * RATE)
    assert long.tempo_factor is not None and long.tempo_factor > 1.4
    assert other.tempo_factor is None
    spans = loud_spans(samples, boundaries)
    for index, (start, end) in enumerate(spans):
        # Each block sounds at its own pitch, starts right after its boundary and ends inside it.
        assert start - boundaries[index] <= LEAD + RATE // 100
        assert end < boundaries[index + 1]
        assert pitch_at(samples, start + 100) == PITCHES[index]
        assert pitch_at(samples, end - 1300) == PITCHES[index]
    # The short clip is not slowed down: it sounds for its natural length, then silence.
    first_start, first_end = spans[0]
    assert abs((first_end - first_start) - 1.5 * RATE) < RATE // 100
    assert max(map(abs, samples[first_end + 50 : boundaries[1]])) == 0


def test_a_sped_up_clip_aims_short_of_its_frame_and_never_spills(
    audio_tools: AudioTools, tmp_path: Path
) -> None:
    boundaries = [0, 2 * RATE, 4 * RATE]
    samples, report = place(audio_tools, tmp_path, [5.0, 1.0], boundaries)
    first = report.frames[0]
    assert first.fitted_samples <= first.frame_samples
    assert first.padded_samples >= TEMPO_MARGIN_FRAMES - 2048
    _, end = loud_spans(samples, boundaries)[0]
    assert end < boundaries[1]
    assert pitch_at(samples, boundaries[1] + LEAD + 200) == PITCHES[1]


def test_many_fractional_frames_do_not_drift(audio_tools: AudioTools, tmp_path: Path) -> None:
    # 24 blocks at estimated (fractional) starts, 1.75x: every frame starts exactly where the
    # exact plan says, and the last ends exactly at the target.
    ratios = [Fraction(i, 24) + Fraction(1, 7 * (i + 2)) * (i > 0) for i in range(24)]
    plan = TimelinePlan(ratios, DurationTarget(37, AudioSpeed.X1_75))
    boundaries = plan.boundaries(RATE)
    assert boundaries[-1] == DurationTarget(37, AudioSpeed.X1_75).samples(RATE)
    frames = [(b - a) / RATE for a, b in pairwise(boundaries)]
    seconds = [frame * (0.6 if i % 2 else 1.3) for i, frame in enumerate(frames)]
    samples, report = place(audio_tools, tmp_path, seconds, boundaries)
    assert len(samples) == boundaries[-1]
    assert [f.frame_samples for f in report.frames] == [b - a for a, b in pairwise(boundaries)]
    for index, span in enumerate(loud_spans(samples, boundaries)):
        assert span is not None, f"block {index} lost"
        start, end = span
        assert boundaries[index] <= start and end < boundaries[index + 1]
        assert pitch_at(samples, start + 100, 600) == PITCHES[index % 8]


def test_grouping_reads_a_tiny_last_frame_with_the_one_before(
    audio_tools: AudioTools, tmp_path: Path
) -> None:
    # Like the last block that also holds the last caption: 3 s of speech in 0.75 s.
    boundaries = [0, 4 * RATE, 8 * RATE, int(8.75 * RATE)]
    samples, report = place(audio_tools, tmp_path, [3.0, 2.0, 3.0], boundaries, grouping=True)
    assert len(samples) == boundaries[-1]
    assert [(f.first_block, f.last_block) for f in report.frames] == [(0, 0), (1, 2)]
    assert [r.block for r in report.removed] == [2]
    group = report.frames[1]
    assert group.tempo_factor is not None and group.tempo_factor < 2.0  # alone it needed ~4x
    # Both blocks of the group sound in order inside the group's frame; block 0 is untouched.
    start, end = loud_spans(samples, [boundaries[1], boundaries[3]])[0]
    assert pitch_at(samples, start + 100) == PITCHES[1]
    assert pitch_at(samples, end - 1300) == PITCHES[2]
    assert end < boundaries[3]
    removed = report.removed[0]
    assert boundaries[1] < removed.estimated_sample < boundaries[3]


def test_the_processor_fails_without_partial_audio(audio_tools: AudioTools, tmp_path: Path) -> None:
    broken = AudioTools(ffmpeg=str(tmp_path / "missing-ffmpeg"), ffprobe=audio_tools.ffprobe)
    clips = tuple(clip(tmp_path / f"c{i}.wav", 3.0, PITCHES[i]) for i in range(2))
    plan = TimelinePlan([Fraction(0), Fraction(1, 2)], DurationTarget(3, AudioSpeed.X1))
    work = tmp_path / "work"
    work.mkdir()
    with pytest.raises(ProcessingError) as error:
        FfmpegAudioProcessor(broken).fit_timeline(
            TimedSpeechAudio(clips, is_fixture=False, requests=1), plan, work
        )
    assert error.value.code == "audio_processing_failed"
    assert not (work / "final.mp3").exists()


@pytest.mark.parametrize("speed", list(AudioSpeed))
def test_timed_mp3_is_exactly_the_target_at_every_speed(
    audio_tools: AudioTools, tmp_path: Path, speed: AudioSpeed
) -> None:
    clips = tuple(
        clip(tmp_path / f"c{i}.wav", s, PITCHES[i]) for i, s in enumerate([2.2, 1.0, 3.1])
    )
    plan = TimelinePlan(
        [Fraction(0), Fraction(29, 77), Fraction(25, 44)], DurationTarget(11, speed)
    )
    work = tmp_path / "work"
    work.mkdir()
    processed = FfmpegAudioProcessor(audio_tools).fit_timeline(
        TimedSpeechAudio(clips, is_fixture=False, requests=1), plan, work
    )
    report = processed.duration_report
    assert report.target_samples == DurationTarget(11, speed).samples(RATE)
    assert report.mp3_decoded_samples == report.target_samples
    assert abs(report.mp3_header_samples - report.target_samples) <= 1
