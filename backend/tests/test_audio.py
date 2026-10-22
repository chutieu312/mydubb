"""WAV validation/joining and MP3 encoding with the real ffmpeg/ffprobe (synthetic audio)."""

import struct
import subprocess
from pathlib import Path

import pytest

from app.audio.ffmpeg import AudioToolError, AudioTools, encode_mp3, probe_mp3
from app.audio.wav import InvalidAudioError, PcmFormat, concat_wavs, read_wav_info
from tests.audio_helpers import make_wav, wav_samples

FORMAT = PcmFormat(sample_rate=24000, channels=1, sample_width=2)


def write(tmp_path: Path, name: str, data: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def test_read_wav_info_reports_format_and_duration(tmp_path):
    info = read_wav_info(write(tmp_path, "a.wav", make_wav(1.5)))
    assert info.format == FORMAT
    assert info.duration_seconds == pytest.approx(1.5)


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"RIFF",
        b"not audio at all, just text",
        b"RIFF\x00\x00\x00\x00WAVE",  # no chunks
        b"RIFF\x00\x00\x00\x00WAVEdata\x04\x00\x00\x00abcd",  # data before fmt
    ],
)
def test_garbage_is_rejected(tmp_path, data):
    with pytest.raises(InvalidAudioError):
        read_wav_info(write(tmp_path, "bad.wav", data))


def test_a_truncated_download_is_rejected(tmp_path):
    whole = make_wav(1.0)
    with pytest.raises(InvalidAudioError, match="shorter"):
        read_wav_info(write(tmp_path, "cut.wav", whole[: len(whole) // 2]))


def test_empty_audio_is_rejected(tmp_path):
    with pytest.raises(InvalidAudioError, match="empty"):
        read_wav_info(write(tmp_path, "empty.wav", make_wav(0)))


def test_compressed_wav_is_rejected(tmp_path):
    data = bytearray(make_wav(0.1))
    data[20:22] = struct.pack("<H", 3)  # IEEE float format tag
    with pytest.raises(InvalidAudioError, match="PCM"):
        read_wav_info(write(tmp_path, "float.wav", bytes(data)))


def test_unknown_streaming_sizes_use_the_actual_length(tmp_path):
    data = bytearray(make_wav(1.0))
    data[40:44] = struct.pack("<I", 0xFFFFFFFF)  # data size unknown, as a stream writes it
    info = read_wav_info(write(tmp_path, "stream.wav", bytes(data)))
    assert info.duration_seconds == pytest.approx(1.0)


def test_concat_keeps_order_and_every_sample(tmp_path):
    parts = [
        write(tmp_path, f"{i}.wav", make_wav(seconds, frequency))
        for i, (seconds, frequency) in enumerate([(0.5, 300), (1.25, 600), (0.75, 900)])
    ]
    output = tmp_path / "joined.wav"
    duration = concat_wavs(parts, output, FORMAT)
    assert duration == pytest.approx(2.5)
    assert wav_samples(output) == b"".join(wav_samples(part) for part in parts)


def test_concat_refuses_a_chunk_with_another_format(tmp_path):
    good = write(tmp_path, "good.wav", make_wav(0.2))
    other = write(tmp_path, "other.wav", make_wav(0.2, rate=16000))
    with pytest.raises(InvalidAudioError, match="different formats"):
        concat_wavs([good, other], tmp_path / "out.wav", FORMAT)
    with pytest.raises(InvalidAudioError, match="no audio"):
        concat_wavs([], tmp_path / "out.wav", FORMAT)


def test_encoded_mp3_is_valid_seekable_and_has_the_joined_duration(tmp_path, audio_tools):
    wav = write(tmp_path, "speech.wav", make_wav(3.0))
    mp3 = tmp_path / "speech.mp3"
    encode_mp3(audio_tools, wav, mp3, 3.0)

    assert probe_mp3(audio_tools, mp3) == pytest.approx(3.0, abs=0.2)
    head = mp3.read_bytes()[:2048]
    assert b"Info" in head or b"Xing" in head  # VBR/CBR header that lets browsers seek
    # Decodes end to end without a single error.
    result = subprocess.run(  # noqa: S603
        [audio_tools.ffmpeg, "-v", "error", "-i", str(mp3), "-f", "null", "-"],
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0
    assert result.stderr == b""


def test_probe_rejects_files_that_are_not_an_mp3(tmp_path, audio_tools):
    with pytest.raises(AudioToolError):
        probe_mp3(audio_tools, write(tmp_path, "x.mp3", b"definitely not an mp3 file " * 50))
    wav = write(tmp_path, "speech.wav", make_wav(0.5))
    with pytest.raises(AudioToolError):
        probe_mp3(audio_tools, wav)  # valid audio, wrong container/codec


def test_encode_fails_cleanly_on_invalid_input_and_a_missing_program(tmp_path, audio_tools):
    bad = write(tmp_path, "bad.wav", b"not audio")
    with pytest.raises(AudioToolError):
        encode_mp3(audio_tools, bad, tmp_path / "out.mp3", 1.0)
    missing = AudioTools(ffmpeg=str(tmp_path / "no-ffmpeg"), ffprobe=audio_tools.ffprobe)
    with pytest.raises(AudioToolError):
        encode_mp3(missing, bad, tmp_path / "out.mp3", 1.0)
