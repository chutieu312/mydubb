"""Several blocks per Azure Speech request, cut at inserted breaks (fake HTTP, no Azure, no FFmpeg).

The fake voice reads each block with its own pitch, so a clip can be traced back to the block it
came from: mapping errors show up as a wrong pitch, not only as a wrong count.
"""

import array
import math
import xml.etree.ElementTree as ET
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from app.audio.ffmpeg import AudioTools
from app.audio.wav import read_wav_info
from app.processing_errors import ProcessingError
from app.speech import blocks
from app.speech.azure import AzureSpeechProvider
from app.speech.blocks import BREAK_MS, plan_block_requests
from app.speech.rate_limit import RequestRateLimiter
from app.speech.voices import Voice
from app.translation.glossary import default_glossary
from tests.audio_helpers import RATE, read_samples, tone_samples, wav_bytes

NS = "{http://www.w3.org/2001/10/synthesis}"
BLOCKS = [
    "Nhìn chung, nếu ai đó đang cố gắng làm cho một công ty hoạt động, họ nên làm việc vất vả.",
    "Ờ, ngoại trừ việc có một khả năng thất bại khá đáng kể.",
    "Vâng.",
    "Chúng ta dùng Kubernetes và một REST API.",
    "Tỷ lệ lỗi, vốn là 2%, đã giảm xuống còn 0,4%. Tạm biệt",
]
PITCHES = [300, 400, 500, 600, 700, 800, 900, 1000]
CHARS_PER_SECOND = 15


def pieces_of(request: httpx.Request) -> list[str]:
    """The text between consecutive <break/> elements of the request's SSML."""
    voice = ET.fromstring(request.content).find(f"{NS}voice")
    assert voice is not None
    pieces = [""]
    for child in voice:
        if child.tag == f"{NS}break":
            assert child.get("time") == f"{BREAK_MS}ms"
            pieces.append("")
        else:
            pieces[-1] += child.text or ""
    return pieces


def silence(seconds: float, noise: int = 0) -> array.array:
    """Silence; with `noise`, one sample of that amplitude every 50 ms (Azure's breaks hold
    low-level noise rather than digital silence)."""
    samples = array.array("h", bytes(int(seconds * RATE) * 2))
    for index in range(0, len(samples), RATE // 20):
        samples[index] = noise
    return samples


def fake_voice(
    *,
    break_seconds: float = BREAK_MS / 1000,
    pause_seconds: float = 0.4,
    slow_piece: str | None = None,
    mute_piece: str | None = None,
    drop_break: int | None = None,
    break_noise: int = 60,
) -> Callable[[httpx.Request], httpx.Response]:
    """Each piece: words as a tone at the block's pitch, a pause after each comma/full stop."""

    def respond(request: httpx.Request) -> httpx.Response:
        samples = silence(0.05)
        for number, piece in enumerate(pieces_of(request)):
            if number:
                length = 0.0 if number - 1 == drop_break else break_seconds
                samples.extend(silence(length, break_noise))
            pitch = PITCHES[BLOCKS.index(piece)]
            rate = CHARS_PER_SECOND / (4 if piece == slow_piece else 1)
            for part in piece.replace(".", ".|").replace(",", ",|").split("|"):
                if not part.strip():
                    continue
                if piece == mute_piece:
                    samples.extend(silence(len(part) / rate))
                else:
                    samples.extend(tone_samples(len(part) / rate, pitch))
                samples.extend(silence(pause_seconds))
        samples.extend(silence(0.3))
        return httpx.Response(200, content=wav_bytes(samples))

    return respond


def provider_for(handler, *, max_chunk_chars: int = 2000) -> tuple[AzureSpeechProvider, list]:
    calls: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    provider = AzureSpeechProvider(
        key=SecretStr("speech-test-key-0123456789abcdef"),
        region="westus2",
        glossary=default_glossary(),
        tools=AudioTools("ffmpeg", "ffprobe"),  # not used by the block path
        limiter=RequestRateLimiter(1000, 1),
        timeout_seconds=30,
        max_chunk_chars=max_chunk_chars,
        transport=httpx.MockTransport(recording),
    )
    return provider, calls


@pytest.fixture
def work_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "work"
    directory.mkdir()
    return directory


def pitch_of(path: Path) -> int:
    """Which of the block pitches dominates the first sound of the clip (Goertzel power)."""
    samples = read_samples(path)
    start = next(i for i, value in enumerate(samples) if abs(value) > 2000)
    window = samples[start : start + 2400]

    def power(frequency: int) -> float:
        coefficient = 2 * math.cos(2 * math.pi * frequency / RATE)
        previous = before = 0.0
        for value in window:
            previous, before = coefficient * previous - before + value, previous
        return previous * previous + before * before - coefficient * previous * before

    return max(PITCHES, key=power)


def test_one_request_cut_into_one_clip_per_block_in_order(work_dir: Path) -> None:
    provider, calls = provider_for(fake_voice())
    speech = provider.synthesize_blocks(BLOCKS, Voice.ANDREW, work_dir)
    assert len(calls) == 1 and speech.requests == 1
    assert pieces_of(calls[0]) == BLOCKS
    assert len(speech.clips) == len(BLOCKS)
    for index, clip in enumerate(speech.clips):
        # Each clip holds its own block (pitch) and nothing of another one.
        assert pitch_of(clip) == PITCHES[index]
        samples = read_samples(clip)
        # Starts in silence: a cut never falls in sound.
        assert max(map(abs, samples[: RATE // 100])) <= blocks.SILENCE_PEAK


def test_all_sound_is_in_the_clips_once_and_in_order(work_dir: Path, tmp_path: Path) -> None:
    response = tmp_path / "response.wav"

    def keep(request: httpx.Request) -> httpx.Response:
        answer = fake_voice()(request)
        response.write_bytes(answer.content)
        return answer

    provider, _ = provider_for(keep)
    speech = provider.synthesize_blocks(BLOCKS, Voice.EMMA, work_dir)
    joined = array.array("h")
    for clip in speech.clips:
        joined.extend(read_samples(clip))

    def sound(samples: array.array) -> list[int]:
        return [value for value in samples if abs(value) > blocks.SILENCE_PEAK]

    # Only break silence was dropped: every audible sample is kept, once, in order.
    assert sound(joined) == sound(read_samples(response))
    assert len(joined) < len(read_samples(response))


def test_a_clip_keeps_only_a_short_tail_of_the_break(work_dir: Path) -> None:
    provider, _ = provider_for(fake_voice())
    speech = provider.synthesize_blocks(BLOCKS, Voice.ANDREW, work_dir)
    for clip in speech.clips:
        samples = read_samples(clip)
        last_sound = max(i for i, value in enumerate(samples) if abs(value) > 32)
        assert len(samples) - last_sound <= (blocks.TAIL_MS + 10) * RATE // 1000


def test_the_next_clip_keeps_a_short_lead_before_its_sound(work_dir: Path) -> None:
    provider, _ = provider_for(fake_voice())
    speech = provider.synthesize_blocks(BLOCKS, Voice.ANDREW, work_dir)
    for clip in speech.clips[1:]:
        samples = read_samples(clip)
        first_sound = next(i for i, value in enumerate(samples) if abs(value) > 32)
        assert first_sound <= blocks.LEAD_MS * RATE // 1000 + RATE // 100


def test_requests_respect_the_character_limit_and_split_long_blocks(work_dir: Path) -> None:
    long_block = " ".join(["Đây là một câu khá dài, có nhiều từ."] * 12)
    texts = [BLOCKS[0], long_block, BLOCKS[2]]
    requests = plan_block_requests(texts, default_glossary(), max_chars=200)
    assert all(request.chars <= 200 for request in requests)
    assert [piece.block for r in requests for piece in r.pieces].count(1) > 1
    for request in requests:
        owners = [piece.block for piece in request.pieces]
        assert len(owners) == len(set(owners))  # a break always separates two blocks
    joined = {i: "" for i in range(3)}
    for request in requests:
        for piece in request.pieces:
            joined[piece.block] += (" " if joined[piece.block] else "") + piece.text
    assert [joined[i] for i in range(3)] == texts


def test_break_noise_below_the_silence_level_is_still_a_break(work_dir: Path) -> None:
    provider, _ = provider_for(fake_voice(break_noise=blocks.SILENCE_PEAK))
    speech = provider.synthesize_blocks(BLOCKS, Voice.ANDREW, work_dir)
    assert [pitch_of(clip) for clip in speech.clips] == PITCHES[: len(BLOCKS)]


def test_block_without_speakable_text_gets_a_silent_clip(work_dir: Path) -> None:
    provider, calls = provider_for(fake_voice())
    speech = provider.synthesize_blocks([BLOCKS[0], "…", BLOCKS[1]], Voice.ANDREW, work_dir)
    assert pieces_of(calls[0]) == [BLOCKS[0], BLOCKS[1]]
    assert read_wav_info(speech.clips[1]).frames == 1


def test_english_terms_keep_their_language_span_inside_a_block(work_dir: Path) -> None:
    provider, calls = provider_for(fake_voice())
    provider.synthesize_blocks(BLOCKS, Voice.ANDREW, work_dir)
    english = [
        element.text
        for element in ET.fromstring(calls[0].content).iter(f"{NS}lang")
        if element.get("{http://www.w3.org/XML/1998/namespace}lang") == "en-US"
    ]
    assert "Kubernetes" in english and "REST API" in english


@pytest.mark.parametrize(
    ("voice", "reason"),
    [
        (fake_voice(break_seconds=0.5), "break_count"),  # breaks look like natural pauses
        (fake_voice(break_seconds=1.8), "ambiguous_silence"),  # neither a pause nor a break
        (fake_voice(pause_seconds=1.5), "ambiguous_silence"),  # a natural pause too long
        (fake_voice(pause_seconds=2.6), "ambiguous_silence"),  # between pause and break
        (fake_voice(pause_seconds=3.4), "ambiguous_silence"),  # pauses as long as breaks
        (fake_voice(drop_break=1), "break_count"),
        (fake_voice(slow_piece=BLOCKS[1]), "inconsistent_rate"),
        (fake_voice(mute_piece=BLOCKS[3]), "ambiguous_silence"),  # silent block: break too long
        (fake_voice(break_noise=150), "break_count"),  # noise above the silence level
    ],
)
def test_a_failed_check_fails_the_job_without_retry(
    work_dir: Path, caplog: pytest.LogCaptureFixture, voice, reason: str
) -> None:
    provider, calls = provider_for(voice)
    with pytest.raises(ProcessingError) as error:
        provider.synthesize_blocks(BLOCKS, Voice.ANDREW, work_dir)
    assert error.value.code == "speech_block_split_failed"
    assert len(calls) == 1  # never retried or synthesized another way
    assert reason in caplog.text
    assert list(work_dir.iterdir()) == []  # no clip left behind


# --- The rate check against a voice that reads syllables ------------------------------------
#
# Vietnamese speech takes time per syllable. The fake voice below reads every token with its REAL
# reading, written by hand here (independent of the estimate in app/speech/spoken_length.py), so
# the tests show whether the estimate is close enough on numbers, acronyms and English terms.

SYLLABLE_SECONDS = 0.22
READINGS = {
    "2%": "hai phần trăm",
    "0,4%": "không phẩy bốn phần trăm",
    "12,5%": "mười hai phẩy năm phần trăm",
    "99,9%": "chín mươi chín phẩy chín phần trăm",
    "0,01%": "không phẩy không một phần trăm",
    "100.000": "một trăm nghìn",
    "10.000": "mười nghìn",
    "20.000": "hai mươi nghìn",
    "50.000": "năm mươi nghìn",
    "1.024": "một nghìn không trăm hai mươi tư",
    "3.11": "ba chấm mười một",
    "3.12": "ba chấm mười hai",
    "3.13": "ba chấm mười ba",
    "2026": "hai nghìn không trăm hai mươi sáu",
    "API": "ây pi ai",
    "CPU": "xi pi iu",
    "GPU": "gi pi iu",
    "JSON": "jây sơn",
    "HTTP": "ếch ti ti pi",
    "SQL": "ét kiu eo",
    "REST": "rét",
    "Kubernetes": "ku bơ nê tít",
    "Python": "pai thon",
    "request": "ri quét",
    "OK": "ô kê",
}


def reading_syllables(text: str) -> int:
    count = 0
    for token in text.split():
        core = token.strip(".,;:!?\"'()")
        if core:
            count += len(READINGS.get(core, "x").split())
    return count


def syllable_voice(
    blocks_text: list[str],
    *,
    slow_block: int | None = None,
    drop_break: int | None = None,
    long_pause: tuple[int, float, float] | None = None,
) -> Callable[[httpx.Request], httpx.Response]:
    """Reads each block at SYLLABLE_SECONDS per real syllable, at the block's own pitch.

    `long_pause=(block, fraction, seconds)` inserts a natural pause of `seconds` after that
    fraction of the block's words; `drop_break=k` replaces the break after the k-th piece by an
    ordinary sentence pause.
    """

    def respond(request: httpx.Request) -> httpx.Response:
        samples = silence(0.05)
        for number, piece in enumerate(pieces_of(request)):
            if number:
                gap = 0.4 if number - 1 == drop_break else BREAK_MS / 1000
                samples.extend(silence(gap, 60))
            block = blocks_text.index(piece)
            pitch = PITCHES[block % len(PITCHES)]
            words = piece.split()
            pause_at = None
            if long_pause and long_pause[0] == block:
                pause_at = max(1, round(len(words) * long_pause[1]))
            slow = 3 if block == slow_block else 1
            for index, word in enumerate(words):
                if index == pause_at:
                    samples.extend(silence(long_pause[2], 60))
                seconds = reading_syllables(word) * SYLLABLE_SECONDS * slow
                samples.extend(tone_samples(seconds, pitch))
                if word[-1] in ".,;:?!":
                    samples.extend(silence(0.3))
        samples.extend(silence(0.3))
        return httpx.Response(200, content=wav_bytes(samples))

    return respond


ORDINARY = [
    "Nhìn chung, nếu ai đó đang cố gắng làm cho một công ty hoạt động, họ nên làm việc vất vả.",
    "Ờ, ngoại trừ việc có một khả năng thất bại khá đáng kể.",
    "Chúng ta dùng Kubernetes và một REST API.",
]


@pytest.mark.parametrize(
    "text",
    [
        "Tỷ lệ lỗi, vốn là 2%, đã giảm xuống còn 0,4%.",  # numbers inside a sentence
        "Chúng ta gọi API qua HTTP rồi lưu vào SQL.",  # acronyms inside a sentence
        "12,5%, 99,9%, 0,01% và 100.000.",  # almost only numbers
        "API, CPU, GPU, JSON, HTTP và SQL.",  # a list of spelled acronyms
        "10.000, 20.000, 50.000 và 100.000 request.",  # round numbers read short
        "Python 3.11, 3.12 và 3.13 ra mắt năm 2026.",  # versions and a year
        "1.024 request, 2% lỗi, OK.",
    ],
)
def test_numbers_and_acronyms_are_not_rejected(work_dir: Path, text: str) -> None:
    texts = [*ORDINARY, text]
    provider, _ = provider_for(syllable_voice(texts))
    speech = provider.synthesize_blocks(texts, Voice.ANDREW, work_dir)
    assert [pitch_of(clip) for clip in speech.clips] == PITCHES[: len(texts)]


@pytest.mark.parametrize("short", ["2%.", "OK.", "GPU.", "Vâng.", "Tốt.", "0,4%!"])
def test_short_blocks_are_not_rate_checked(work_dir: Path, short: str) -> None:
    # Under MIN_SYLLABLES_FOR_RATE syllables a rate says little; such blocks are still checked
    # for sound and for their break, like every block.
    texts = [ORDINARY[0], short, ORDINARY[1], short.rstrip("!.") + "?", ORDINARY[2]]
    provider, _ = provider_for(syllable_voice(texts))
    speech = provider.synthesize_blocks(texts, Voice.EMMA, work_dir)
    assert [pitch_of(clip) for clip in speech.clips] == PITCHES[: len(texts)]


@pytest.mark.parametrize("text", [ORDINARY[1], "Số liệu: 12,5%, 99,9%, 0,01% và 100.000."])
def test_a_block_read_three_times_too_long_is_still_rejected(
    work_dir: Path, caplog: pytest.LogCaptureFixture, text: str
) -> None:
    # As if a neighbouring sentence had ended up in this clip: the estimate must not be so loose
    # that a wrong mapping passes, also for a block of numbers.
    texts = [*ORDINARY, text] if text not in ORDINARY else [*ORDINARY, "Vâng, đúng như vậy."]
    slow = texts.index(text)
    provider, calls = provider_for(syllable_voice(texts, slow_block=slow))
    with pytest.raises(ProcessingError) as error:
        provider.synthesize_blocks(texts, Voice.ANDREW, work_dir)
    assert error.value.code == "speech_block_split_failed"
    assert "inconsistent_rate" in caplog.text and len(calls) == 1


# --- A missing break replaced by a natural pause (the count stays right) ----------------------

FOUR = [
    "Nhìn chung, nếu ai đó đang cố gắng làm cho một công ty hoạt động thật sự hiệu quả và bền "
    "vững, họ nên chuẩn bị tinh thần để làm việc cực kỳ vất vả trong nhiều năm liền.",
    "Ờ, ngoại trừ việc có một khả năng thất bại khá đáng kể.",
    "Chúng ta dùng Kubernetes và một REST API cho toàn bộ hệ thống.",
    "Cảm ơn các bạn đã theo dõi, hẹn gặp lại lần sau nhé.",
]


def test_a_natural_pause_outside_the_break_band_is_rejected(
    work_dir: Path, caplog: pytest.LogCaptureFixture
) -> None:
    voice = syllable_voice(FOUR, drop_break=1, long_pause=(0, 0.5, 2.5))
    provider, _ = provider_for(voice)
    with pytest.raises(ProcessingError):
        provider.synthesize_blocks(FOUR, Voice.ANDREW, work_dir)
    assert "ambiguous_silence" in caplog.text


def test_a_break_length_pause_far_from_the_missing_break_is_rejected(
    work_dir: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # A pause as long as a break in the middle of block 0, the break after block 1 missing: half
    # of block 0 would be read as block 0, its other half as block 1, blocks 1 and 2 as block 2.
    voice = syllable_voice(FOUR, drop_break=1, long_pause=(0, 0.5, 3.4))
    provider, _ = provider_for(voice)
    with pytest.raises(ProcessingError):
        provider.synthesize_blocks(FOUR, Voice.ANDREW, work_dir)
    # Each clip's own rate stays inside 0.5-2x here (2.0, 0.7, 0.6): the cumulative check finds it.
    assert "inconsistent_timing" in caplog.text


def test_known_limit_a_break_length_pause_next_to_the_missing_break_is_accepted(
    work_dir: Path, tmp_path: Path
) -> None:
    """KNOWN LIMIT, kept visible: the break after block 1 is missing and block 1 has a natural
    pause as long as a break just before its last words. Count, band and rates all look right,
    so the last words of block 1 are mapped to block 2's frame. Nothing is lost or reordered (all
    sound is in the clips, in order); here the misplaced part is the last words of block 1, but
    that size is what this case shows, not a bound.
    It needs two faults at once that were never observed (no break was ever missing; natural
    pauses measured at most 820 ms)."""
    response = tmp_path / "response.wav"
    inner = syllable_voice(FOUR, drop_break=1, long_pause=(1, 0.85, 3.4))

    def keep(request: httpx.Request) -> httpx.Response:
        answer = inner(request)
        response.write_bytes(answer.content)
        return answer

    provider, _ = provider_for(keep)
    speech = provider.synthesize_blocks(FOUR, Voice.ANDREW, work_dir)
    assert len(speech.clips) == 4
    # Clip 2 (block 2's frame) starts with block 1's pitch: the misplaced words.
    assert pitch_of(speech.clips[2]) == PITCHES[1]
    joined = array.array("h")
    for clip in speech.clips:
        joined.extend(read_samples(clip))
    loud = [v for v in joined if abs(v) > blocks.SILENCE_PEAK]
    assert loud == [v for v in read_samples(response) if abs(v) > blocks.SILENCE_PEAK]
