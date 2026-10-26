"""Long silences are written in bounded blocks (no allocation of the whole silence), and the mock
audio processor never passes real per-block clips through as if they were the final MP3."""

import wave
from pathlib import Path

import pytest

from app.audio import timeline
from app.audio.mock import MockAudioProcessor
from app.audio.speed import AudioSpeed, DurationTarget, TimelinePlan
from app.audio.wav import (
    SILENCE_BLOCK_BYTES,
    PcmFormat,
    read_wav_info,
    write_silence,
    write_silent_frames,
)
from app.processing_errors import ProcessingError
from app.speech.base import TimedSpeechAudio
from tests.audio_helpers import RATE, make_wav, read_samples

PCM = PcmFormat(sample_rate=RATE, channels=1, sample_width=2)
THREE_HOURS = 3 * 3600 * RATE  # a valid baseline: 259,200,000 samples, about 494 MiB of PCM


class CountingWriter:
    """Stands in for wave.Wave_write: records the size of each write, keeps no data."""

    def __init__(self) -> None:
        self.sizes: list[int] = []

    def writeframes(self, data: bytes | memoryview) -> None:
        self.sizes.append(len(data))

    # Enough of wave.Wave_write for `_join`.
    def setnchannels(self, _: int) -> None: ...
    def setsampwidth(self, _: int) -> None: ...
    def setframerate(self, _: int) -> None: ...
    def __enter__(self) -> "CountingWriter":
        return self

    def __exit__(self, *_: object) -> None: ...


def test_three_hours_of_silence_are_written_in_bounded_blocks() -> None:
    writer = CountingWriter()
    write_silent_frames(writer, THREE_HOURS, PCM.frame_bytes)
    assert sum(writer.sizes) == THREE_HOURS * PCM.frame_bytes
    assert max(writer.sizes) <= SILENCE_BLOCK_BYTES
    assert all(size % PCM.frame_bytes == 0 for size in writer.sizes)  # whole frames only


@pytest.mark.parametrize("frame_bytes", [1, 2, 3, 4, 6])
def test_blocks_hold_whole_frames_for_any_frame_size(frame_bytes: int) -> None:
    writer = CountingWriter()
    frames = SILENCE_BLOCK_BYTES // frame_bytes * 2 + 7
    write_silent_frames(writer, frames, frame_bytes)
    assert sum(writer.sizes) == frames * frame_bytes
    assert all(0 < size <= SILENCE_BLOCK_BYTES and size % frame_bytes == 0 for size in writer.sizes)


def test_no_silence_writes_nothing_and_bad_sizes_are_refused() -> None:
    writer = CountingWriter()
    write_silent_frames(writer, 0, 2)
    assert writer.sizes == []
    with pytest.raises(ValueError):
        write_silent_frames(writer, -1, 2)
    with pytest.raises(ValueError):
        write_silent_frames(writer, 10, 0)


def test_joining_a_three_hour_frame_never_writes_one_huge_block(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The timeline step of a 3-hour baseline whose speech is short: almost all of the frame is
    # silence. The writer only counts bytes, so nothing of that size is allocated or written.
    clip = tmp_path / "clip.wav"
    clip.write_bytes(make_wav(1.0))
    info = read_wav_info(clip)
    frame = timeline._Frame(0, 0, THREE_HOURS, clip, info, fitted=clip, fitted_frames=info.frames)
    writer = CountingWriter()
    monkeypatch.setattr(timeline.wave, "open", lambda *_args, **_kwargs: writer)
    timeline._join([frame], PCM, tmp_path / "unused.wav")
    assert sum(writer.sizes) == THREE_HOURS * PCM.frame_bytes
    assert max(writer.sizes) <= SILENCE_BLOCK_BYTES


def test_a_real_timeline_pads_a_long_frame_exactly_in_bounded_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Short clips in 60 s frames need no tempo change, so no FFmpeg either.
    clips = []
    for index in range(2):
        clips.append(tmp_path / f"clip-{index}.wav")
        clips[-1].write_bytes(make_wav(0.5, 440 + 220 * index))
    sizes: list[int] = []
    original = wave.Wave_write.writeframes

    def recording(self: wave.Wave_write, data: bytes) -> None:
        sizes.append(len(data))
        original(self, data)

    monkeypatch.setattr(wave.Wave_write, "writeframes", recording)
    boundaries = [0, 60 * RATE, 120 * RATE]
    output = tmp_path / "timeline.wav"
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    timeline.fit_timeline(None, clips, boundaries, scratch, output, grouping=False)  # type: ignore[arg-type]
    assert max(sizes) <= SILENCE_BLOCK_BYTES
    samples = read_samples(output)
    assert len(samples) == 120 * RATE
    # Each clip at its own boundary, then exact silence to the end of its frame.
    assert any(samples[: RATE // 2]) and not any(samples[RATE // 2 + 10 : 60 * RATE])
    assert any(samples[60 * RATE : 60 * RATE + RATE // 2]) and not any(samples[-RATE:])


def test_write_silence_writes_exactly_the_frames_asked(tmp_path: Path) -> None:
    output = tmp_path / "silence.wav"
    write_silence(output, PCM, SILENCE_BLOCK_BYTES // 2 * 3 + 1)
    assert read_wav_info(output).frames == SILENCE_BLOCK_BYTES // 2 * 3 + 1
    assert not any(read_samples(output))


def test_mock_audio_refuses_real_clips_instead_of_returning_part_of_the_speech(
    tmp_path: Path,
) -> None:
    clips = []
    for index in range(3):
        clips.append(tmp_path / f"block-{index}.wav")
        clips[-1].write_bytes(make_wav(1.0))
    plan = TimelinePlan([0, 1 / 3, 2 / 3], DurationTarget(9, AudioSpeed.X1))
    speech = TimedSpeechAudio(tuple(clips), is_fixture=False, requests=1)
    with pytest.raises(ProcessingError) as error:
        MockAudioProcessor().fit_timeline(speech, plan, tmp_path)
    assert error.value.code == "audio_timeline_unsupported"
    assert not (tmp_path / "final.mp3").exists()
